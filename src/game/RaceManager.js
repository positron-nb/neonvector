import { CheckpointSystem } from './CheckpointSystem.js';
import { RACE, STORAGE_KEYS } from '../config/settings.js';

export const RacePhase = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished'
};

// Race flow, lap/position tracking and the results payload. UI-agnostic:
// update() returns events that Game.js turns into HUD messages, sounds and
// track effects.
export class RaceManager {
  constructor(track) {
    this.track = track;
    this.totalLaps = RACE.totalLaps;
    this.phase = RacePhase.IDLE;
    this.raceStartTime = 0;
    this.player = null;
    this.aiCars = [];
    this.checkpoints = new CheckpointSystem(track, RACE.checkpointCount);
    this.onFinish = null;
    // Simulation time, advanced by tick(): lap times are exact regardless of
    // frame stalls, and a hidden tab doesn't count toward them.
    this.clockMs = 0;
  }

  tick(dtSeconds) {
    this.clockMs += dtSeconds * 1000;
  }

  registerRacers(player, aiCars) {
    this.player = player;
    this.aiCars = aiCars;
    this.checkpoints = new CheckpointSystem(this.track, RACE.checkpointCount);
    const now = this.clockMs;
    [player, ...aiCars].forEach((car) => {
      const t = this.track.closestPoint(car.state.position).t;
      car.state.trackT = t;
      this.checkpoints.register(car, t, now);
    });
  }

  startCountdown() {
    this.phase = RacePhase.COUNTDOWN;
  }

  beginRacing() {
    this.phase = RacePhase.RACING;
    this.raceStartTime = this.clockMs;
    this.checkpoints.resetClocks(this.raceStartTime);
  }

  update() {
    const events = { lapCompleted: null, finalLap: false, gatePassed: null, finished: false };
    if (this.phase !== RacePhase.RACING) return events;
    const now = this.clockMs;

    [this.player, ...this.aiCars].forEach((car) => {
      const entry = this.checkpoints.get(car);
      if (entry.finished) return;
      const r = this.checkpoints.update(car, car.state.trackT, now);
      if (entry.lap >= this.totalLaps) {
        entry.finished = true;
        entry.finishTime = now - this.raceStartTime;
      }
      if (car !== this.player || !r) return;
      if (r.checkpointChanged) events.gatePassed = entry.checkpointIndex;
      if (r.crossedLine && r.lapTime != null) {
        events.lapCompleted = { lap: entry.lap, time: r.lapTime, best: r.lapTime <= entry.bestLapTime };
        if (entry.lap === this.totalLaps - 1) events.finalLap = true;
      }
    });

    if (this.checkpoints.get(this.player).finished) {
      events.finished = true;
      this.finishRace();
    }
    return events;
  }

  getElapsedMs() {
    if (this.phase === RacePhase.IDLE || this.phase === RacePhase.COUNTDOWN) return 0;
    const entry = this.checkpoints.get(this.player);
    if (entry && entry.finished) return entry.finishTime;
    return this.clockMs - this.raceStartTime;
  }

  getCurrentLapMs() {
    const entry = this.checkpoints.get(this.player);
    if (!entry || this.phase !== RacePhase.RACING) return 0;
    return this.clockMs - entry.lapStartTime;
  }

  getRanking() {
    return this.checkpoints.ranking();
  }

  getPlayerPosition() {
    return this.getRanking().indexOf(this.player) + 1;
  }

  // Race distance of `car` minus the player's (positive = car is ahead).
  gapToPlayer(car) {
    const a = this.checkpoints.get(car);
    const p = this.checkpoints.get(this.player);
    return a && p ? a.totalDistance - p.totalDistance : 0;
  }

  finishRace() {
    if (this.phase === RacePhase.FINISHED) return;
    this.phase = RacePhase.FINISHED;
    const entry = this.checkpoints.get(this.player);
    const totalTimeMs = entry.finishTime;
    const bestLapMs = entry.bestLapTime === Infinity ? totalTimeMs : entry.bestLapTime;

    let previousBest = Infinity;
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.bestLap);
      if (stored) previousBest = parseFloat(stored);
    } catch (e) { /* storage unavailable */ }
    const isNewRecord = bestLapMs < previousBest;
    if (isNewRecord) {
      try { localStorage.setItem(STORAGE_KEYS.bestLap, String(bestLapMs)); } catch (e) { /* ignore */ }
    }

    const result = {
      position: this.getPlayerPosition(),
      totalRacers: this.aiCars.length + 1,
      totalTimeMs,
      bestLapMs,
      lapTimes: entry.lapTimes.slice(),
      topSpeedKmh: this.player.topSpeedKmh,
      driftDistanceM: this.player.driftDistance,
      isNewRecord,
      previousBestMs: previousBest === Infinity ? null : previousBest
    };
    if (this.onFinish) this.onFinish(result);
  }

  reset() {
    this.phase = RacePhase.IDLE;
  }
}
