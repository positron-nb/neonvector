import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem.js';
import { COLORS, neon } from '../config/settings.js';

// Shared particle pools for all cars: exhaust/nitro plasma, tyre smoke and
// impact sparks. Three draw calls total regardless of car count.
export class VehicleEffects {
  constructor(scene, quality) {
    const pool = quality.particlePoolSize;
    this.exhaust = new ParticleSystem(scene, { maxParticles: pool * 2, drag: 0.94, softness: 1.4 });
    this.smoke = new ParticleSystem(scene, { maxParticles: pool, blending: THREE.NormalBlending, drag: 0.95, softness: 0.6 });
    this.sparks = new ParticleSystem(scene, { maxParticles: pool, gravity: -18, drag: 0.985, softness: 0.2 });

    this._v = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c0 = new THREE.Color();
    this._c1 = new THREE.Color();
    this.warm0 = neon(0xffc070, 2.2);
    this.warm1 = neon(COLORS.orange, 0.4);
    this.smokeColor = new THREE.Color(0.16, 0.15, 0.2);
    this.smokeEnd = new THREE.Color(0.06, 0.05, 0.09);
    this.sparkHot = neon(0xfff2c0, 6);
    this.sparkCool = neon(COLORS.orange, 1.5);
  }

  // Per car, per frame. `car` needs: parts.exhaustAnchors, parts.accent,
  // state.velocity, state.heading, fxAccum (object for spawn accumulators).
  emitExhaust(car, dt, throttle, nitro) {
    const acc = car.fxAccum || (car.fxAccum = { exhaust: 0, smoke: 0 });
    const rate = nitro ? 110 : 10 + throttle * 26;
    acc.exhaust += rate * dt;
    const back = this._v.set(-Math.sin(car.state.heading), 0, -Math.cos(car.state.heading));
    while (acc.exhaust >= 1) {
      acc.exhaust -= 1;
      const anchor = car.parts.exhaustAnchors[Math.random() < 0.5 ? 0 : 1];
      anchor.getWorldPosition(this._p);
      const spread = nitro ? 1.2 : 0.4;
      const speed = nitro ? 14 + Math.random() * 8 : 2.5 + Math.random() * 2;
      const vel = this._vel.set(
        back.x * speed + car.state.velocity.x * 0.85 + (Math.random() - 0.5) * spread,
        Math.random() * 0.8,
        back.z * speed + car.state.velocity.z * 0.85 + (Math.random() - 0.5) * spread
      );
      if (nitro) {
        this._c0.copy(car.parts.accent).multiplyScalar(1.3);
        this._c1.copy(car.parts.accent).multiplyScalar(0.15);
        this.exhaust.spawn(this._p, vel, 0.28 + Math.random() * 0.22, 0.55, 1.6, this._c0, this._c1);
      } else {
        this.exhaust.spawn(this._p, vel, 0.25 + Math.random() * 0.2, 0.25, 0.8, this.warm0, this.warm1);
      }
    }
  }

  emitSmoke(car, dt, amount) {
    const acc = car.fxAccum || (car.fxAccum = { exhaust: 0, smoke: 0 });
    acc.smoke += amount * 70 * dt;
    while (acc.smoke >= 1) {
      acc.smoke -= 1;
      // Rear wheels.
      const wheel = car.parts.wheels[2 + (Math.random() < 0.5 ? 0 : 1)];
      wheel.getWorldPosition(this._p);
      this._p.y = 0.3;
      const vel = this._vel.set((Math.random() - 0.5) * 3, 0.8 + Math.random() * 1.2, (Math.random() - 0.5) * 3)
        .addScaledVector(car.state.velocity, 0.25);
      this.smoke.spawn(this._p, vel, 0.9 + Math.random() * 0.6, 0.9, 4.2, this.smokeColor, this.smokeEnd);
    }
  }

  // Burst of sparks at a contact point; `normal` points away from the surface.
  emitSparks(position, normal, carVelocity, intensity = 1) {
    const n = Math.floor(8 + intensity * 24);
    for (let i = 0; i < n; i++) {
      const vel = this._vel.set(
        normal.x * (2 + Math.random() * 6) + carVelocity.x * 0.6 + (Math.random() - 0.5) * 6,
        2 + Math.random() * 6,
        normal.z * (2 + Math.random() * 6) + carVelocity.z * 0.6 + (Math.random() - 0.5) * 6
      );
      this.sparks.spawn(position, vel, 0.35 + Math.random() * 0.45, 0.16, 0.05, this.sparkHot, this.sparkCool);
    }
  }

  setProjection(bufferHeight, fovDeg) {
    const scale = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    [this.exhaust, this.smoke, this.sparks].forEach((s) => { s.material.uniforms.uScale.value = scale; });
  }

  update(dt) {
    this.exhaust.update(dt);
    this.smoke.update(dt);
    this.sparks.update(dt);
  }
}
