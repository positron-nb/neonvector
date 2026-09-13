import { KeyboardController } from './KeyboardController.js';
import { MPUController } from './MPUController.js';
import { INPUT } from '../config/settings.js';

// Merges keyboard and MPU inputs into one control stream. Both sources are
// always live — keyboard never gets disabled — so the game stays playable
// the instant the ESP32 drops off Wi-Fi (per the hardware fallback requirement).
export class InputManager {
  constructor() {
    this.keyboard = new KeyboardController();
    this.mpu = new MPUController();
    this.nitroHoldUntil = 0;
    this.resetRequested = false;
    this.cameraCycleRequested = false;

    this._onKeyDownExtra = (e) => {
      if (e.code === 'KeyR') this.resetRequested = true;
      if (e.code === 'KeyC') this.cameraCycleRequested = true;
    };
    window.addEventListener('keydown', this._onKeyDownExtra);
  }

  setSensitivity(v) {
    this.mpu.setSensitivity(v);
  }

  update(dt) {
    this.keyboard.update(dt, INPUT.keyboardSteerSpeed);
    this.mpu.update(dt);
  }

  consumeReset() {
    if (this.resetRequested) { this.resetRequested = false; return true; }
    return false;
  }

  consumeCameraCycle() {
    if (this.cameraCycleRequested) { this.cameraCycleRequested = false; return true; }
    return false;
  }

  isControllerConnected() {
    return this.mpu.connected;
  }

  getControls() {
    const kb = this.keyboard.getControls();
    const mpu = this.mpu.getControls();

    const now = performance.now();
    if (kb.nitroRequested || mpu.nitroRequested) {
      this.nitroHoldUntil = now + 1500;
    }

    const steer = Math.max(-1, Math.min(1, kb.steer + mpu.steer));
    const throttle = Math.max(kb.throttle, mpu.throttle);
    const brake = Math.max(kb.brake, mpu.brake);
    const handbrake = kb.handbrake;
    const nitroRequested = now < this.nitroHoldUntil;

    return { throttle, brake, steer, handbrake, nitroRequested };
  }

  dispose() {
    this.keyboard.dispose();
    window.removeEventListener('keydown', this._onKeyDownExtra);
  }
}
