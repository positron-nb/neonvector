// Tracks each racer's progress: lap, checkpoint, and a monotonically
// increasing race distance (lap * length + t * length) used for positions.
//
// The grid sits just BEHIND the start/finish line (t ~ 0.99), so racers start
// on lap -1; crossing the line at the start makes it lap 0 without recording
// a bogus lap time.
export class CheckpointSystem {
  constructor(track, checkpointCount = 10) {
    this.track = track;
    this.checkpointCount = checkpointCount;
    this.entries = new Map();
  }

  register(entity, startT, nowMs) {
    this.entries.set(entity, {
      lastT: startT,
      lap: startT > 0.5 ? -1 : 0,
      checkpointIndex: ((Math.floor(startT * this.checkpointCount - 0.5) % this.checkpointCount) + this.checkpointCount) % this.checkpointCount,
      totalDistance: 0,
      lapStartTime: nowMs,
      lapTimes: [],
      bestLapTime: Infinity,
      finished: false,
      finishTime: null
    });
  }

  resetClocks(nowMs) {
    this.entries.forEach((e) => { e.lapStartTime = nowMs; });
  }

  // Returns { crossedLine, lapTime, checkpointChanged } for UI/audio hooks.
  update(entity, currentT, nowMs) {
    const e = this.entries.get(entity);
    if (!e) return null;
    const result = { crossedLine: false, lapTime: null, checkpointChanged: false };

    if (e.lastT > 0.85 && currentT < 0.15) {
      if (e.lap >= 0) {
        const lapTime = nowMs - e.lapStartTime;
        e.lapTimes.push(lapTime);
        if (lapTime < e.bestLapTime) e.bestLapTime = lapTime;
        result.lapTime = lapTime;
      }
      e.lap += 1;
      e.lapStartTime = nowMs;
      result.crossedLine = true;
    } else if (e.lastT < 0.15 && currentT > 0.85) {
      // Reversed back over the line.
      e.lap -= 1;
    }

    // Gates sit at t = (i + 0.5) / count, so this is the last gate passed.
    const n = this.checkpointCount;
    const cpIdx = ((Math.floor(currentT * n - 0.5) % n) + n) % n;
    if (cpIdx !== e.checkpointIndex) {
      e.checkpointIndex = cpIdx;
      result.checkpointChanged = true;
    }

    e.lastT = currentT;
    e.totalDistance = (e.lap + currentT) * this.track.length;
    return result;
  }

  get(entity) {
    return this.entries.get(entity);
  }

  // Finished racers first (by finish time), then by distance covered.
  ranking() {
    return [...this.entries.entries()]
      .sort((a, b) => {
        const ea = a[1], eb = b[1];
        if (ea.finished && eb.finished) return ea.finishTime - eb.finishTime;
        if (ea.finished) return -1;
        if (eb.finished) return 1;
        return eb.totalDistance - ea.totalDistance;
      })
      .map(([entity]) => entity);
  }
}
