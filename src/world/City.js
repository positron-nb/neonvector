import * as THREE from 'three';
import { COLORS, neon } from '../config/settings.js';
import { FOG_COLOR } from './Environment.js';
import { LAYER_NO_REFLECT } from './WetSurface.js';

// ---------------------------------------------------------------------------
// Building material: MeshStandardMaterial extended with procedural facades.
// Windows are computed in the shader from world-scale facade coordinates, so
// every building gets crisp, correctly-sized windows regardless of its
// instance scale. Per-instance attributes:
//   aTint   vec3  window / storefront colour (linear)
//   aParams vec4  x=seed, y=lit ratio, z=facade style, w=emission intensity
// ---------------------------------------------------------------------------
function createBuildingMaterial(timeUniform, { haze = 0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0d0f18,
    roughness: 0.62,
    metalness: 0.35,
    envMapIntensity: 0.55,
    fog: haze === 0
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uHaze = { value: haze };
    shader.uniforms.uHazeColor = { value: FOG_COLOR };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        attribute vec3 aTint;
        attribute vec4 aParams;
        varying vec2 vFacade;
        varying float vRoof;
        varying float vHeight;
        varying vec3 vTint;
        varying vec4 vParams;`)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vec3 instScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec3 an = abs(normal);
        vFacade = an.x > 0.5
          ? vec2((position.z + 0.5) * instScale.z, position.y * instScale.y)
          : vec2((position.x + 0.5) * instScale.x, position.y * instScale.y);
        vRoof = step(0.5, normal.y);
        vHeight = instScale.y;
        vTint = aTint;
        vParams = aParams;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform float uTime;
        uniform float uHaze;
        uniform vec3 uHazeColor;
        varying vec2 vFacade;
        varying float vRoof;
        varying float vHeight;
        varying vec3 vTint;
        varying vec4 vParams;
        float nvHash(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        float nvFacade = 1.0 - vRoof;
        float style = vParams.z;
        vec2 cellSize = vec2(mix(1.7, 2.8, fract(style * 3.7)), mix(2.8, 3.4, fract(style * 5.3)));
        vec2 fc = vFacade / cellSize;
        vec2 cell = floor(fc);
        vec2 f = fract(fc);
        // Three facade styles: punched windows, ribbon glazing, vertical slits.
        float punched = step(0.16, f.x) * step(f.x, 0.84) * step(0.24, f.y) * step(f.y, 0.8);
        float ribbon = step(0.06, f.x) * step(f.x, 0.97) * step(0.3, f.y) * step(f.y, 0.86);
        float slit = step(0.4, f.x) * step(f.x, 0.6) * step(0.1, f.y) * step(f.y, 0.92);
        float frameMask = style < 0.45 ? punched : (style < 0.8 ? ribbon : slit);
        float inBody = step(4.6, vFacade.y) * step(vFacade.y, vHeight - 1.2);
        float nvWin = frameMask * inBody * nvFacade;

        float seed = vParams.x * 91.7;
        float rnd = nvHash(cell + seed);
        float lit = step(1.0 - vParams.y, nvHash(cell * 1.37 + seed * 0.37));
        // Offices switching on and off over time.
        float slot = floor(uTime * 0.05 + rnd * 23.0);
        lit = abs(lit - step(0.965, nvHash(cell + slot * 1.7 + seed)));
        // A few flickering screens.
        float tv = step(0.988, rnd) * (0.55 + 0.45 * sin(uTime * (6.0 + rnd * 30.0)));
        vec3 warm = vec3(1.0, 0.62, 0.32);
        vec3 wcol = mix(vTint, warm, step(0.62, nvHash(cell * 2.1 + seed)));
        float brightness = 0.25 + 0.75 * nvHash(cell * 3.3 + seed);
        vec3 nvEmit = wcol * nvWin * (lit * brightness + tv) * vParams.w;

        // Street level: individual coloured shop windows separated by dark
        // piers, plus a faint colour spill up the facade.
        float store = nvFacade * step(0.6, vFacade.y) * step(vFacade.y, 3.4) * step(0.3, vParams.y);
        float shopId = floor(vFacade.x / 5.5);
        float shopX = fract(vFacade.x / 5.5);
        float shopOn = step(0.35, nvHash(vec2(shopId, seed))) * step(0.12, shopX) * step(shopX, 0.88);
        vec3 shopCol = mix(vec3(1.0, 0.22, 0.8), vec3(0.12, 0.85, 1.0), step(0.5, nvHash(vec2(shopId + 3.0, seed))));
        nvEmit += mix(vTint, shopCol, 0.65) * store * shopOn * 0.55;
        nvEmit += vTint * nvFacade * 0.08 * exp(-vFacade.y * 0.25);

        // Roof crown line on some towers.
        float crown = nvFacade * smoothstep(vHeight - 0.7, vHeight - 0.35, vFacade.y) * step(vFacade.y, vHeight - 0.08) * step(0.62, fract(seed * 0.013));
        nvEmit += vTint * crown * 3.2;

        // Facade breakup: darker floor slabs, glossy glass.
        diffuseColor.rgb *= mix(0.75, 1.1, step(0.12, f.y)) * mix(1.0, 0.35, nvWin);
        roughnessFactor = mix(roughnessFactor, 0.08, nvWin);
        totalEmissiveRadiance += nvEmit;`)
      .replace('#include <metalnessmap_fragment>', /* glsl */`#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.9, nvWin);`)
      .replace('#include <opaque_fragment>', /* glsl */`#include <opaque_fragment>
        if (uHaze > 0.0) gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, uHaze * (1.0 - clamp(length(nvEmit), 0.0, 0.6)));`);
  };
  mat.customProgramCacheKey = () => `nvBuilding${haze > 0 ? 'Haze' : ''}`;
  return mat;
}

