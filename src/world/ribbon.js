import * as THREE from 'three';

// Geometry builders that sweep simple profiles along the track spline.
// Lateral offsets are measured along the track's LEFT normal (positive = left
// of the direction of travel).

function frames(curve, segments, tStart, tEnd) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = tStart + (tEnd - tStart) * (i / segments);
    const tw = ((t % 1) + 1) % 1;
    const p = curve.getPointAt(tw);
    const tan = curve.getTangentAt(tw).normalize();
    out.push({ p, n: new THREE.Vector3(tan.z, 0, -tan.x), tan, dist: i });
  }
  return out;
}

// Flat horizontal strip between lateral offsets a and b at height y.
// uv.x runs across (0..1), uv.y runs along in metres * uvScale.
export function buildStrip(curve, { segments, a, b, y = 0, tStart = 0, tEnd = 1, uvScale = 1 }) {
  const f = frames(curve, segments, tStart, tEnd);
  const len = curve.getLength() * (tEnd - tStart);
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const indices = [];
  f.forEach(({ p, n }, i) => {
    const pa = p.clone().addScaledVector(n, a);
    const pb = p.clone().addScaledVector(n, b);
    positions.set([pa.x, y, pa.z, pb.x, y, pb.z], i * 6);
    normals.set([0, 1, 0, 0, 1, 0], i * 6);
    const v = (i / segments) * len * uvScale;
    uvs.set([0, v, 1, v], i * 4);
    if (i < segments) {
      const k = i * 2;
      // Winding chosen so the face normal points up for a < b... flip if needed.
      if (a > b) indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      else indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// Vertical wall at lateral offset between heights y0 and y1 (double-sided use).
export function buildWall(curve, { segments, offset, y0, y1, tStart = 0, tEnd = 1, uvScale = 1 }) {
  const f = frames(curve, segments, tStart, tEnd);
  const len = curve.getLength() * (tEnd - tStart);
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  f.forEach(({ p, n }, i) => {
    const q = p.clone().addScaledVector(n, offset);
    positions.set([q.x, y0, q.z, q.x, y1, q.z], i * 6);
    const v = (i / segments) * len * uvScale;
    uvs.set([v, 0, v, 1], i * 4);
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Places `count` transforms evenly along [tStart, tEnd], each oriented to the
// track (local +Z = direction of travel, local +X = left), with a lateral
// offset and height.
export function placeAlong(curve, { count, tStart = 0, tEnd = 1, offset = 0, y = 0, closed = true }) {
  const mats = [];
  const dummy = new THREE.Object3D();
  const steps = closed && tEnd - tStart >= 1 ? count : Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const t = tStart + (tEnd - tStart) * (i / steps);
    const tw = ((t % 1) + 1) % 1;
    const p = curve.getPointAt(tw);
    const tan = curve.getTangentAt(tw).normalize();
    const n = new THREE.Vector3(tan.z, 0, -tan.x);
    dummy.position.copy(p).addScaledVector(n, offset);
    dummy.position.y = y;
    dummy.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
    dummy.updateMatrix();
    mats.push({ matrix: dummy.matrix.clone(), t: tw, position: dummy.position.clone(), heading: dummy.rotation.y });
  }
  return mats;
}
