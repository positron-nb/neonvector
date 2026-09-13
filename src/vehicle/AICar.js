import * as THREE from 'three';
import { buildCarMesh } from './CarMesh.js';
import { VehicleState, stepVehicle, constrainToTrack } from './Physics.js';
import { PHYSICS, COLORS } from '../config/settings.js';

// Driver personalities. cornerGrip = how much curvature they carry speed
// through (higher = braver); wobble = steering noise; speedScale = straight-line pace.
const PROFILES = {
  aggressive: { name: 'RIVAL 01', body: 0x5a1a4c, accent: COLORS.magenta, lookahead: 13, steerGain: 2.5, cornerGrip: 1.15, speedScale: 1.0, nitroUse: 0.8, wobble: 0.0, bump: true },
  balanced: { name: 'RIVAL 02', body: 0x33206a, accent: COLORS.violet, lookahead: 15, steerGain: 2.2, cornerGrip: 1.0, speedScale: 0.985, nitroUse: 0.5, wobble: 0.0, bump: false },
  unstable: { name: 'RIVAL 03', body: 0x5a300e, accent: COLORS.orange, lookahead: 17, steerGain: 2.9, cornerGrip: 1.08, speedScale: 1.035, nitroUse: 0.7, wobble: 0.14, bump: false }
};

export class AICar {
  constructor(scene, track, fx, startPosition, startHeading, profileName = 'balanced') {
    this.track = track;
    this.fx = fx;
    this.profile = PROFILES[profileName] || PROFILES.balanced;
    this.name = this.profile.name;
    this.parts = buildCarMesh({ bodyColor: this.profile.body, accentColor: this.profile.accent, headlights: false });
    this.object3D = this.parts.root;
    scene.add(this.object3D);

    this.state = new VehicleState(startPosition);
    this.state.heading = startHeading;
    this.nitro = 1;
    this.nitroActive = false;
    this.laneOffset = 0;
    this.laneTarget = 0;
    this._seed = Math.random() * 100;
    this._pitch = 0;
    this._throttle = 0;
    this._syncTransform();
  }

  get trackT() {
    return this.state.trackT ?? this.track.closestPoint(this.state.position).t;
  }

  reset(position, heading) {
    this.state = new VehicleState(position);
    this.state.heading = heading;
    this.nitro = 1;
    this.nitroActive = false;
    this.laneOffset = 0;
    this._syncTransform();
  }

  _syncTransform() {
    this.object3D.position.copy(this.state.position);
    this.object3D.rotation.y = this.state.heading;
  }

