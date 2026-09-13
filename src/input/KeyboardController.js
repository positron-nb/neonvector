// Raw keyboard state tracker + derived control values. Always active so the
// game remains fully playable without the ESP32 controller.
export class KeyboardController {
  constructor() {
    this.keys = new Set();
    this.steer = 0;

    this._onKeyDown = (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  // One-shot "just pressed" helpers use a small edge-detection cache.
  consumeJustPressed(code) {
    if (this._justPressed && this._justPressed.has(code)) {
      this._justPressed.delete(code);
      return true;
    }
    return false;
  }

  update(dt, steerSpeed) {
    const left = this.isDown('KeyA', 'ArrowLeft');
    const right = this.isDown('KeyD', 'ArrowRight');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const lerp = 1 - Math.exp(-steerSpeed * dt);
    this.steer += (target - this.steer) * lerp;
    if (Math.abs(this.steer) < 0.01 && target === 0) this.steer = 0;
  }

  getControls() {
    const throttle = this.isDown('KeyW', 'ArrowUp') ? 1 : 0;
    const brake = this.isDown('KeyS', 'ArrowDown') ? 1 : 0;
    const handbrake = this.isDown('Space');
    const nitro = this.isDown('ShiftLeft', 'ShiftRight');
    return { throttle, brake, steer: this.steer, handbrake, nitroRequested: nitro };
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
