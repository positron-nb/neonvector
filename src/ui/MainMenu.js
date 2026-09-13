import { Screen } from '../game/GameState.js';
import { STORAGE_KEYS } from '../config/settings.js';

function loadStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v : fallback;
  } catch (e) { return fallback; }
}

function saveStored(key, val) {
  try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
}

// Wires up all the DOM "screen" panels (menu, how-to-play, settings,
// controller/calibration, results) that live outside the HUD.
export class MainMenu {
  constructor(gameState, callbacks = {}) {
    this.gameState = gameState;
    this.callbacks = callbacks;

    this.screens = {
      [Screen.MENU]: document.getElementById('screen-menu'),
      [Screen.HOWTO]: document.getElementById('screen-howto'),
      [Screen.SETTINGS]: document.getElementById('screen-settings'),
      [Screen.CONTROLLER]: document.getElementById('screen-controller'),
      [Screen.RESULTS]: document.getElementById('screen-results'),
      [Screen.COUNTDOWN]: document.getElementById('screen-countdown'),
      [Screen.RACING]: document.getElementById('screen-hud')
    };

    this._previousMenuScreen = Screen.MENU;

    this._restoreSettings();
    this._bindMenuButtons();
    this._bindSettingsControls();
    this._bindControllerControls();

    gameState.on('screen', (s) => this._onScreenChange(s));
    this._onScreenChange(gameState.screen);
  }

