import * as THREE from 'three';
import { PHYSICS } from '../config/settings.js';

// Shared arcade vehicle physics — tuned for "feels great to drive", not
// realism. All smoothing is frame-rate independent so handling is identical
// at 30, 60 or 144 fps.
export class VehicleState {
  constructor(position) {
    this.position = position.clone();
    this.heading = 0;          // world yaw (radians)
    this.speed = 0;            // signed m/s along heading
    this.steerAngle = 0;       // front-wheel angle (radians)
    this.velocity = new THREE.Vector3();
    this.isDrifting = false;
    this.driftAngle = 0;       // heading vs. actual travel direction
    this.driftDistance = 0;
    this.lateralG = 0;
    this.longAccel = 0;        // m/s^2, for chassis pitch
    this.wheelSpin = 0;
    this.trackT = undefined;   // last known track position (search hint)
  }
}

const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * @param {VehicleState} state
 * @param {{throttle:number, brake:number, steer:number, handbrake:boolean, nitroActive:boolean, maxSpeedScale?:number}} c
 */
export function stepVehicle(state, c, dt) {
  const prevSpeed = state.speed;
  const maxSpeed = (c.nitroActive ? PHYSICS.nitroMaxSpeed : PHYSICS.maxSpeed) * (c.maxSpeedScale || 1);

  if (c.throttle > 0.02) {
    const accel = PHYSICS.acceleration + (c.nitroActive ? PHYSICS.nitroForce : 0);
    // Acceleration tapers near top speed so it feels like the engine is working.
    const taper = 1 - Math.pow(THREE.MathUtils.clamp(state.speed / maxSpeed, 0, 1), 3) * 0.7;
    if (state.speed < maxSpeed) state.speed += accel * c.throttle * taper * dt;
  } else if (c.brake > 0.02) {
    if (state.speed > 0.5) state.speed -= PHYSICS.brakeDeceleration * c.brake * dt;
    else state.speed -= PHYSICS.reverseAcceleration * c.brake * dt;
  } else {
    const decel = PHYSICS.coastDeceleration * dt;
    state.speed = Math.abs(state.speed) < decel ? 0 : state.speed - Math.sign(state.speed) * decel;
  }
  if (c.handbrake && Math.abs(state.speed) > 3) state.speed -= Math.sign(state.speed) * 4 * dt;

  // Above the cap (e.g. nitro just ended): bleed off smoothly, no hard clamp.
  if (state.speed > maxSpeed) state.speed = maxSpeed + (state.speed - maxSpeed) * Math.exp(-1.4 * dt);
  state.speed = Math.max(state.speed, -PHYSICS.maxSpeed * 0.35);

  // Steering: speed-sensitive authority, extra bite while drifting.
  const speedRatio = THREE.MathUtils.clamp(Math.abs(state.speed) / PHYSICS.maxSpeed, 0, 1.4);
  const targetSteer = c.steer * PHYSICS.maxSteerAngle * (1 - Math.min(speedRatio, 1) * 0.42);
  state.steerAngle += (targetSteer - state.steerAngle) * (1 - Math.exp(-PHYSICS.steerSpeed * 2.5 * dt));
  const authority = c.handbrake ? PHYSICS.driftSteerBoost : 1;
  // Yaw-rate curve: ~7 m turning circle at parking speed, ~30 m at 110 km/h,
  // ~70 m flat out.
  const v = Math.abs(state.speed);
  const turnFactor = v < 8 ? v / 8 : 1 + ((v - 8) / 60) * 0.4;
  const turnRate = state.steerAngle * authority * PHYSICS.turnRateBase * turnFactor * Math.sign(state.speed || 1);
  state.heading += turnRate * dt;

  // Grip: velocity chases the heading; low grip under handbrake = drift.
  _fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
  _desired.copy(_fwd).multiplyScalar(state.speed);
  const grip = c.handbrake ? PHYSICS.driftGrip : PHYSICS.normalGrip;
  const k = 1 - Math.pow(1 - grip, dt * 60);
  state.velocity.lerp(_desired, k);

  if (state.velocity.lengthSq() > 0.4) {
    _dir.copy(state.velocity).normalize();
    const dot = THREE.MathUtils.clamp(_fwd.dot(_dir), -1, 1);
    const cross = _fwd.x * _dir.z - _fwd.z * _dir.x;
    state.driftAngle = Math.sign(cross) * Math.acos(dot);
  } else {
    state.driftAngle = 0;
  }
  state.isDrifting = Math.abs(state.driftAngle) > 0.12 && Math.abs(state.speed) > 8;
  if (state.isDrifting) state.driftDistance += Math.abs(state.speed) * dt;

  state.lateralG = Math.abs(turnRate * state.speed) / 9.81;
  state.longAccel = (state.speed - prevSpeed) / Math.max(dt, 1e-4);

  state.position.addScaledVector(state.velocity, dt);
  state.wheelSpin += state.speed * dt / 0.43;
}

// Circle-vs-circle car contact. Returns the impact speed (0 if no contact).
export function resolveCarCollision(a, b, radius) {
  const dx = a.position.x - b.position.x;
  const dz = a.position.z - b.position.z;
  const dist = Math.hypot(dx, dz);
  const minDist = radius * 2;
  if (dist <= 0 || dist >= minDist) return 0;
  const nx = dx / dist, nz = dz / dist;
  const overlap = (minDist - dist) / 2;
  a.position.x += nx * overlap; a.position.z += nz * overlap;
  b.position.x -= nx * overlap; b.position.z -= nz * overlap;
  const relV = (a.velocity.x - b.velocity.x) * nx + (a.velocity.z - b.velocity.z) * nz;
  if (relV < 0) {
    const impulse = -relV * 0.55;
    a.velocity.x += nx * impulse; a.velocity.z += nz * impulse;
    b.velocity.x -= nx * impulse; b.velocity.z -= nz * impulse;
    a.speed *= 0.93;
    b.speed *= 0.93;
  }
  return Math.max(0, -relV);
}

const _out = new THREE.Vector3();
const _tanFwd = new THREE.Vector3();

// Keeps the car inside the barriers. On contact the car slides along the
// wall, losing speed in proportion to how square-on it hit.
export function constrainToTrack(state, track, dt) {
  const closest = track.closestPoint(state.position, state.trackT);
  state.trackT = closest.t;
  const limit = track.barrierOffset - PHYSICS.carRadius;
  let wallHit = 0;
  let wallNormal = null;

  if (closest.distance > limit) {
    _out.subVectors(state.position, closest.point).setY(0).normalize(); // outward
    state.position.copy(closest.point).addScaledVector(_out, limit);
    state.position.y = 0;

    const into = state.velocity.dot(_out);
    if (into > 0) {
      state.velocity.addScaledVector(_out, -into * (1 + PHYSICS.wallBounce));
      _fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
      const squareness = Math.abs(_fwd.dot(_out));
      state.speed *= 1 - PHYSICS.wallImpactLoss * squareness * Math.min(1, into / 20);
      wallHit = into;
    }
    state.speed -= Math.sign(state.speed) * PHYSICS.wallScrapeDecel * dt;

    // Nudge the nose parallel to the wall so the car slides instead of sticking.
    _tanFwd.copy(closest.tangent);
    if (_tanFwd.dot(_fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading))) < 0) _tanFwd.negate();
    const target = Math.atan2(_tanFwd.x, _tanFwd.z);
    let diff = target - state.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    state.heading += diff * Math.min(1, 6 * dt);
    wallNormal = _out.clone().negate();
  }
  return { ...closest, wallHit, wallNormal };
}
