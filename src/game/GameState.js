import { NETWORK } from '../config/settings.js';

export const Screen = {
  MENU: 'menu',
  HOWTO: 'howto',
  SETTINGS: 'settings',
  CONTROLLER: 'controller',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  RESULTS: 'results'
};

// Tiny observable store for cross-cutting UI/game state (avoids prop-drilling
// between Game, UI screens, input and network layers).
export class GameState {
  constructor() {
    this.screen = Screen.MENU;
    this.quality = 'medium';
    this.audioOn = true;
    this.sensitivity = 1.3;
    this.wsUrl = NETWORK.defaultUrl;

    this.controllerConnected = false;
    this.controllerLatencyMs = null;
    this.controllerRateHz = null;

    this._listeners = {};
  }

  on(event, cb) {
    (this._listeners[event] ||= []).push(cb);
    return () => {
      this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== cb);
    };
  }

  emit(event, payload) {
    (this._listeners[event] || []).forEach((cb) => cb(payload));
  }

  setScreen(screen) {
    this.screen = screen;
    this.emit('screen', screen);
  }
}
