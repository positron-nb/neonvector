import { INPUT, STORAGE_KEYS } from '../config/settings.js';

export const LinkState = { ONLINE: 'online', WEAK: 'weak', OFFLINE: 'offline' };

// Consumes raw MPU packets (roll/pitch/motion) and turns them into calibrated,
// smoothed, dead-zoned steering/throttle/brake/nitro values.
//
// Packet gaps are handled in stages so Wi-Fi jitter never reads as a
// disconnect: short gaps hold the last input, medium gaps ease it to neutral
// ("SIGNAL WEAK"), and only a long silence flips the link to OFFLINE.
export class MPUController {
  constructor(settingsOverride = {}) {
    this.cfg = { ...INPUT.mpu, ...settingsOverride };

    this.rawRoll = 0;
    this.rawPitch = 0;
    this.rawMotion = 0;
    this.rawGz = 0;

    this.smoothRoll = 0;
    this.smoothPitch = 0;
    this._primed = false;

    this.baselineRoll = 0;
    this.baselinePitch = 0;
    this.hasCalibration = false;
    this._loadCalibration();

    this.calibrating = false;
    this.calibrationSamples = [];
    this.calibrationTargetSamples = 45; // ~1.5s at ~30hz

    this.lastPacketTime = 0;
    this.connected = false;

    this.lastShakeTime = -9999;
    this.nitroPulse = false;

    this.sensitivity = this.cfg.sensitivity;

    this._packetTimestamps = [];
  }

