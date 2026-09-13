// Fully procedural Web Audio sound design — no external sound files, so audio
// can never break because a URL disappeared. Everything is synthesised from
// oscillators and generated noise.
export class AudioManager {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  _ensureContext() {
    if (this.ctx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx();
    } catch (e) {
      return false;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.55 : 0;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this._noise = this._makeNoise(2);
    this._buildEngine();
    this._buildLoops();
    return true;
  }

  // Browsers require a user gesture before audio can start.
  unlock() {
    if (!this._ensureContext()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }

  _makeNoise(seconds) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _buildEngine() {
    const ctx = this.ctx;
    this.engine = { gain: ctx.createGain(), filter: ctx.createBiquadFilter(), oscs: [] };
    this.engine.filter.type = 'lowpass';
    this.engine.filter.frequency.value = 500;
    this.engine.filter.Q.value = 3;
    this.engine.gain.gain.value = 0;
    [['sawtooth', 1, 0.5], ['square', 0.5, 0.25], ['sawtooth', 1.005, 0.35], ['sine', 0.25, 0.6]].forEach(([type, mult, vol]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 50 * mult;
      const g = ctx.createGain();
      g.gain.value = vol;
      o.connect(g).connect(this.engine.filter);
      o.start();
      this.engine.oscs.push({ o, mult });
    });
    this.engine.filter.connect(this.engine.gain).connect(this.master);
  }

  // Looping noise beds whose volume is driven every frame (skid, scrape, wind).
  _buildLoops() {
    const loop = (freq, q, type = 'bandpass') => {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { g, f };
    };
    this.skid = loop(1800, 2.2);
    this.scrape = loop(3200, 1.2);
    this.wind = loop(900, 0.4, 'lowpass');
  }

  // speedRatio 0..~1.4
  updateEngine(speedRatio, nitroActive, throttle = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    // Fake gearbox: pitch climbs within a gear then drops at the shift point.
    const gears = 5;
    const g = Math.min(gears - 1, Math.floor(speedRatio * gears));
    const inGear = speedRatio * gears - g;
    const base = 42 + g * 9 + inGear * 70 + (nitroActive ? 25 : 0);
    this.engine.oscs.forEach(({ o, mult }) => o.frequency.setTargetAtTime(base * mult, t, 0.04));
    this.engine.filter.frequency.setTargetAtTime(350 + throttle * 900 + speedRatio * 800 + (nitroActive ? 900 : 0), t, 0.06);
    this.engine.gain.gain.setTargetAtTime(0.05 + throttle * 0.07 + speedRatio * 0.06, t, 0.08);
    this.wind.g.gain.setTargetAtTime(Math.max(0, speedRatio - 0.3) * 0.12 + (nitroActive ? 0.08 : 0), t, 0.2);
  }

  setSkid(amount) {
    if (!this.ctx) return;
    this.skid.g.gain.setTargetAtTime(Math.min(1, amount) * 0.16, this.ctx.currentTime, 0.05);
  }

  setScrape(amount) {
    if (!this.ctx) return;
    this.scrape.g.gain.setTargetAtTime(Math.min(1, amount) * 0.22, this.ctx.currentTime, 0.03);
  }

  silenceLoops() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engine.gain.gain.setTargetAtTime(0, t, 0.1);
    [this.skid, this.scrape, this.wind].forEach((l) => l.g.gain.setTargetAtTime(0, t, 0.1));
  }

  _tone(freq, dur, { type = 'sine', vol = 0.25, delay = 0, slideTo = null } = {}) {
    if (!this.enabled || !this._ensureContext()) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _burst(dur, { freq = 800, q = 1, vol = 0.4, type = 'lowpass', delay = 0, sweepTo = null } = {}) {
    if (!this.enabled || !this._ensureContext()) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }

  uiClick() { this._tone(1400, 0.06, { type: 'square', vol: 0.08 }); this._tone(2100, 0.05, { type: 'sine', vol: 0.06, delay: 0.03 }); }
  uiHover() { this._tone(900, 0.04, { type: 'sine', vol: 0.03 }); }
  countdownBeep(final = false) {
    if (final) {
      this._tone(1320, 0.7, { type: 'square', vol: 0.18 });
      this._tone(660, 0.9, { type: 'sawtooth', vol: 0.12 });
      this._burst(0.9, { freq: 400, sweepTo: 6000, type: 'bandpass', q: 0.8, vol: 0.35 });
    } else {
      this._tone(660, 0.28, { type: 'square', vol: 0.16 });
    }
  }
  rev() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.engine.oscs.forEach(({ o, mult }) => {
      o.frequency.cancelScheduledValues(t);
      o.frequency.setTargetAtTime(150 * mult, t, 0.05);
      o.frequency.setTargetAtTime(55 * mult, t + 0.25, 0.2);
    });
    this.engine.filter.frequency.setTargetAtTime(2200, t, 0.05);
    this.engine.filter.frequency.setTargetAtTime(500, t + 0.25, 0.2);
    this.engine.gain.gain.setTargetAtTime(0.16, t, 0.03);
    this.engine.gain.gain.setTargetAtTime(0.06, t + 0.3, 0.2);
  }
  checkpoint() { this._tone(1760, 0.12, { type: 'triangle', vol: 0.12 }); this._tone(2350, 0.14, { type: 'triangle', vol: 0.1, delay: 0.06 }); }
  lapChime(best = false) {
    [880, 1175, 1480].forEach((f, i) => this._tone(f, 0.3, { type: 'triangle', vol: 0.16, delay: i * 0.08 }));
    if (best) this._tone(1976, 0.5, { type: 'sine', vol: 0.12, delay: 0.3 });
  }
  boostPad() { this._burst(0.6, { freq: 300, sweepTo: 4000, type: 'bandpass', q: 1.5, vol: 0.45 }); this._tone(220, 0.5, { type: 'sawtooth', vol: 0.1, slideTo: 880 }); }
  nitroWhoosh() {
    this._burst(1.1, { freq: 200, sweepTo: 5000, type: 'bandpass', q: 0.9, vol: 0.55 });
    this._tone(110, 0.8, { type: 'sawtooth', vol: 0.14, slideTo: 440 });
  }
  collision(intensity = 1) {
    this._burst(0.35, { freq: 600, type: 'lowpass', vol: 0.3 + intensity * 0.4 });
    this._tone(70, 0.3, { type: 'sine', vol: 0.3 * intensity, slideTo: 40 });
  }
  finishFanfare() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this._tone(f, 0.45, { type: 'triangle', vol: 0.18, delay: i * 0.11 }));
    this._burst(1.4, { freq: 3000, type: 'highpass', vol: 0.12, delay: 0.5 });
  }
}