const WINDOW_TINTS = [
  [0xcfe6ff, 5], [0xffd6a0, 5], [COLORS.cyan, 2], [COLORS.magenta, 2], [COLORS.violet, 2], [COLORS.orange, 1], [COLORS.electricBlue, 1]
];
function pickTint(rng) {
  const total = WINDOW_TINTS.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [hex, w] of WINDOW_TINTS) { if ((r -= w) <= 0) return new THREE.Color(hex); }
  return new THREE.Color(WINDOW_TINTS[0][0]);
}

// Small deterministic RNG so the city is identical between reloads.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BILLBOARD_COPY = [
  ['NOODLE BAR', '24H // LVL 3'], ['ネオン', 'NEON DISTRICT'], ['OVERDRIVE', 'RACE NIGHT'], ['DATA HAVEN', 'SECURE STORAGE'],
  ['未来', 'FUTURE IS NOW'], ['KAIJU ARCADE', 'INSERT COIN'], ['SECTOR 9', 'NO CURFEW'], ['速度', 'SPEED KILLS BOREDOM'],
  ['CYBER CLINIC', 'CHROME // REPAIR'], ['NEXUS 24H', 'OPEN ALL CYCLES'], ['夜市', 'NIGHT MARKET'], ['PULSE FM', '99.9 SYNTH RADIO']
];