  _restoreSettings() {
    this.gameState.quality = loadStored(STORAGE_KEYS.quality, 'medium');
    this.gameState.audioOn = loadStored(STORAGE_KEYS.audio, 'on') !== 'off';
    this.gameState.sensitivity = parseFloat(loadStored(STORAGE_KEYS.sensitivity, '1.3'));
    this.gameState.wsUrl = loadStored(STORAGE_KEYS.wsUrl, this.gameState.wsUrl);

    document.querySelectorAll('#quality-select button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.value === this.gameState.quality);
    });
    document.querySelectorAll('#audio-select button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.value === (this.gameState.audioOn ? 'on' : 'off'));
    });
    document.getElementById('sensitivity-slider').value = this.gameState.sensitivity;
    document.getElementById('ws-url-input').value = this.gameState.wsUrl;
  }

  _bindMenuButtons() {
    document.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.dataset.action;
        this.callbacks.onAnyClick?.();
        switch (action) {
          case 'start': this.callbacks.onStart?.(); break;
          case 'controller': this._previousMenuScreen = Screen.MENU; this.gameState.setScreen(Screen.CONTROLLER); break;
          case 'settings': this._previousMenuScreen = Screen.MENU; this.gameState.setScreen(Screen.SETTINGS); break;
          case 'howto': this._previousMenuScreen = Screen.MENU; this.gameState.setScreen(Screen.HOWTO); break;
          case 'back': this.gameState.setScreen(Screen.MENU); break;
          case 'connect': this.callbacks.onConnect?.(document.getElementById('ws-url-input').value.trim()); break;
          case 'calibrate': this.callbacks.onCalibrate?.(); break;
          case 'race-again': this.callbacks.onRaceAgain?.(); break;
          case 'menu': this.gameState.setScreen(Screen.MENU); break;
          default: break;
        }
      });
    });
  }

  _bindSettingsControls() {
    document.querySelectorAll('#quality-select button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#quality-select button').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        this.gameState.quality = b.dataset.value;
        saveStored(STORAGE_KEYS.quality, b.dataset.value);
        this.callbacks.onQualityChange?.(b.dataset.value);
      });
    });

    document.querySelectorAll('#audio-select button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#audio-select button').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        const on = b.dataset.value === 'on';
        this.gameState.audioOn = on;
        saveStored(STORAGE_KEYS.audio, b.dataset.value);
        this.callbacks.onAudioChange?.(on);
      });
    });

    const slider = document.getElementById('sensitivity-slider');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      this.gameState.sensitivity = v;
      saveStored(STORAGE_KEYS.sensitivity, String(v));
      this.callbacks.onSensitivityChange?.(v);
    });
  }

  _bindControllerControls() {
    const urlInput = document.getElementById('ws-url-input');
    urlInput.addEventListener('change', () => saveStored(STORAGE_KEYS.wsUrl, urlInput.value.trim()));
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing a URL must not steer the car / cycle cameras
      if (e.key === 'Enter') this.callbacks.onConnect?.(urlInput.value.trim());
    });

    const steer = document.getElementById('invert-steer');
    const pitch = document.getElementById('invert-pitch');
    steer.checked = loadStored(STORAGE_KEYS.invertSteer, '0') === '1';
    pitch.checked = loadStored(STORAGE_KEYS.invertPitch, '0') === '1';
    const apply = () => {
      saveStored(STORAGE_KEYS.invertSteer, steer.checked ? '1' : '0');
      saveStored(STORAGE_KEYS.invertPitch, pitch.checked ? '1' : '0');
      this.callbacks.onInvertChange?.({ steer: steer.checked, pitch: pitch.checked });
    };
    steer.addEventListener('change', apply);
    pitch.addEventListener('change', apply);
    this.invert = { steer: steer.checked, pitch: pitch.checked };
  }

  _onScreenChange(screen) {
    Object.values(this.screens).forEach((el) => el && el.classList.remove('active'));
    if (this.screens[screen]) this.screens[screen].classList.add('active');
  }

  setControllerStatus(link, latencyMs, rateHz, url, socketOpen) {
    const online = link !== 'offline';
    const pill = document.getElementById('menu-controller-status');
    const wasOnline = pill.classList.contains('online') || pill.classList.contains('weak');
    pill.classList.toggle('online', link === 'online');
    pill.classList.toggle('weak', link === 'weak');
    pill.querySelector('.label').textContent =
      link === 'online' ? 'CONTROLLER ONLINE'
        : link === 'weak' ? 'CONTROLLER — SIGNAL WEAK'
          : 'CONTROLLER OFFLINE — KEYBOARD ACTIVE';
    if (online && !wasOnline) {
      pill.classList.remove('link-up');
      void pill.offsetWidth;
      pill.classList.add('link-up');
    }

    const statusEl = document.getElementById('controller-detail-status');
    statusEl.textContent =
      link === 'online' ? 'CONNECTED'
        : link === 'weak' ? 'SIGNAL WEAK'
          : socketOpen ? 'LINKED — NO SENSOR DATA' : `SEARCHING ${url ? url.replace('ws://', '') : ''}`;
    statusEl.style.color = link === 'online' ? '#21ffb0' : link === 'weak' ? '#ffb020' : '#ff2b4d';

    document.getElementById('controller-latency').textContent = online && latencyMs != null ? `${Math.round(latencyMs)} ms` : '-- ms';
    document.getElementById('controller-rate').textContent = online && rateHz ? `${rateHz.toFixed(1)} hz` : '-- hz';
  }

  // Live controller readout + tilt reticle on the CONTROLLER screen.
  setControllerLive({ roll, pitch, steer, throttle, brake, online }) {
    const angles = document.getElementById('controller-angles');
    const output = document.getElementById('controller-output');
    if (!online) {
      angles.textContent = '-- / --';
      output.textContent = '-- / --';
      return;
    }
    angles.textContent = `${roll.toFixed(1)}° / ${pitch.toFixed(1)}°`;
    const pedal = throttle > 0 ? `+${Math.round(throttle * 100)}%` : brake > 0 ? `BRAKE ${Math.round(brake * 100)}%` : '0%';
    output.textContent = `${steer >= 0 ? '+' : ''}${steer.toFixed(2)} / ${pedal}`;
    document.getElementById('preview-dot').style.transform = `translate(${steer * 60}px, ${(brake - throttle) * 60}px)`;
    document.getElementById('preview-horizon').style.transform = `rotate(${-roll}deg)`;
  }

  setResults(result, suffix) {
    document.getElementById('results-title').textContent = result.position === 1 ? 'VICTORY' : 'RACE COMPLETE';
    document.getElementById('res-pos-big').textContent = String(result.position);
    document.getElementById('res-pos-suffix').textContent = suffix;
    document.getElementById('res-pos').textContent = `${result.position} / ${result.totalRacers}`;
    document.getElementById('res-time').textContent = formatTime(result.totalTimeMs);
    document.getElementById('res-topspeed').textContent = `${Math.round(result.topSpeedKmh)} KM/H`;
    document.getElementById('res-bestlap').textContent = formatTime(result.bestLapMs);
    document.getElementById('res-drift').textContent = `${Math.round(result.driftDistanceM)} M`;
    document.getElementById('res-laps').innerHTML = (result.lapTimes || [])
      .map((t, i) => `L${i + 1} ${formatTime(t)}`).join('<br>') || '--';
    document.getElementById('res-record').classList.toggle('hidden', !result.isNewRecord);
  }
}

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00.00';
  // Work in whole centiseconds so 59.999 s can't render as "00:60.00".
  const cs = Math.floor(ms / 10);
  const minutes = Math.floor(cs / 6000);
  const seconds = Math.floor((cs % 6000) / 100);
  const hundredths = cs % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
