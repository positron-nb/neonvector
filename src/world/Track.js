import * as THREE from 'three';

// Closed-loop circuit defined by a centripetal Catmull-Rom spline. Everything
// else (road mesh, barriers, checkpoints, AI waypoints, city placement,
// tunnel/overpasses) derives from this single source of truth.
//
// Layout (t = normalised distance along the lap):
//   0.00-0.11  start/finish straight (grid sits just behind t=0)
//   0.12-0.35  long right-hand sweeper
//   0.37-0.45  chicane
//   0.45-0.60  fast esses onto the back straight
//   0.61-0.80  back straight — neon tunnel 0.625-0.735, overpass at 0.77
//   0.80-0.89  hairpin
//   0.90-0.97  final corner onto the main straight (overpass at 0.045)
const CONTROL_POINTS = [
  [0, 0], [0, -150], [15, -240], [70, -300], [150, -312], [222, -282], [252, -220], [248, -150],
  [214, -98], [224, -38], [266, 10], [272, 92], [236, 152], [160, 176], [70, 182], [-20, 186],
  [-92, 176], [-150, 150], [-168, 100], [-132, 68], [-74, 84], [-24, 78], [-2, 44]
];

export class Track {
  constructor() {
    this.width = 16;
    this.barrierOffset = this.width / 2 + 0.6;

    const pts = CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();

    this.sampleCount = 1800;
    this.samples = this.curve.getSpacedPoints(this.sampleCount);
    this.tangents = this.samples.map((_, i) => this.curve.getTangentAt(i / this.sampleCount).normalize());

    this.tunnel = { start: 0.625, end: 0.735 };
    this.overpasses = [0.045, 0.77];

    this._buildCheckpoints(10);
    this.boostPads = [0.3, 0.505, 0.612, 0.9].map((t) => ({
      t,
      position: this.getPointAt(t),
      tangent: this.getTangentAt(t),
      used: new Set()
    }));
  }

  _buildCheckpoints(count) {
    // Offset by half a segment so no gate sits on the start/finish line.
    this.checkpoints = [];
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      this.checkpoints.push({ index: i, t, position: this.getPointAt(t), tangent: this.getTangentAt(t) });
    }
  }

  // Nearest point on the centreline. Searches a local window around `hintT`
  // when given (the common per-frame case), otherwise the whole table.
  closestPoint(position, hintT) {
    const n = this.sampleCount;
    let bestDist = Infinity;
    let bestIdx = 0;
    if (hintT !== undefined) {
      const center = Math.round(hintT * n);
      for (let k = -60; k <= 60; k++) {
        const i = ((center + k) % n + n) % n;
        const d = this.samples[i].distanceToSquared(position);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      // A car teleported (reset) far from the hint: fall back to a full scan.
      if (bestDist > 900) return this.closestPoint(position);
    } else {
      for (let i = 0; i < n; i++) {
        const d = this.samples[i].distanceToSquared(position);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    }
    return {
      point: this.samples[bestIdx],
      tangent: this.tangents[bestIdx],
      distance: Math.sqrt(bestDist),
      t: bestIdx / n
    };
  }

  wrap(t) {
    return ((t % 1) + 1) % 1;
  }

  getPointAt(t) {
    return this.curve.getPointAt(this.wrap(t));
  }

  getTangentAt(t) {
    return this.curve.getTangentAt(this.wrap(t)).normalize();
  }

  // Unit vector pointing to the LEFT of the direction of travel (x/z plane).
  getNormalAt(t) {
    const tan = this.getTangentAt(t);
    return new THREE.Vector3(tan.z, 0, -tan.x);
  }

  getLookaheadPoint(t, dist) {
    return this.getPointAt(t + dist / this.length);
  }

  // Degrees of heading change over the next `dist` metres — used by the AI to
  // brake for corners.
  turnAhead(t, dist) {
    const a = this.getTangentAt(t);
    const b = this.getTangentAt(t + dist / this.length);
    return Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * 180 / Math.PI;
  }

  isInTunnel(t) {
    return t >= this.tunnel.start && t <= this.tunnel.end;
  }
}
