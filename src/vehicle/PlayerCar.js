import * as THREE from 'three';
import { buildCarMesh } from './CarMesh.js';
import { VehicleState, stepVehicle, constrainToTrack } from './Physics.js';
import { PHYSICS, COLORS } from '../config/settings.js';

export class PlayerCar {
  constructor(scene, track, fx, startPosition, startHeading = 0) {
    this.track = track;
    this.fx = fx;
    this.parts = buildCarMesh({ bodyColor: 0x3a4a6a, accentColor: COLORS.cyan, headlights: true });
    this.object3D = this.parts.root;
    scene.add(this.object3D);

    this.state = new VehicleState(startPosition);
    this.state.heading = startHeading;
    this.nitro = 1;
    this.nitroActive = false;
    this.topSpeedKmh = 0;
    this.driftDistance = 0;
    this.lastWall = { wallHit: 0 };
    this._pitch = 0;
    this._roll = 0;
    this._syncTransform();
  }

  reset(position, heading) {
    this.state = new VehicleState(position);
    this.state.heading = heading;
    this.nitro = 1;
    this.nitroActive = false;
    this._syncTransform();
  }

  // Put the car back on the track centre, facing the right way (R key).
  recover() {
    const c = this.track.closestPoint(this.state.position, this.state.trackT);
    const heading = Math.atan2(c.tangent.x, c.tangent.z);
    const t = c.t;
    this.state = new VehicleState(c.point.clone());
    this.state.heading = heading;
    this.state.trackT = t;
    this._syncTransform();
  }

  _syncTransform() {
    this.object3D.position.copy(this.state.position);
    this.object3D.rotation.y = this.state.heading;
  }

  update(dt, controls, elapsed, raceActive = true) {
    const canNitro = controls.nitroRequested && this.nitro > (this.nitroActive ? 0 : PHYSICS.nitroMinToActivate);
    this.nitroActive = raceActive && canNitro && controls.throttle > 0.1;
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - PHYSICS.nitroDrainPerSec * dt);
    else this.nitro = Math.min(1, this.nitro + PHYSICS.nitroRechargePerSec * dt);

    if (raceActive) {
      stepVehicle(this.state, { ...controls, nitroActive: this.nitroActive }, dt);
      this.lastWall = constrainToTrack(this.state, this.track, dt);
    }
    this._syncTransform();
    this._animate(dt, controls, elapsed);

    const kmh = Math.abs(this.state.speed) * 3.6;
    if (kmh > this.topSpeedKmh) this.topSpeedKmh = kmh;
    this.driftDistance = this.state.driftDistance;
    return this.lastWall;
  }

  _animate(dt, controls, elapsed) {
    const p = this.parts;
    const s = this.state;

    // Weight transfer: squat under power, dive under braking, roll in corners.
    const targetPitch = THREE.MathUtils.clamp(-s.longAccel / 40, -1, 1) * 0.035;
    const targetRoll = THREE.MathUtils.clamp(s.steerAngle * (Math.abs(s.speed) / PHYSICS.maxSpeed), -1, 1) * -0.05;
    const k = 1 - Math.exp(-8 * dt);
    this._pitch += (targetPitch - this._pitch) * k;
    this._roll += (targetRoll - this._roll) * k;
    p.chassis.rotation.set(this._pitch, 0, this._roll);

    p.wheels.forEach((w) => { w.rotation.x = s.wheelSpin; });
    p.steerPivots.forEach((pivot) => { pivot.rotation.y = s.steerAngle; });

    const braking = controls.brake > 0.05 && s.speed > 0.5;
    p.tailMat.color.setHex(0xff1a2e).multiplyScalar(braking ? 7 : 2.2);

    const speedRatio = Math.abs(s.speed) / PHYSICS.maxSpeed;
    p.underMat.color.copy(p.accent).multiplyScalar(0.12 + speedRatio * 0.08 + (this.nitroActive ? 0.18 : 0));

    const flicker = 0.85 + Math.random() * 0.3;
    p.flames.forEach((f) => {
      const on = this.nitroActive ? 1 : (controls.throttle > 0.95 && speedRatio > 0.6 ? 0.25 : 0);
      const len = this.nitroActive ? 1.1 + Math.random() * 0.5 : 0.45;
      f.scale.set(on ? 1.1 : 0.001, on ? 1.1 : 0.001, on ? len : 0.001);
      f.material.uniforms.uIntensity.value = on * flicker * 1.6;
      f.material.uniforms.uTime.value = elapsed;
    });

    this.fx.emitExhaust(this, dt, Math.max(controls.throttle, 0), this.nitroActive);
    if (s.isDrifting) this.fx.emitSmoke(this, dt, Math.min(1, Math.abs(s.driftAngle) * 2));
  }

  get speedKmh() {
    return Math.abs(this.state.speed) * 3.6;
  }
}
