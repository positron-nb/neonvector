import { formatTime } from './MainMenu.js';
import { RACE } from '../config/settings.js';

const SPEEDO_R = 92;
const SPEEDO_C = 2 * Math.PI * SPEEDO_R;
const SPEEDO_ARC = 0.75; // 270° gauge
const SPEEDO_MAX_KMH = 340;
const NITRO_SEGMENTS = 20;

export function ordinal(n) {
  return n === 1 ? 'ST' : n === 2 ? 'ND' : n === 3 ? 'RD' : 'TH';
}

export class HUD {
  constructor(track) {
    this.track = track;
    const $ = (id) => document.getElementById(id);
    this.el = {
      pos: $('hud-pos'), posSuffix: $('hud-pos-suffix'), posTotal: $('hud-pos-total'),
      lap: $('hud-lap'), lapTotal: $('hud-lap-total'), standings: $('hud-standings'),
      time: $('hud-time'), lapTime: $('hud-laptime'), bestLap: $('hud-bestlap'), checkpoint: $('hud-checkpoint'),
      conn: $('hud-conn'), latency: $('hud-latency'),
      speed: $('hud-speed'), speedoFill: $('speedo-fill'), speedoTicks: $('speedo-ticks'),
      gforce: $('hud-gforce'), drift: $('hud-drift'),
      nitroBar: $('hud-nitro-bar'), nitroPct: $('hud-nitro-pct'),
      motion: $('hud-motion'), motionDot: $('motion-dot'), motionHorizon: $('motion-horizon'),
      minimap: $('hud-minimap'), message: $('hud-message'), submessage: $('hud-submessage'), warning: $('hud-warning')
    };
    this.el.lapTotal.textContent = RACE.totalLaps;

    this._buildSpeedo();
    this._buildNitroBar();
    this._buildMinimap();
    this._cache = {};
  }