function billboardTexture(title, sub, rng) {
  const w = 512, h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.globalAlpha = 0.18;
  g.fillStyle = '#fff';
  g.fillRect(10, 10, w - 20, h - 20);
  g.globalAlpha = 1;
  // Decorative shapes.
  if (rng() < 0.5) {
    g.lineWidth = 3;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(w - 70, 70, 18 + i * 12, 0, Math.PI * 1.5); g.stroke(); }
  } else {
    for (let i = 0; i < 6; i++) g.fillRect(30 + i * 22, h - 50, 12, -10 - rng() * 30);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.shadowColor = '#fff';
  g.shadowBlur = 14;
  const cjk = /[^\x00-\x7F]/.test(title);
  g.font = cjk ? '900 120px sans-serif' : '900 64px Orbitron, sans-serif';
  g.fillText(title, w / 2, h * 0.43, w - 60);
  g.shadowBlur = 6;
  g.font = '700 26px Rajdhani, sans-serif';
  g.fillText(sub, w / 2, h * 0.78, w - 60);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function hologramMaterial(map, color, seed) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { map: { value: map }, uColor: { value: color }, uTime: { value: 0 }, uSeed: { value: seed } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */`
      uniform sampler2D map; uniform vec3 uColor; uniform float uTime, uSeed; varying vec2 vUv;
      float h(float x) { return fract(sin(x) * 43758.5453); }
      void main() {
        vec2 uv = vUv;
        float glitch = step(0.975, h(floor(uTime * 9.0) + uSeed * 13.0));
        uv.x += glitch * (h(floor(uv.y * 24.0) + uTime) - 0.5) * 0.09;
        vec4 tex = texture2D(map, uv);
        float scan = 0.72 + 0.28 * sin(uv.y * 380.0 + uTime * 4.0);
        float flicker = 0.88 + 0.12 * sin(uTime * 21.0 + uSeed * 7.0) * sin(uTime * 5.3 + uSeed);
        float a = tex.a * scan * flicker * (1.0 - glitch * 0.35);
        gl_FragColor = vec4(uColor * a, 1.0);
      }`
  });
}

export class City {
  constructor(track, quality) {
    this.track = track;
    this.quality = quality;
    this.group = new THREE.Group();
    this.time = { value: 0 };
    this.rng = mulberry32(1337);
    this.hologramMats = [];

    this._footprints = [];
    this._buildBuildings();
    this._buildRooftops();
    this._buildSigns();
    this._buildBillboards();
    this._buildFarSkyline(quality.farBuildings);
    this._buildFlyers(quality.flyers);
    this._buildHaze();
    this._buildSearchlights();
  }

  // --------------------------------------------------------------- helpers --

  _clearOfTrack(pos, radius, minGap) {
    return this.track.closestPoint(pos).distance > this.track.barrierOffset + minGap + radius;
  }

  _clearOfOverpasses(pos, radius) {
    for (const t of this.track.overpasses) {
      const p = this.track.getPointAt(t);
      const tan = this.track.getTangentAt(t);
      // Distance from pos to the deck's centre line (runs along the track normal).
      const dx = pos.x - p.x, dz = pos.z - p.z;
      const along = Math.abs(dx * tan.x + dz * tan.z);
      if (along < 9 + radius) return false;
    }
    return true;
  }