  _loadCalibration() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.calibration) || 'null');
      if (stored && Number.isFinite(stored.roll) && Number.isFinite(stored.pitch)) {
        this.baselineRoll = stored.roll;
        this.baselinePitch = stored.pitch;
        this.hasCalibration = true;
      }
    } catch (e) { /* storage unavailable or corrupt — start uncalibrated */ }
  }

  _saveCalibration() {
    try {
      localStorage.setItem(STORAGE_KEYS.calibration, JSON.stringify({ roll: this.baselineRoll, pitch: this.baselinePitch }));
    } catch (e) { /* ignore */ }
  }

  setSensitivity(v) {
    this.sensitivity = v;
  }

  startCalibration() {
    this.calibrating = true;
    this.calibrationSamples = [];
  }

  isCalibrating() {
    return this.calibrating;
  }

  getCalibrationProgress() {
    return Math.min(1, this.calibrationSamples.length / this.calibrationTargetSamples);
  }

  onPacket(packet) {
    if (!packet || typeof packet.roll !== 'number' || typeof packet.pitch !== 'number') return;
    if (!Number.isFinite(packet.roll) || !Number.isFinite(packet.pitch)) return;
    if (packet.ok === 0) return; // firmware reports a sensor fault; keep last good values

    const now = performance.now();
    this.lastPacketTime = now;
    this.connected = true;

    this._packetTimestamps.push(now);
    if (this._packetTimestamps.length > 30) this._packetTimestamps.shift();

    this.rawRoll = clamp(packet.roll, -90, 90);
    this.rawPitch = clamp(packet.pitch, -90, 90);
    this.rawMotion = Number.isFinite(packet.motion) ? packet.motion : 0;
    this.rawGz = Number.isFinite(packet.gz) ? packet.gz : 0;

    if (!this._primed) {
      // First packet after (re)connect: snap the filter instead of sweeping
      // from stale values, which would jerk the steering.
      this.smoothRoll = this.rawRoll;
      this.smoothPitch = this.rawPitch;
      this._primed = true;
    }

    if (this.calibrating) {
      this.calibrationSamples.push({ roll: this.rawRoll, pitch: this.rawPitch });
      if (this.calibrationSamples.length >= this.calibrationTargetSamples) {
        const n = this.calibrationSamples.length;
        const sum = this.calibrationSamples.reduce((a, s) => ({ roll: a.roll + s.roll, pitch: a.pitch + s.pitch }), { roll: 0, pitch: 0 });
        this.baselineRoll = sum.roll / n;
        this.baselinePitch = sum.pitch / n;
        this.hasCalibration = true;
        this.calibrating = false;
        this._saveCalibration();
      }
    }

    if (this.rawMotion > this.cfg.shakeMotionThreshold && now - this.lastShakeTime > this.cfg.shakeCooldownMs) {
      this.lastShakeTime = now;
      this.nitroPulse = true;
    }
  }

  getPacketRateHz() {
    if (!this.connected || this._packetTimestamps.length < 2) return 0;
    const span = (this._packetTimestamps[this._packetTimestamps.length - 1] - this._packetTimestamps[0]) / 1000;
    if (span <= 0) return 0;
    return (this._packetTimestamps.length - 1) / span;
  }

  msSinceLastPacket() {
    return this.lastPacketTime ? performance.now() - this.lastPacketTime : Infinity;
  }

  getLinkState() {
    if (!this.connected) return LinkState.OFFLINE;
    return this.msSinceLastPacket() > this.cfg.staleAfterMs ? LinkState.WEAK : LinkState.ONLINE;
  }

  update(dt) {
    if (this.connected && this.msSinceLastPacket() > this.cfg.packetTimeoutMs) {
      this.connected = false;
      this._primed = false;
      this.calibrating = false;
      this._packetTimestamps.length = 0;
    }

    // Frame-rate independent exponential smoothing (cfg.smoothing is the
    // per-frame factor at 60 fps).
    const k = 1 - Math.pow(1 - this.cfg.smoothing, dt * 60);
    this.smoothRoll += (this.rawRoll - this.smoothRoll) * k;
    this.smoothPitch += (this.rawPitch - this.smoothPitch) * k;
  }

  consumeNitroPulse() {
    if (this.nitroPulse) {
      this.nitroPulse = false;
      return true;
    }
    return false;
  }

  setInvert({ steer, pitch }) {
    this.cfg.steerSign = steer ? -1 : 1;
    this.cfg.pitchSign = pitch ? -1 : 1;
  }

  // Calibrated angles + resulting control values, without consuming the
  // one-shot nitro pulse (used by the live preview widgets).
  peek() {
    const c = this._compute(false);
    return {
      ...c,
      roll: this.smoothRoll - this.baselineRoll,
      pitch: this.smoothPitch - this.baselinePitch,
      online: this.connected
    };
  }

  getControls() {
    return this._compute(true);
  }

  _compute(consumeNitro) {
    if (!this.connected) {
      return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitroRequested: false, connected: false };
    }

    // Hold the last input through short gaps, then ease to neutral so the car
    // never keeps turning on a frozen reading.
    const gap = this.msSinceLastPacket();
    const holdFactor = gap <= this.cfg.staleAfterMs
      ? 1
      : clamp(1 - (gap - this.cfg.staleAfterMs) / this.cfg.staleFadeMs, 0, 1);

    const relRoll = this.smoothRoll - this.baselineRoll;
    const relPitch = this.smoothPitch - this.baselinePitch;

    let steer = 0;
    if (Math.abs(relRoll) > this.cfg.deadZoneDeg) {
      const mag = (Math.abs(relRoll) - this.cfg.deadZoneDeg) / (this.cfg.maxTiltDeg - this.cfg.deadZoneDeg);
      steer = Math.sign(relRoll) * clamp(mag, 0, 1) * this.sensitivity * this.cfg.steerSign;
    }
    // Twisting the controller (yaw rate) adds a little fine steering.
    steer += clamp(this.rawGz / 180, -1, 1) * this.cfg.twistSteer * this.cfg.steerSign;
    steer = clamp(steer, -1, 1) * holdFactor;

    const pitch = relPitch * this.cfg.pitchSign;
    let throttle = 0;
    let brake = 0;
    const span = this.cfg.throttleTiltDeg - this.cfg.deadZoneDeg;
    if (pitch < -this.cfg.deadZoneDeg) {
      throttle = clamp((Math.abs(pitch) - this.cfg.deadZoneDeg) / span, 0, 1);
    } else if (pitch > this.cfg.deadZoneDeg) {
      brake = clamp((Math.abs(pitch) - this.cfg.deadZoneDeg) / span, 0, 1);
    }

    return {
      throttle: throttle * holdFactor,
      brake: brake * holdFactor,
      steer,
      handbrake: false,
      nitroRequested: consumeNitro ? this.consumeNitroPulse() : this.nitroPulse,
      connected: true
    };
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