  _buildSpeedo() {
    const fill = this.el.speedoFill;
    fill.style.strokeDasharray = `0 ${SPEEDO_C}`;
    const track = fill.previousElementSibling;
    track.style.strokeDasharray = `${SPEEDO_C * SPEEDO_ARC} ${SPEEDO_C}`;
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i <= 34; i++) {
      const a = (135 + (i / 34) * 270) * Math.PI / 180;
      const major = i % 5 === 0;
      const r0 = major ? 74 : 79, r1 = 84;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 110 + Math.cos(a) * r0);
      line.setAttribute('y1', 110 + Math.sin(a) * r0);
      line.setAttribute('x2', 110 + Math.cos(a) * r1);
      line.setAttribute('y2', 110 + Math.sin(a) * r1);
      line.setAttribute('class', major ? 'tick major' : 'tick');
      this.el.speedoTicks.appendChild(line);
    }
  }

  _buildNitroBar() {
    this.nitroSegs = [];
    for (let i = 0; i < NITRO_SEGMENTS; i++) {
      const s = document.createElement('i');
      this.el.nitroBar.appendChild(s);
      this.nitroSegs.push(s);
    }
  }

  _buildMinimap() {
    const c = this.el.minimap;
    this.mm = c.getContext('2d');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    this.track.samples.forEach((p) => {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    });
    const pad = 22;
    const scale = Math.min((c.width - pad * 2) / (maxX - minX), (c.height - pad * 2) / (maxZ - minZ));
    const ox = (c.width - (maxX - minX) * scale) / 2;
    const oz = (c.height - (maxZ - minZ) * scale) / 2;
    this._map = (p) => ({ x: ox + (p.x - minX) * scale, y: oz + (p.z - minZ) * scale });

    // Static layer (track glow, tunnel, start line) rendered once.
    const bg = document.createElement('canvas');
    bg.width = c.width;
    bg.height = c.height;
    const g = bg.getContext('2d');
    const path = () => {
      g.beginPath();
      this.track.samples.forEach((p, i) => { const m = this._map(p); if (i === 0) g.moveTo(m.x, m.y); else g.lineTo(m.x, m.y); });
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(33,243,255,0.18)'; g.lineWidth = 12; path(); g.stroke();
    g.strokeStyle = 'rgba(33,243,255,0.35)'; g.lineWidth = 6; path(); g.stroke();
    g.strokeStyle = 'rgba(200,250,255,0.9)'; g.lineWidth = 1.6; path(); g.stroke();
    // Tunnel section.
    g.strokeStyle = 'rgba(255,43,214,0.85)'; g.lineWidth = 4;
    g.beginPath();
    for (let t = this.track.tunnel.start; t <= this.track.tunnel.end; t += 0.004) {
      const m = this._map(this.track.getPointAt(t));
      if (t === this.track.tunnel.start) g.moveTo(m.x, m.y); else g.lineTo(m.x, m.y);
    }
    g.stroke();
    const s = this._map(this.track.getPointAt(0));
    g.fillStyle = '#ffffff';
    g.fillRect(s.x - 4, s.y - 1.5, 8, 3);
    this._mmBg = bg;
  }

  setConnection(link, latencyMs) {
    const el = this.el.conn;
    el.classList.toggle('online', link === 'online');
    el.classList.toggle('weak', link === 'weak');
    el.querySelector('.txt').textContent =
      link === 'online' ? 'MPU LINK // ONLINE' : link === 'weak' ? 'MPU LINK // WEAK' : 'MPU LINK // OFFLINE';
    const bars = link === 'offline' ? 0 : link === 'weak' ? 1 : latencyMs == null ? 3 : latencyMs < 40 ? 4 : latencyMs < 90 ? 3 : 2;
    el.querySelectorAll('.bars i').forEach((b, i) => b.classList.toggle('on', i < bars));
    this.el.latency.textContent = link !== 'offline' && latencyMs != null ? `${Math.round(latencyMs)} MS` : 'KEYBOARD';
    this.el.motion.classList.toggle('hidden', link === 'offline');
  }

  // priority: a lower-priority message (e.g. BOOST) never interrupts a more
  // important one (LAP / FINAL LAP / FINISH) that is still on screen.
  showMessage(text, sub = '', kind = '', priority = 1) {
    const now = performance.now();
    if (now < (this._msgUntil || 0) && priority < (this._msgPriority || 0)) return;
    this._msgUntil = now + 1800;
    this._msgPriority = priority;
    const m = this.el.message, s = this.el.submessage;
    m.textContent = text;
    s.textContent = sub;
    m.className = `hud-message ${kind}`;
    s.className = 'hud-submessage';
    void m.offsetWidth;
    m.classList.add('show');
    if (sub) s.classList.add('show');
  }

  setWrongWay(on) {
    this.el.warning.classList.toggle('hidden', !on);
  }

  // Live controller tilt: dot = steer/throttle, horizon line = roll.
  setMotion(steer, pitchInput, rollDeg) {
    this.el.motionDot.style.transform = `translate(${steer * 26}px, ${pitchInput * 26}px)`;
    this.el.motionHorizon.style.transform = `rotate(${-rollDeg}deg)`;
  }

  _set(key, el, value) {
    if (this._cache[key] !== value) {
      this._cache[key] = value;
      el.textContent = value;
    }
  }

  update(d) {
    this._set('speed', this.el.speed, String(Math.round(d.speedKmh)));
    const ratio = Math.min(1, d.speedKmh / SPEEDO_MAX_KMH);
    this.el.speedoFill.style.strokeDasharray = `${SPEEDO_C * SPEEDO_ARC * ratio} ${SPEEDO_C}`;
    this.el.speedoFill.classList.toggle('nitro', d.nitroActive);

    this._set('pos', this.el.pos, String(d.position));
    this._set('posSuffix', this.el.posSuffix, ordinal(d.position));
    this._set('posTotal', this.el.posTotal, String(d.totalRacers));
    this._set('lap', this.el.lap, String(Math.min(Math.max(d.lap + 1, 1), RACE.totalLaps)));
    this._set('time', this.el.time, formatTime(d.elapsedMs));
    this._set('lapTime', this.el.lapTime, formatTime(d.lapMs));
    this._set('best', this.el.bestLap, Number.isFinite(d.bestLapMs) ? formatTime(d.bestLapMs) : '--:--.--');
    this._set('cp', this.el.checkpoint, `CHECKPOINT ${d.checkpointsThisLap}/${RACE.checkpointCount}`);
    this._set('g', this.el.gforce, d.gForce.toFixed(1));
    this._set('drift', this.el.drift, `${Math.round(Math.abs(d.driftAngleDeg))}°`);

    const lit = Math.round(d.nitro * NITRO_SEGMENTS);
    if (this._cache.nitroLit !== lit || this._cache.nitroOn !== d.nitroActive) {
      this._cache.nitroLit = lit;
      this._cache.nitroOn = d.nitroActive;
      this.nitroSegs.forEach((s, i) => s.classList.toggle('on', i < lit));
      this.el.nitroBar.classList.toggle('active', d.nitroActive);
      this.el.nitroBar.classList.toggle('empty', lit === 0);
    }
    this._set('nitroPct', this.el.nitroPct, lit === 0 ? 'NITRO EMPTY' : `${Math.round(d.nitro * 100)}%`);

    this._updateStandings(d.standings);
    this._drawMinimap(d.player, d.aiCars);
  }

  _updateStandings(rows) {
    const key = rows.map((r) => `${r.name}${r.gap}`).join('|');
    if (this._cache.standings === key) return;
    this._cache.standings = key;
    this.el.standings.innerHTML = rows.map((r, i) =>
      `<li class="${r.isPlayer ? 'me' : ''}" style="--c:${r.color}"><span class="p">${i + 1}</span><span class="n">${r.name}</span><span class="g">${r.gap}</span></li>`
    ).join('');
  }

  _drawMinimap(player, aiCars) {
    const g = this.mm;
    const { width, height } = this.el.minimap;
    g.clearRect(0, 0, width, height);
    g.drawImage(this._mmBg, 0, 0);

    aiCars.forEach((ai) => {
      const m = this._map(ai.state.position);
      ai._mmColor = ai._mmColor || `#${ai.parts.accent.clone().multiplyScalar(1 / 3.4).getHexString()}`;
      g.fillStyle = ai._mmColor;
      g.shadowColor = g.fillStyle;
      g.shadowBlur = 8;
      g.beginPath();
      g.arc(m.x, m.y, 4.5, 0, Math.PI * 2);
      g.fill();
    });

    const m = this._map(player.state.position);
    const h = player.state.heading;
    g.save();
    g.translate(m.x, m.y);
    g.rotate(-h + Math.PI);
    g.fillStyle = '#ffffff';
    g.shadowColor = '#21f3ff';
    g.shadowBlur = 12;
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(5.5, 6);
    g.lineTo(0, 3);
    g.lineTo(-5.5, 6);
    g.closePath();
    g.fill();
    g.restore();
    g.shadowBlur = 0;
  }
}
