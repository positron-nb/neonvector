import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, neon } from '../config/settings.js';
import { buildStrip, buildWall, placeAlong } from './ribbon.js';

// Large set pieces that give the circuit landmarks: a neon-ringed tunnel on
// the back straight and elevated highways crossing overhead with traffic.
export class Structures {
  constructor(track) {
    this.track = track;
    this.curve = track.curve;
    this.group = new THREE.Group();
    this.traffic = [];
    this._tmp = {
      m: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      qBack: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      one: new THREE.Vector3(1, 1, 1)
    };
    this._buildTunnel();
    track.overpasses.forEach((t) => this._buildOverpass(t));
  }

  _buildTunnel() {
    const { start, end } = this.track.tunnel;
    const len = this.track.length * (end - start);
    const segments = Math.ceil(len / 1.5);
    const halfW = this.track.barrierOffset + 1.6;
    const height = 9.5;

    const shellMat = new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.75, metalness: 0.3, side: THREE.DoubleSide });
    this.group.add(new THREE.Mesh(buildStrip(this.curve, { segments, a: -halfW, b: halfW, y: height, tStart: start, tEnd: end }), shellMat));
    [halfW, -halfW].forEach((off) => {
      this.group.add(new THREE.Mesh(buildWall(this.curve, { segments, offset: off, y0: 0, y1: height, tStart: start, tEnd: end }), shellMat));
    });

    // Continuous light strips along the walls.
    [[halfW - 0.05, COLORS.cyan], [-halfW + 0.05, COLORS.magenta]].forEach(([off, color]) => {
      [[1.4, 1.55], [7.6, 7.72]].forEach(([y0, y1]) => {
        this.group.add(new THREE.Mesh(
          buildWall(this.curve, { segments, offset: off, y0, y1, tStart: start, tEnd: end }),
          new THREE.MeshBasicMaterial({ color: neon(color, 2.2), side: THREE.DoubleSide })
        ));
      });
    });

    // Ring frames every ~9 m, each with an inset neon strip that pulses in a
    // wave running in the direction of travel.
    const ringCount = Math.floor(len / 9);
    const beam = (w, h, d, x, y) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, 0); return g; };
    const frameGeo = mergeGeometries([
      beam(1.1, height, 1.1, -halfW + 0.55, height / 2),
      beam(1.1, height, 1.1, halfW - 0.55, height / 2),
      beam(halfW * 2, 1.1, 1.1, 0, height - 0.55)
    ]);
    const stripGeo = mergeGeometries([
      beam(0.14, height - 1.4, 1.14, -halfW + 1.12, (height - 1.4) / 2),
      beam(0.14, height - 1.4, 1.14, halfW - 1.12, (height - 1.4) / 2),
      beam(halfW * 2 - 2.2, 0.14, 1.14, 0, height - 1.12)
    ]);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x15161f, roughness: 0.4, metalness: 0.85 });
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const frames = new THREE.InstancedMesh(frameGeo, frameMat, ringCount);
    this.ringStrips = new THREE.InstancedMesh(stripGeo, stripMat, ringCount);
    placeAlong(this.curve, { count: ringCount, tStart: start + 2 / this.track.length, tEnd: end - 2 / this.track.length, closed: false })
      .forEach(({ matrix }, i) => {
        frames.setMatrixAt(i, matrix);
        this.ringStrips.setMatrixAt(i, matrix);
        this.ringStrips.setColorAt(i, new THREE.Color(0, 0, 0));
      });
    frames.instanceMatrix.needsUpdate = true;
    this.ringStrips.instanceMatrix.needsUpdate = true;
    this.group.add(frames, this.ringStrips);
    this.ringCount = ringCount;
    this._ringColor = new THREE.Color();

    // Portal sign above the entrance, facing oncoming cars.
    const p = this.track.getPointAt(start);
    const tan = this.track.getTangentAt(start);
    const sign = this._portalSign('SECTOR 07 // UNDERPASS', halfW * 2 + 2);
    sign.position.copy(p).setY(height + 1.4);
    sign.rotation.y = Math.atan2(tan.x, tan.z) + Math.PI;
    this.group.add(sign);
  }

  _portalSign(text, width) {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(10,6,20,0.9)';
    g.fillRect(0, 0, 1024, 128);
    g.strokeStyle = '#ff2bd6';
    g.lineWidth = 6;
    g.strokeRect(6, 6, 1012, 116);
    g.font = '700 64px Orbitron, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = '#ff2bd6';
    g.shadowBlur = 18;
    g.fillStyle = '#ffe6fb';
    g.fillText(text, 512, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(width, width / 8), new THREE.MeshBasicMaterial({ map: tex, color: neon(0xffffff, 1.5) }));
  }

  _buildOverpass(t) {
    const p = this.track.getPointAt(t);
    const tan = this.track.getTangentAt(t);
    const n = this.track.getNormalAt(t);
    const angle = Math.atan2(n.x, n.z); // deck runs along the track normal (crosses the road)
    const deckLen = 300;
    const deckY = 17;

    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = angle;

    const concrete = new THREE.MeshStandardMaterial({ color: 0x111219, roughness: 0.7, metalness: 0.35 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(14, 1.6, deckLen), concrete);
    deck.position.y = deckY;
    g.add(deck);
    [-7.2, 7.2].forEach((x, i) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, deckLen), concrete);
      rail.position.set(x, deckY + 1.35, 0);
      g.add(rail);
      const railLight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, deckLen), new THREE.MeshBasicMaterial({ color: neon(i ? COLORS.cyan : COLORS.orange, 3) }));
      railLight.position.set(x, deckY + 1.9, 0);
      g.add(railLight);
      const under = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.08, deckLen), new THREE.MeshBasicMaterial({ color: neon(i ? COLORS.magenta : COLORS.violet, 3.2) }));
      under.position.set(x * 0.8, deckY - 0.85, 0);
      g.add(under);
    });

    // Pillars: skip any that would land on another part of the circuit.
    const pillarGeo = new THREE.BoxGeometry(2.2, deckY - 0.8, 2.2);
    pillarGeo.translate(0, (deckY - 0.8) / 2, 0);
    const world = new THREE.Vector3();
    [-128, -96, -64, -32, -15, 15, 32, 64, 96, 128].forEach((z) => {
      world.set(0, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(p);
      if (this.track.closestPoint(world).distance < this.track.barrierOffset + 3) return;
      const pillar = new THREE.Mesh(pillarGeo, concrete);
      pillar.position.z = z;
      g.add(pillar);
    });

    // Traffic: head/tail light pairs streaming both ways across the deck.
    const count = 28;
    const carGeo = new THREE.BoxGeometry(1.6, 0.5, 3.6);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0c0d12, metalness: 0.7, roughness: 0.4 });
    const bodies = new THREE.InstancedMesh(carGeo, bodyMat, count);
    const lightGeo = new THREE.BoxGeometry(1.4, 0.18, 0.1);
    const lights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), count * 2);
    const cars = [];
    for (let i = 0; i < count; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      cars.push({ z: (Math.random() - 0.5) * deckLen, x: dir * (2.2 + (i % 4 < 2 ? 0 : 3)), dir, speed: 16 + Math.random() * 14 });
      lights.setColorAt(i * 2, dir > 0 ? neon(0xe8f6ff, 4) : neon(COLORS.red, 4));
      lights.setColorAt(i * 2 + 1, dir > 0 ? neon(COLORS.red, 3) : neon(0xe8f6ff, 4));
    }
    lights.instanceColor.needsUpdate = true;
    g.add(bodies, lights);
    this.traffic.push({ cars, bodies, lights, deckLen, deckY });

    this.group.add(g);
  }

  update(dt, elapsed) {
    // Tunnel wave: a bright pulse sweeps through the rings every ~1.6 s.
    if (this.ringStrips) {
      for (let i = 0; i < this.ringCount; i++) {
        const phase = (i / this.ringCount) * 4 - elapsed * 2.4;
        const pulse = Math.pow(0.5 + 0.5 * Math.cos(phase * Math.PI * 2), 6);
        const base = i % 2 === 0 ? COLORS.cyan : COLORS.magenta;
        this._ringColor.setHex(base).multiplyScalar(1.6 + pulse * 5);
        this.ringStrips.setColorAt(i, this._ringColor);
      }
      this.ringStrips.instanceColor.needsUpdate = true;
    }

    const { m, pos, q, qBack, one } = this._tmp;
    this.traffic.forEach(({ cars, bodies, lights, deckLen, deckY }) => {
      cars.forEach((c, i) => {
        c.z += c.dir * c.speed * dt;
        if (c.z > deckLen / 2) c.z -= deckLen;
        if (c.z < -deckLen / 2) c.z += deckLen;
        const rot = c.dir > 0 ? q.identity() : qBack;
        pos.set(c.x, deckY + 1.05, c.z);
        bodies.setMatrixAt(i, m.compose(pos, rot, one));
        pos.set(c.x, deckY + 1.0, c.z + c.dir * 1.82);
        lights.setMatrixAt(i * 2, m.compose(pos, rot, one));
        pos.set(c.x, deckY + 1.0, c.z - c.dir * 1.82);
        lights.setMatrixAt(i * 2 + 1, m.compose(pos, rot, one));
      });
      bodies.instanceMatrix.needsUpdate = true;
      lights.instanceMatrix.needsUpdate = true;
    });
  }
}
