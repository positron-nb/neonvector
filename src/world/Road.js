import * as THREE from 'three';
import { COLORS, neon } from '../config/settings.js';
import { buildStrip, buildWall, placeAlong } from './ribbon.js';
import { LAYER_NO_REFLECT } from './WetSurface.js';

function glowTexture(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function textTexture(lines, { w = 1024, h = 256, color = '#ffffff', font = '900 120px Orbitron, sans-serif', glow = '#21f3ff' } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font;
  g.shadowColor = glow;
  g.shadowBlur = 24;
  g.fillStyle = color;
  const step = h / (lines.length + 1);
  lines.forEach((line, i) => g.fillText(line, w / 2, step * (i + 1)));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Road surface + everything bolted to it: markings, barriers, street lights,
// checkpoint arches, boost pads, start/finish gantry.
export class Road {
  constructor(track, wetSurface) {
    this.track = track;
    this.curve = track.curve;
    this.group = new THREE.Group();
    this.segments = Math.ceil(track.length / 1.5);
    this.flashes = [];

    this._buildSurface(wetSurface);
    this._buildMarkings();
    this._buildBarriers();
    this._buildStreetLights();
    this._buildCheckpointGates();
    this._buildBoostPads();
    this._buildStartGantry();
  }

  _buildSurface(wetSurface) {
    const w = this.track.width / 2;
    const mat = wetSurface.createSurfaceMaterial({ base: 0x0b0c12, puddle: 0.36, refl: 0.9, streak: 1.0, dry: 0.2 });
    const road = new THREE.Mesh(buildStrip(this.curve, { segments: this.segments, a: -w - 0.6, b: w + 0.6, y: 0.03 }), mat);
    road.layers.set(LAYER_NO_REFLECT);
    road.renderOrder = -5;
    this.group.add(road);

    // Kerb shoulders between the edge line and the barrier.
    const kerbMat = new THREE.MeshStandardMaterial({ color: 0x15161f, roughness: 0.5, metalness: 0.4 });
    [[w + 0.6, w + 1.4], [-w - 1.4, -w - 0.6]].forEach(([a, b]) => {
      const kerb = new THREE.Mesh(buildStrip(this.curve, { segments: this.segments, a, b, y: 0.05 }), kerbMat);
      this.group.add(kerb);
    });
  }

  _buildMarkings() {
    const w = this.track.width / 2;
    const edgeMat = new THREE.MeshBasicMaterial({ color: neon(0xdff8ff, 1.5), side: THREE.DoubleSide });
    [[w - 0.45, w - 0.2], [-w + 0.2, -w + 0.45]].forEach(([a, b]) => {
      this.group.add(new THREE.Mesh(buildStrip(this.curve, { segments: this.segments, a, b, y: 0.06 }), edgeMat));
    });

    // Dashed lane dividers (4 lanes).
    const dash = 3, gap = 5;
    const count = Math.floor(this.track.length / (dash + gap));
    const geo = new THREE.PlaneGeometry(0.22, dash);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: neon(0xbfefff, 1.6) });
    const offsets = [-w / 2, 0, w / 2];
    this.lanes = new THREE.InstancedMesh(geo, mat, count * offsets.length);
    let k = 0;
    offsets.forEach((off) => {
      placeAlong(this.curve, { count, offset: off, y: 0.065 }).forEach(({ matrix }) => this.lanes.setMatrixAt(k++, matrix));
    });
    this.lanes.instanceMatrix.needsUpdate = true;
    this.group.add(this.lanes);
  }

  _buildBarriers() {
    const o = this.track.barrierOffset;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x10121a, roughness: 0.35, metalness: 0.85, side: THREE.DoubleSide });
    const sides = [
      { off: o, color: COLORS.cyan },
      { off: -o, color: COLORS.magenta }
    ];
    sides.forEach(({ off, color }) => {
      this.group.add(new THREE.Mesh(buildWall(this.curve, { segments: this.segments, offset: off, y0: 0, y1: 1.0 }), wallMat));
      const top = new THREE.Mesh(
        buildWall(this.curve, { segments: this.segments, offset: off - Math.sign(off) * 0.02, y0: 0.82, y1: 0.95 }),
        new THREE.MeshBasicMaterial({ color: neon(color, 3.2), side: THREE.DoubleSide })
      );
      this.group.add(top);
      const low = new THREE.Mesh(
        buildWall(this.curve, { segments: this.segments, offset: off - Math.sign(off) * 0.02, y0: 0.1, y1: 0.16 }),
        new THREE.MeshBasicMaterial({ color: neon(color, 1.3), side: THREE.DoubleSide })
      );
      this.group.add(low);
    });
  }

  _buildStreetLights() {
    const spacing = 32;
    const count = Math.floor(this.track.length / spacing);
    const poleGeo = new THREE.BoxGeometry(0.28, 9, 0.28);
    poleGeo.translate(0, 4.5, 0);
    const armGeo = new THREE.BoxGeometry(3.4, 0.2, 0.3);
    const headGeo = new THREE.BoxGeometry(1.6, 0.14, 0.5);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x191b24, roughness: 0.5, metalness: 0.8 });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const placements = [];
    for (let i = 0; i < count; i++) {
      const t = (i + 0.25) / count;
      if (this.track.isInTunnel(t) || this.track.isInTunnel(t + 0.01) || this.track.isInTunnel(t - 0.01)) continue;
      if (Math.abs(t) < 0.012 || Math.abs(t - 1) < 0.012) continue; // keep the start gantry clear
      placements.push({ t, side: i % 2 === 0 ? 1 : -1, i });
    }

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, placements.length);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, placements.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, placements.length);
    const poolGeo = new THREE.PlaneGeometry(13, 13);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff
    });
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, placements.length);
    pools.layers.set(LAYER_NO_REFLECT);

    const palette = [neon(0xcff6ff, 4.5), neon(COLORS.cyan, 4), neon(COLORS.violet, 4.2), neon(0xcff6ff, 4.5), neon(COLORS.magenta, 4)];
    const dummy = new THREE.Object3D();
    const o = this.track.barrierOffset + 0.9;

    placements.forEach(({ t, side, i }, k) => {
      const p = this.track.getPointAt(t);
      const tan = this.track.getTangentAt(t);
      const n = this.track.getNormalAt(t);
      const heading = Math.atan2(tan.x, tan.z);
      const base = p.clone().addScaledVector(n, side * o);

      dummy.position.copy(base);
      dummy.rotation.set(0, heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(k, dummy.matrix);

      const armCenter = base.clone().addScaledVector(n, -side * 1.6);
      armCenter.y = 9;
      // rotation.y = heading maps local +X onto the track's left normal, so
      // the arm's long axis reaches out over the road.
      dummy.position.copy(armCenter);
      dummy.rotation.set(0, heading, 0);
      dummy.updateMatrix();
      arms.setMatrixAt(k, dummy.matrix);

      const headPos = base.clone().addScaledVector(n, -side * 3.1);
      headPos.y = 8.85;
      dummy.position.copy(headPos);
      dummy.rotation.set(0, heading + Math.PI / 2, 0);
      dummy.updateMatrix();
      heads.setMatrixAt(k, dummy.matrix);
      const c = palette[i % palette.length];
      heads.setColorAt(k, c);

      dummy.position.set(headPos.x, 0.09, headPos.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      pools.setMatrixAt(k, dummy.matrix);
      pools.setColorAt(k, c.clone().multiplyScalar(0.05));
    });
    [poles, arms, heads, pools].forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.group.add(m);
    });
  }

  _buildCheckpointGates() {
    this.gates = [];
    const o = this.track.barrierOffset + 0.7;
    const pylonGeo = new THREE.BoxGeometry(0.55, 7.5, 0.55);
    pylonGeo.translate(0, 3.75, 0);
    const beamGeo = new THREE.BoxGeometry(o * 2 + 0.55, 0.3, 0.3);
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14151e, metalness: 0.8, roughness: 0.4 });

    this.track.checkpoints.forEach((cp) => {
      const g = new THREE.Group();
      const heading = Math.atan2(cp.tangent.x, cp.tangent.z);
      g.position.copy(cp.position);
      g.rotation.y = heading;

      [-o, o].forEach((x) => {
        const pylon = new THREE.Mesh(pylonGeo, darkMat);
        pylon.position.x = x;
        g.add(pylon);
      });
      const beamMat = new THREE.MeshBasicMaterial({ color: neon(COLORS.violet, 3) });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.y = 7.4;
      g.add(beam);
      [-o, o].forEach((x) => {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 7.2, 0.6), beamMat);
        strip.position.set(x - Math.sign(x) * 0.3, 3.75, 0);
        g.add(strip);
      });

      const curtainMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uColor: { value: neon(COLORS.violet, 1.0) }, uFlash: { value: 0 }, uTime: { value: 0 } },
        vertexShader: 'varying vec2 vUv; varying float vDist; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }',
        // The curtain fades out as the camera reaches it, so driving through
        // a gate is a sweep of light rather than a full-screen whiteout.
        fragmentShader: `
          uniform vec3 uColor; uniform float uFlash, uTime; varying vec2 vUv; varying float vDist;
          void main() {
            float scan = 0.6 + 0.4 * sin(vUv.y * 140.0 - uTime * 6.0);
            float fade = smoothstep(0.0, 0.25, vUv.y) * (1.0 - vUv.y * 0.6);
            float edge = smoothstep(0.93, 1.0, abs(vUv.x * 2.0 - 1.0));
            float near = smoothstep(4.0, 22.0, vDist);
            float a = ((0.05 + uFlash * 0.3) * scan * fade + edge * 0.25) * near;
            gl_FragColor = vec4(uColor * a * (1.0 + uFlash * 1.2), 1.0);
          }`
      });
      const curtain = new THREE.Mesh(new THREE.PlaneGeometry(o * 2, 7.2), curtainMat);
      curtain.position.y = 3.6;
      curtain.layers.set(LAYER_NO_REFLECT);
      g.add(curtain);

      this.group.add(g);
      this.gates.push({ group: g, curtainMat, beamMat, flash: 0 });
    });
  }

  _buildBoostPads() {
    this.boostMats = [];
    const w = this.track.width * 0.62;
    this.track.boostPads.forEach((pad) => {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uColor: { value: neon(COLORS.orange, 2.6) } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
          uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
          void main() {
            float x = abs(vUv.x - 0.5) * 2.0;
            float v = fract(vUv.y * 4.0 - x * 0.9 - uTime * 1.8);
            float chevron = smoothstep(0.0, 0.08, v) * smoothstep(0.42, 0.3, v);
            float border = smoothstep(0.9, 0.97, x);
            float fade = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
            float a = (chevron * 0.9 + border * 0.6 + 0.06) * fade;
            gl_FragColor = vec4(uColor * a, 1.0);
          }`
      });
      const geo = new THREE.PlaneGeometry(w, 10);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pad.position).setY(0.075);
      mesh.rotation.y = Math.atan2(pad.tangent.x, pad.tangent.z);
      mesh.layers.set(LAYER_NO_REFLECT);
      this.group.add(mesh);
      this.boostMats.push(mat);
    });
  }

  _buildStartGantry() {
    const t = 0;
    const p = this.track.getPointAt(t);
    const tan = this.track.getTangentAt(t);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = Math.atan2(tan.x, tan.z);

    const o = this.track.barrierOffset + 1.6;
    const dark = new THREE.MeshStandardMaterial({ color: 0x12131b, metalness: 0.85, roughness: 0.35 });
    const pylonGeo = new THREE.BoxGeometry(1.4, 11, 1.4);
    pylonGeo.translate(0, 5.5, 0);
    [-o, o].forEach((x) => {
      const pylon = new THREE.Mesh(pylonGeo, dark);
      pylon.position.x = x;
      g.add(pylon);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 10.5, 1.45), new THREE.MeshBasicMaterial({ color: neon(x < 0 ? COLORS.magenta : COLORS.cyan, 3.5) }));
      strip.position.set(x - Math.sign(x) * 0.7, 5.5, 0);
      g.add(strip);
    });

    const beam = new THREE.Mesh(new THREE.BoxGeometry(o * 2 + 1.4, 2.4, 1.2), dark);
    beam.position.y = 10.4;
    g.add(beam);
    const beamEdge = new THREE.Mesh(new THREE.BoxGeometry(o * 2 + 1.4, 0.1, 1.25), new THREE.MeshBasicMaterial({ color: neon(COLORS.cyan, 3) }));
    beamEdge.position.y = 9.2;
    g.add(beamEdge);

    // Holographic title on the gantry, facing the grid (which approaches from -Z).
    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 1.9),
      new THREE.MeshBasicMaterial({
        map: textTexture(['NEON VECTOR'], { w: 1024, h: 160, font: '900 104px Orbitron, sans-serif', color: '#e8fdff' }),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: neon(0xffffff, 1.6), side: THREE.DoubleSide
      })
    );
    title.position.set(0, 10.55, -0.65);
    title.rotation.y = Math.PI;
    g.add(title);

    // Countdown lamps (5): off -> red one by one -> all green on GO.
    this.startLamps = [];
    const lampGeo = new THREE.CircleGeometry(0.42, 20);
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x220407, side: THREE.DoubleSide });
      const lamp = new THREE.Mesh(lampGeo, mat);
      lamp.position.set((i - 2) * 1.25, 12.2, -0.62);
      lamp.rotation.y = Math.PI;
      g.add(lamp);
      this.startLamps.push(mat);
    }
    const lampHousing = new THREE.Mesh(new THREE.BoxGeometry(7, 1.3, 0.5), dark);
    lampHousing.position.set(0, 12.2, -0.3);
    g.add(lampHousing);

    // Chequered start/finish line on the road.
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 32;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#0b0b10' : '#d8dde8';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
    const lineTex = new THREE.CanvasTexture(c);
    lineTex.colorSpace = THREE.SRGBColorSpace;
    const lineGeo = new THREE.PlaneGeometry(this.track.width, 2);
    lineGeo.rotateX(-Math.PI / 2);
    const line = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ map: lineTex, polygonOffset: true, polygonOffsetFactor: -4 }));
    line.position.y = 0.07;
    line.layers.set(LAYER_NO_REFLECT);
    g.add(line);

    this.group.add(g);
    this.gantry = g;
  }

  // state: 'off' | 1..5 (number of red lamps lit) | 'go'
  setStartLights(state) {
    this.startLamps.forEach((mat, i) => {
      if (state === 'go') mat.color.copy(neon(0x22ff88, 5));
      else if (typeof state === 'number' && i < state) mat.color.copy(neon(COLORS.red, 5));
      else mat.color.setHex(0x220407);
    });
  }

  flashCheckpoint(index) {
    const gate = this.gates[index];
    if (gate) gate.flash = 1;
  }

  update(dt, elapsed) {
    this.boostMats.forEach((m) => { m.uniforms.uTime.value = elapsed; });
    this.gates.forEach((g) => {
      g.flash = Math.max(0, g.flash - dt * 1.6);
      g.curtainMat.uniforms.uFlash.value = g.flash;
      g.curtainMat.uniforms.uTime.value = elapsed;
      g.beamMat.color.setHex(g.flash > 0 ? 0x21fff0 : COLORS.violet).multiplyScalar(3 + g.flash * 4);
    });
  }
}
