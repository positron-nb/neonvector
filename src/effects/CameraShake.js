// Small utility that accumulates shake "trauma" and produces a decaying
// procedural offset each frame — used for collisions and nitro kick.
export class CameraShake {
  constructor() {
    this.trauma = 0;
    this.decay = 1.6;
    this.maxOffset = 0.35;
    this.time = 0;
  }

  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - this.decay * dt);
    }
    const t2 = this.trauma * this.trauma;
    const offsetX = this.maxOffset * t2 * Math.sin(this.time * 37.1);
    const offsetY = this.maxOffset * t2 * Math.cos(this.time * 29.3);
    const roll = 0.05 * t2 * Math.sin(this.time * 19.7);
    return { x: offsetX, y: offsetY, roll };
  }
}