  _clearOfBuildings(pos, radius) {
    for (const f of this._footprints) {
      const dx = pos.x - f.x, dz = pos.z - f.z;
      if (dx * dx + dz * dz < (radius + f.r) * (radius + f.r)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- buildings --

  _buildBuildings() {
    const rng = this.rng;
    const q = this.quality;
    const specs = [];

    const place = (count, dMin, dMax, hMin, hMax, sizeMin, sizeMax, near) => {
      let placed = 0, attempts = 0;
      while (placed < count && attempts < count * 12) {
        attempts++;
        const t = rng();
        const side = rng() < 0.5 ? 1 : -1;
        const dist = this.track.barrierOffset + dMin + rng() * (dMax - dMin);
        const p = this.track.getPointAt(t);
        const n = this.track.getNormalAt(t);
        const tan = this.track.getTangentAt(t);
        const w = sizeMin + rng() * (sizeMax - sizeMin);
        const d = sizeMin + rng() * (sizeMax - sizeMin);
        const radius = Math.hypot(w, d) / 2;
        const pos = p.clone().addScaledVector(n, side * (dist + radius)).addScaledVector(tan, (rng() - 0.5) * 12);
        if (!this._clearOfTrack(pos, radius, near ? 4 : 10)) continue;
        if (!this._clearOfBuildings(pos, radius * 0.92)) continue;
        let h = hMin + Math.pow(rng(), 1.6) * (hMax - hMin);
        if (!this._clearOfOverpasses(pos, radius)) { if (h > 14) continue; }
        // Near the track, face buildings square to the road for a street-canyon look.
        const rotY = near ? Math.atan2(tan.x, tan.z) + (rng() < 0.2 ? 0.3 : 0) : rng() * Math.PI;
        this._footprints.push({ x: pos.x, z: pos.z, r: radius });
        specs.push({ pos, w, d, h, rotY, near, side, heading: Math.atan2(tan.x, tan.z) });
        placed++;
      }
    };
    // (count, gap-from-barrier min/max, height min/max, footprint min/max, near?)
    place(q.nearBuildings, 5, 22, 18, 95, 10, 22, true);
    place(q.midBuildings, 32, 150, 30, 190, 14, 34, false);

    // Each building is a stack of boxes: the base plus up to two setback
    // tiers on taller towers.
    const boxes = [];
    this._roofTops = specs.map((s) => {
      s.tint = pickTint(rng);
      s.seed = rng();
      const lit = 0.12 + rng() * 0.42;
      const emit = 0.4 + rng() * 0.75;
      let y = 0, w = s.w, d = s.d, h = s.h;
      const tierCount = s.h > 90 && rng() < 0.5 ? 2 : (s.h > 40 && rng() < 0.55 ? 1 : 0);
      for (let k = 0; k <= tierCount; k++) {
        boxes.push({ s, y, w, d, h, seed: s.seed + k * 0.37, lit, emit });
        y += h;
        const shrink = k === 0 ? 0.55 + rng() * 0.25 : 0.55 + rng() * 0.15;
        w *= shrink;
        d *= shrink;
        h = s.h * (k === 0 ? 0.25 + rng() * 0.3 : 0.15 + rng() * 0.15);
      }
      const top = boxes[boxes.length - 1];
      return { spec: s, top: top.y + top.h, w: top.w, d: top.d };
    });
    this.buildingSpecs = specs;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const tint = new Float32Array(boxes.length * 3);
    const params = new Float32Array(boxes.length * 4);
    const mesh = new THREE.InstancedMesh(geo, createBuildingMaterial(this.time), boxes.length);
    const dummy = new THREE.Object3D();
    boxes.forEach((b, i) => {
      tint.set([b.s.tint.r, b.s.tint.g, b.s.tint.b], i * 3);
      params.set([b.seed, b.lit, b.s.seed, b.emit], i * 4);
      dummy.position.set(b.s.pos.x, b.y, b.s.pos.z);
      dummy.rotation.set(0, b.s.rotY, 0);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.buildings = mesh;
  }

  _buildRooftops() {
    const rng = this.rng;
    const tall = this._roofTops.filter((r) => r.top > 45);
    const antennaGeo = new THREE.BoxGeometry(0.35, 1, 0.35);
    antennaGeo.translate(0, 0.5, 0);
    const antennaMat = new THREE.MeshStandardMaterial({ color: 0x1a1c24, metalness: 0.9, roughness: 0.4 });
    const antennas = new THREE.InstancedMesh(antennaGeo, antennaMat, tall.length * 2);
    const beaconGeo = new THREE.SphereGeometry(0.45, 8, 6);
    this.beaconMatA = new THREE.MeshBasicMaterial({ color: neon(COLORS.red, 6) });
    this.beaconMatB = new THREE.MeshBasicMaterial({ color: neon(COLORS.red, 6) });
    const beaconsA = new THREE.InstancedMesh(beaconGeo, this.beaconMatA, tall.length);
    const beaconsB = new THREE.InstancedMesh(beaconGeo, this.beaconMatB, tall.length);
    const dummy = new THREE.Object3D();
    let a = 0, ba = 0, bb = 0;
    tall.forEach((r) => {
      const s = r.spec;
      const n = rng() < 0.6 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const h = 6 + rng() * 22;
        const off = new THREE.Vector3((rng() - 0.5) * r.w * 0.6, 0, (rng() - 0.5) * r.d * 0.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY);
        dummy.position.set(s.pos.x + off.x, r.top, s.pos.z + off.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, h, 1);
        dummy.updateMatrix();
        antennas.setMatrixAt(a++, dummy.matrix);
        if (k === 0) {
          dummy.position.y = r.top + h + 0.3;
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          if (rng() < 0.5) beaconsA.setMatrixAt(ba++, dummy.matrix); else beaconsB.setMatrixAt(bb++, dummy.matrix);
        }
      }
    });
    antennas.count = a;
    beaconsA.count = ba;
    beaconsB.count = bb;
    [antennas, beaconsA, beaconsB].forEach((m) => { m.instanceMatrix.needsUpdate = true; this.group.add(m); });
  }

  // Vertical blade signs and roof crown bands on buildings lining the track.
  _buildSigns() {
    const rng = this.rng;
    const near = this._roofTops.filter((r) => r.spec.near);
    const palette = [COLORS.cyan, COLORS.magenta, COLORS.violet, COLORS.orange, COLORS.electricBlue, 0xff3355];
    // Blades protrude from the road-facing facade (local X) so their broad
    // faces point up and down the street at oncoming traffic.
    const bladeGeo = new THREE.BoxGeometry(2.2, 1, 0.4);
    const blades = new THREE.InstancedMesh(bladeGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), near.length);
    const bandGeo = new THREE.BoxGeometry(1, 0.35, 1);
    const bands = new THREE.InstancedMesh(bandGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), near.length);
    const dummy = new THREE.Object3D();
    let b = 0, c = 0;
    near.forEach((r) => {
      const s = r.spec;
      if (rng() < 0.55) {
        // The road lies in the -side direction along the left normal (local X).
        const h = 6 + rng() * 12;
        const localX = -s.side * (s.w / 2 + 1.1);
        const localZ = (rng() - 0.5) * s.d * 0.7;
        const off = new THREE.Vector3(localX, 0, localZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY);
        dummy.position.set(s.pos.x + off.x, 5 + rng() * Math.max(1, s.h - h - 8) + h / 2, s.pos.z + off.z);
        dummy.rotation.set(0, s.rotY, 0);
        dummy.scale.set(1, h, 1);
        dummy.updateMatrix();
        blades.setMatrixAt(b, dummy.matrix);
        blades.setColorAt(b, neon(palette[Math.floor(rng() * palette.length)], 2.4 + rng() * 1.5));
        b++;
      }
      if (rng() < 0.3) {
        dummy.position.set(s.pos.x, s.h - 1.4, s.pos.z);
        dummy.rotation.set(0, s.rotY, 0);
        dummy.scale.set(s.w + 0.25, 1, s.d + 0.25);
        dummy.updateMatrix();
        bands.setMatrixAt(c, dummy.matrix);
        bands.setColorAt(c, neon(palette[Math.floor(rng() * palette.length)], 2.2));
        c++;
      }
    });
    blades.count = b;
    bands.count = c;
    [blades, bands].forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    });
  }