  // rubberBand > 1 speeds the car up (it's behind the player), < 1 slows it.
  update(dt, others, elapsed, raceActive = true, rubberBand = 1) {
    if (!raceActive) {
      this._syncTransform();
      this._animate(dt, 0, elapsed);
      return;
    }
    const p = this.profile;
    const t = this.trackT;
    const speed = Math.abs(this.state.speed);

    // --- Racing line: weave between lanes, pick a side to overtake. ---
    const half = this.track.width / 2 - 2;
    this.laneTarget = Math.sin(elapsed * 0.13 + this._seed) * half * 0.55;
    const fwd = new THREE.Vector3(Math.sin(this.state.heading), 0, Math.cos(this.state.heading));
    const left = new THREE.Vector3(fwd.z, 0, -fwd.x);
    let blocked = false;
    for (const o of others) {
      if (o === this) continue;
      const rel = new THREE.Vector3().subVectors(o.state.position, this.state.position);
      const ahead = rel.dot(fwd);
      const side = rel.dot(left);
      if (ahead > 0 && ahead < 16 && Math.abs(side) < 3.4) {
        blocked = true;
        // Go round on whichever side has more room.
        this.laneTarget = THREE.MathUtils.clamp(this.laneOffset + (side > 0 ? -5 : 5), -half, half);
        if (p.bump && ahead < 6 && o.state.speed < this.state.speed) this.laneTarget = this.laneOffset; // aggressive: don't yield
      }
    }
    this.laneOffset += (this.laneTarget - this.laneOffset) * Math.min(1, dt * 1.2);

    // --- Steering toward a lookahead point on the chosen line. ---
    const look = p.lookahead + speed * 0.35;
    const lt = t + look / this.track.length;
    const target = this.track.getPointAt(lt).addScaledVector(this.track.getNormalAt(lt), this.laneOffset);
    const toTarget = target.sub(this.state.position);
    let diff = Math.atan2(toTarget.x, toTarget.z) - this.state.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    let steer = THREE.MathUtils.clamp(diff * p.steerGain, -1, 1);
    steer += Math.sin(elapsed * 3.1 + this._seed) * p.wobble;

    // --- Corner speed: brake for the curvature coming up. ---
    const turn = Math.max(this.track.turnAhead(t, 30 + speed * 0.6), this.track.turnAhead(t + 20 / this.track.length, 40));
    const cornerSpeed = THREE.MathUtils.lerp(PHYSICS.maxSpeed * 1.05, 20, THREE.MathUtils.clamp(turn / 55, 0, 1)) * p.cornerGrip * rubberBand;
    let throttle = 1, brake = 0;
    if (speed > cornerSpeed + 3) { throttle = 0; brake = THREE.MathUtils.clamp((speed - cornerSpeed) / 12, 0.2, 1); }
    else if (speed > cornerSpeed) throttle = 0.3;
    if (blocked && !p.bump) throttle *= 0.85;

    // --- Nitro on straights. ---
    if (!this.nitroActive && turn < 8 && this.nitro > 0.5 && Math.random() < p.nitroUse * dt * 0.6) this.nitroActive = true;
    if (this.nitroActive && (turn > 16 || this.nitro <= 0)) this.nitroActive = false;
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - PHYSICS.nitroDrainPerSec * dt);
    else this.nitro = Math.min(1, this.nitro + PHYSICS.nitroRechargePerSec * 0.85 * dt);

    const handbrake = p.wobble > 0 && turn > 30 && speed > 30 && Math.sin(elapsed * 0.7 + this._seed) > 0.6;

    stepVehicle(this.state, {
      throttle, brake, steer: THREE.MathUtils.clamp(steer, -1, 1), handbrake,
      nitroActive: this.nitroActive, maxSpeedScale: p.speedScale * rubberBand
    }, dt);
    constrainToTrack(this.state, this.track, dt);
    this._throttle = throttle;
    this._syncTransform();
    this._animate(dt, brake, elapsed);
  }

  _animate(dt, brake, elapsed) {
    const parts = this.parts;
    const s = this.state;
    const target = THREE.MathUtils.clamp(-s.longAccel / 40, -1, 1) * 0.035;
    this._pitch += (target - this._pitch) * (1 - Math.exp(-8 * dt));
    parts.chassis.rotation.x = this._pitch;
    parts.wheels.forEach((w) => { w.rotation.x = s.wheelSpin; });
    parts.steerPivots.forEach((pv) => { pv.rotation.y = s.steerAngle; });
    parts.tailMat.color.setHex(0xff1a2e).multiplyScalar(brake > 0.1 ? 6 : 2);
    parts.underMat.color.copy(parts.accent).multiplyScalar(this.nitroActive ? 0.3 : 0.14);
    parts.flames.forEach((f) => {
      const on = this.nitroActive ? 1 : 0;
      f.scale.set(on ? 1 : 0.001, on ? 1 : 0.001, on ? 1 + Math.random() * 0.4 : 0.001);
      f.material.uniforms.uIntensity.value = on * (0.9 + Math.random() * 0.4) * 1.5;
      f.material.uniforms.uTime.value = elapsed;
    });
    this.fx.emitExhaust(this, dt, this._throttle, this.nitroActive);
    if (s.isDrifting) this.fx.emitSmoke(this, dt, 0.6);
  }

  get speedKmh() {
    return Math.abs(this.state.speed) * 3.6;
  }
}