  _buildBillboards() {
    const rng = this.rng;
    const palette = [COLORS.cyan, COLORS.magenta, COLORS.violet, COLORS.orange, 0x7dff9a, COLORS.electricBlue];
    // Prefer buildings close to the road on the outside of corners.
    const candidates = this._roofTops.filter((r) => r.spec.near && r.spec.h > 26).sort(() => rng() - 0.5);
    const count = Math.min(14, candidates.length);
    for (let i = 0; i < count; i++) {
      const s = candidates[i].spec;
      const [title, sub] = BILLBOARD_COPY[i % BILLBOARD_COPY.length];
      const tall = i % 5 === 4;
      const width = tall ? 7 : 12 + rng() * 8;
      const height = tall ? 20 : width * 0.5;
      const mat = hologramMaterial(billboardTexture(title, sub, rng), neon(palette[i % palette.length], 2.2), rng() * 10);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
      // Mount on the facade that faces the track.
      const closest = this.track.closestPoint(s.pos);
      const toTrack = new THREE.Vector3().subVectors(closest.point, s.pos).setY(0).normalize();
      const halfDepth = Math.max(s.w, s.d) / 2;
      mesh.position.copy(s.pos).addScaledVector(toTrack, halfDepth + 0.6);
      mesh.position.y = Math.min(s.h - height / 2 - 2, 14 + rng() * 16);
      mesh.lookAt(mesh.position.clone().add(toTrack));
      this.group.add(mesh);
      this.hologramMats.push(mat);
    }
  }

  _buildFarSkyline(count) {
    const rng = this.rng;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const tint = new Float32Array(count * 3);
    const params = new Float32Array(count * 4);
    const mesh = new THREE.InstancedMesh(geo, createBuildingMaterial(this.time, { haze: 0.62 }), count);
    const dummy = new THREE.Object3D();
    const center = new THREE.Vector3(50, 0, -60);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rng() * 0.05;
      const radius = 430 + rng() * 170;
      const h = 70 + Math.pow(rng(), 1.3) * 260;
      dummy.position.set(center.x + Math.cos(angle) * radius, 0, center.z + Math.sin(angle) * radius);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(20 + rng() * 30, h, 20 + rng() * 30);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const c = pickTint(rng);
      tint.set([c.r, c.g, c.b], i * 3);
      params.set([rng(), 0.3 + rng() * 0.4, rng(), 1.4 + rng()], i * 4);
    }
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  _buildFlyers(count) {
    const rng = this.rng;
    const bodyGeo = new THREE.BoxGeometry(1.8, 0.8, 4.2);
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x14161e, metalness: 0.8, roughness: 0.35 }), count);
    const lightGeo = new THREE.BoxGeometry(1.5, 0.2, 0.2);
    const lights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), count * 3);
    const center = new THREE.Vector3(50, 0, -60);
    this.flyers = [];
    for (let i = 0; i < count; i++) {
      const circular = rng() < 0.7;
      this.flyers.push({
        circular,
        radius: 120 + rng() * 260,
        angle: rng() * Math.PI * 2,
        altitude: 38 + rng() * 90,
        speed: (18 + rng() * 26) * (rng() < 0.5 ? 1 : -1),
        center,
        // straight lanes: a line through the city
        dir: new THREE.Vector3(Math.cos(rng() * Math.PI * 2), 0, Math.sin(rng() * Math.PI * 2)),
        progress: rng() * 800 - 400,
        offset: new THREE.Vector3((rng() - 0.5) * 300, 0, (rng() - 0.5) * 300),
        bob: rng() * 10
      });
      lights.setColorAt(i * 3, neon(0xe8f6ff, 5));
      lights.setColorAt(i * 3 + 1, neon(COLORS.red, 4));
      lights.setColorAt(i * 3 + 2, neon(rng() < 0.5 ? COLORS.cyan : COLORS.magenta, 3));
    }
    lights.instanceColor.needsUpdate = true;
    this.flyerBodies = bodies;
    this.flyerLights = lights;
    this.group.add(bodies, lights);
    this._fm = new THREE.Matrix4();
    this._fp = new THREE.Vector3();
    this._fq = new THREE.Quaternion();
    this._fe = new THREE.Euler();
    this._fone = new THREE.Vector3(1, 1, 1);
    this._flocal = new THREE.Vector3();
  }

  _buildHaze() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const palette = [COLORS.magenta, COLORS.violet, COLORS.cyan, COLORS.orange, COLORS.magenta, COLORS.electricBlue];
    const center = new THREE.Vector3(50, 0, -60);
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2 + this.rng() * 0.3;
      const r = 260 + this.rng() * 180;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: neon(palette[i % palette.length], 0.22), blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, fog: false
      }));
      sprite.position.set(center.x + Math.cos(angle) * r, 25 + this.rng() * 40, center.z + Math.sin(angle) * r);
      const s = 220 + this.rng() * 200;
      sprite.scale.set(s, s * 0.55, 1);
      sprite.layers.set(LAYER_NO_REFLECT);
      this.group.add(sprite);
    }
  }

  _buildSearchlights() {
    this.searchlights = [];
    const tallest = [...this._roofTops].sort((a, b) => b.top - a.top).slice(0, 4);
    const geo = new THREE.CylinderGeometry(9, 0.6, 260, 20, 1, true);
    geo.translate(0, 130, 0);
    tallest.forEach((r, i) => {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uColor: { value: neon(i % 2 ? COLORS.violet : 0x9fdcff, 0.28) } },
        vertexShader: 'varying float vH; varying vec3 vN; varying vec3 vV; void main(){ vH = position.y / 260.0; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
        // max(...) matters: |dot| can round to just above 1, and pow() of a
        // negative base is NaN, which bloom would smear across the screen.
        fragmentShader: 'uniform vec3 uColor; varying float vH; varying vec3 vN; varying vec3 vV; void main(){ float rim = pow(max(1.0 - abs(dot(vN, vV)), 0.0), 1.5); float h = clamp(1.0 - vH, 0.0, 1.0); float a = h * h * (0.35 + rim); gl_FragColor = vec4(uColor * a, 1.0); }'
      });
      const beam = new THREE.Mesh(geo, mat);
      beam.position.set(r.spec.pos.x, r.top, r.spec.pos.z);
      beam.layers.set(LAYER_NO_REFLECT);
      this.group.add(beam);
      this.searchlights.push({ beam, phase: i * 1.7, speed: 0.18 + i * 0.05 });
    });
  }

  update(dt, elapsed) {
    this.time.value = elapsed;
    this.hologramMats.forEach((m) => { m.uniforms.uTime.value = elapsed; });

    // Alternating aircraft-warning beacons.
    const blink = (elapsed % 1.6) < 0.18;
    const blink2 = ((elapsed + 0.8) % 1.6) < 0.18;
    this.beaconMatA.color.setHex(COLORS.red).multiplyScalar(blink ? 7 : 0.35);
    this.beaconMatB.color.setHex(COLORS.red).multiplyScalar(blink2 ? 7 : 0.35);

    this.searchlights.forEach(({ beam, phase, speed }) => {
      beam.rotation.set(Math.sin(elapsed * speed + phase) * 0.45, 0, Math.cos(elapsed * speed * 0.8 + phase) * 0.45);
    });

    const m = this._fm, p = this._fp, q = this._fq, e = this._fe, one = this._fone, local = this._flocal;
    this.flyers.forEach((f, i) => {
      let heading;
      if (f.circular) {
        f.angle += (f.speed / f.radius) * dt;
        p.set(f.center.x + Math.cos(f.angle) * f.radius, f.altitude + Math.sin(elapsed * 0.5 + f.bob) * 2, f.center.z + Math.sin(f.angle) * f.radius);
        heading = Math.atan2(-Math.sin(f.angle) * Math.sign(f.speed), Math.cos(f.angle) * Math.sign(f.speed));
        e.set(0, heading, -0.18 * Math.sign(f.speed));
      } else {
        f.progress += Math.abs(f.speed) * dt;
        if (f.progress > 450) f.progress = -450;
        p.copy(f.center).add(f.offset).addScaledVector(f.dir, f.progress);
        p.y = f.altitude;
        heading = Math.atan2(f.dir.x, f.dir.z);
        e.set(0, heading, 0);
      }
      q.setFromEuler(e);
      this.flyerBodies.setMatrixAt(i, m.compose(p, q, one));
      local.set(0, 0, 2.15).applyQuaternion(q).add(p);
      this.flyerLights.setMatrixAt(i * 3, m.compose(local, q, one));
      local.set(0, 0, -2.15).applyQuaternion(q).add(p);
      this.flyerLights.setMatrixAt(i * 3 + 1, m.compose(local, q, one));
      local.set(0, -0.45, 0).applyQuaternion(q).add(p);
      this.flyerLights.setMatrixAt(i * 3 + 2, m.compose(local, q, one));
    });
    this.flyerBodies.instanceMatrix.needsUpdate = true;
    this.flyerLights.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        if (o.material.uniforms && o.material.uniforms.map) o.material.uniforms.map.value.dispose();
        o.material.dispose();
      }
    });
  }
}
