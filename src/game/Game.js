import * as THREE from 'three';

import { GameState, Screen } from './GameState.js';
import { RaceManager, RacePhase } from './RaceManager.js';
import { Track } from '../world/Track.js';
import { Road } from '../world/Road.js';
import { City } from '../world/City.js';
import { Structures } from '../world/Structures.js';
import { Environment } from '../world/Environment.js';
import { LAYER_NO_REFLECT } from '../world/WetSurface.js';
import { PlayerCar } from '../vehicle/PlayerCar.js';
import { AICar } from '../vehicle/AICar.js';
import { resolveCarCollision } from '../vehicle/Physics.js';
import { InputManager } from '../input/InputManager.js';
import { WebSocketManager } from '../network/WebSocketManager.js';
import { CameraShake } from '../effects/CameraShake.js';
import { SpeedLines } from '../effects/SpeedLines.js';
import { PostFX } from '../effects/PostFX.js';
import { VehicleEffects } from '../effects/VehicleEffects.js';
import { MainMenu } from '../ui/MainMenu.js';
import { CalibrationScreen } from '../ui/CalibrationScreen.js';
import { HUD, ordinal } from '../ui/HUD.js';
import { AudioManager } from '../audio/AudioManager.js';
import { QUALITY_PRESETS, RACE, PHYSICS, STORAGE_KEYS } from '../config/settings.js';

const CAMERA_MODES = ['chase', 'low', 'cockpit'];
const BASE_FOV = 64;
const COUNTDOWN_STEPS = [
  { at: 0.0, text: '', sub: 'GET READY', lamps: 'off' },
  { at: 1.3, text: '3', sub: '', lamps: 2, beep: true },
  { at: 2.3, text: '2', sub: '', lamps: 4, beep: true },
  { at: 3.3, text: '1', sub: '', lamps: 5, beep: true },
  { at: 4.3, text: 'GO', sub: '', lamps: 'go', go: true }
];
const COUNTDOWN_LENGTH = 4.3;

function storedQuality() {
  try {
    const q = localStorage.getItem(STORAGE_KEYS.quality);
    return QUALITY_PRESETS[q] ? q : 'medium';
  } catch (e) {
    return 'medium';
  }
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = new GameState();
    this.state.quality = storedQuality();
    this.quality = QUALITY_PRESETS[this.state.quality];
    this.clock = new THREE.Clock();
    this.elapsed = 0;

    this.input = new InputManager();
    this.ws = new WebSocketManager();
    this.audio = new AudioManager();
    this.calibrationScreen = new CalibrationScreen();
    this.cameraShake = new CameraShake();

    this._setupRenderer();
    this.track = new Track();
    this.structures = new Structures(this.track);
    this.scene.add(this.structures.group);
    this._buildQualityWorld();
    this._setupRacers();
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this._setupUI();
    this.speedLines = new SpeedLines();

    this.ws.onPacket = (packet) => this.input.mpu.onPacket(packet);
    this.ws.onUrlConnected = (url) => this._rememberControllerUrl(url);
    // A tab opened in the background waits until it is shown (see below).
    if (!document.hidden) this.ws.connect(this.state.wsUrl);

    this.cameraModeIndex = 0;
    this._camHeading = 0;
    this._countdownT = -1;
    this._countdownStep = -1;
    this._dynScale = 1;
    this._perf = { acc: 0, frames: 0, timer: 0 };

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && (this.state.screen === Screen.RACING || this.state.screen === Screen.COUNTDOWN)) this._abortToMenu();
    });
    // A hidden tab stops reading its socket; the ESP32 then sees a stalled
    // client that holds a connection slot and memory. So a hidden game hands
    // the controller back, and reconnects instantly when visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.silenceLoops();
        this.clock.stop();
        this._hiddenDisconnect = setTimeout(() => this.ws.disconnect(), 1500);
      } else {
        clearTimeout(this._hiddenDisconnect);
        this.clock.start();
        if (this.ws.manuallyClosed) this.ws.connect(this.state.wsUrl);
      }
    });

    this._onResize();
    this._placeOnGrid();
    this._animate = this._animate.bind(this);
    this.clock.start();
    requestAnimationFrame(this._animate);
  }

  // ---------------------------------------------------------------- setup --

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._basePixelRatio = Math.min(window.devicePixelRatio, this.quality.pixelRatioCap);
    this.renderer.setPixelRatio(this._basePixelRatio);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 1500);
    this.camera.layers.enable(LAYER_NO_REFLECT);
    this.camera.position.set(0, 8, 30);
  }

  // Everything whose cost depends on the quality preset; rebuilt on change.
  _buildQualityWorld() {
    const q = this.quality;
    this.environment = new Environment(this.scene, this.camera, this.renderer, q);
    this.road = new Road(this.track, this.environment.wet);
    this.scene.add(this.road.group);
    this.city = new City(this.track, q);
    this.scene.add(this.city.group);
    if (this.fx) this.fx.dispose?.();
    this.fx = new VehicleEffects(this.scene, q);
    if (this.player) [this.player, ...this.aiCars].forEach((c) => { c.fx = this.fx; });
  }

  _disposeQualityWorld() {
    this.environment.dispose();
    this.scene.remove(this.road.group);
    this.scene.remove(this.city.group);
    this.city.dispose();
    [this.fx.exhaust, this.fx.smoke, this.fx.sparks].forEach((s) => { this.scene.remove(s.points); s.dispose(); });
  }

  _gridSlot(row, lateral) {
    const t = 1 - (10 + row * 9) / this.track.length;
    const p = this.track.getPointAt(t);
    const tan = this.track.getTangentAt(t);
    const n = this.track.getNormalAt(t);
    return { position: p.clone().addScaledVector(n, lateral), heading: Math.atan2(tan.x, tan.z) };
  }

  _setupRacers() {
    const p = this._gridSlot(1, -3.6);
    this.player = new PlayerCar(this.scene, this.track, this.fx, p.position, p.heading);
    this.aiCars = [
      ['aggressive', 0, 3.6],
      ['balanced', 0, -3.6],
      ['unstable', 1, 3.6]
    ].map(([profile, row, lat]) => {
      const g = this._gridSlot(row, lat);
      return new AICar(this.scene, this.track, this.fx, g.position, g.heading, profile);
    });
    this.allCars = [this.player, ...this.aiCars];
    this.raceManager = new RaceManager(this.track);
    this.raceManager.onFinish = (result) => this._onRaceFinish(result);
  }

  _placeOnGrid() {
    const p = this._gridSlot(1, -3.6);
    this.player.reset(p.position, p.heading);
    this.player.topSpeedKmh = 0;
    this.player.driftDistance = 0;
    [[0, 3.6], [0, -3.6], [1, 3.6]].forEach(([row, lat], i) => {
      const g = this._gridSlot(row, lat);
      this.aiCars[i].reset(g.position, g.heading);
    });
    this.raceManager.registerRacers(this.player, this.aiCars);
    this.track.boostPads.forEach((pad) => pad.used.clear());
  }

  _setupUI() {
    this.mainMenu = new MainMenu(this.state, {
      onAnyClick: () => { this.audio.unlock(); this.audio.uiClick(); },
      onStart: () => this._startRaceSequence(),
      onConnect: (url) => this.ws.connect(url || this.state.wsUrl),
      onCalibrate: () => this._startCalibration(),
      onQualityChange: (q) => this._onQualityChange(q),
      onAudioChange: (on) => this.audio.setEnabled(on),
      onSensitivityChange: (v) => this.input.setSensitivity(v),
      onInvertChange: (inv) => this.input.mpu.setInvert(inv),
      onRaceAgain: () => this._startRaceSequence()
    });
    this.input.setSensitivity(this.state.sensitivity);
    this.input.mpu.setInvert(this.mainMenu.invert);
    this.audio.setEnabled(this.state.audioOn);
    this.hud = new HUD(this.track);
    this.state.on('screen', (s) => {
      this.postfx.setMenuMode(s !== Screen.RACING && s !== Screen.COUNTDOWN);
      if (s !== Screen.RACING) { this.audio.setSkid(0); this.audio.setScrape(0); this.hud.setWrongWay(false); }
    });
  }

  _rememberControllerUrl(url) {
    this.state.wsUrl = url;
    try { localStorage.setItem(STORAGE_KEYS.wsUrl, url); } catch (e) { /* storage unavailable */ }
    const input = document.getElementById('ws-url-input');
    if (input && document.activeElement !== input) input.value = url;
  }

  _startCalibration() {
    if (!this.input.mpu.connected) {
      this.hud.showMessage('NO CONTROLLER', 'CONNECT FIRST');
      document.getElementById('controller-detail-status').textContent = 'CONNECT CONTROLLER FIRST';
      return;
    }
    this.input.mpu.startCalibration();
    this.calibrationScreen.show();
  }

  _onQualityChange(name) {
    this.state.quality = name;
    this.quality = QUALITY_PRESETS[name];
    this._disposeQualityWorld();
    this._buildQualityWorld();
    this.postfx.applyQuality(this.quality);
    this._basePixelRatio = Math.min(window.devicePixelRatio, this.quality.pixelRatioCap);
    this._dynScale = 1;
    this._applyPixelRatio();
  }

  // ------------------------------------------------------------ race flow --

  _startRaceSequence() {
    this.audio.unlock();
    this._placeOnGrid();
    this.raceManager.startCountdown();
    this.state.setScreen(Screen.COUNTDOWN);
    this._countdownT = 0;
    this._countdownStep = -1;
    this.road.setStartLights('off');
    this._lastLap = -1;
    this.cameraModeIndex = 0;
  }

  _updateCountdown(dt) {
    this._countdownT += dt;
    const next = COUNTDOWN_STEPS[this._countdownStep + 1];
    if (next && this._countdownT >= next.at) {
      this._countdownStep++;
      const el = document.getElementById('countdown-number');
      const sub = document.getElementById('countdown-sub');
      el.textContent = next.text;
      sub.textContent = next.sub;
      el.classList.remove('pop', 'go');
      void el.offsetWidth;
      if (next.text) el.classList.add(next.go ? 'go' : 'pop');
      this.road.setStartLights(next.lamps);
      if (next.beep) { this.audio.countdownBeep(false); this.audio.rev(); this.cameraShake.addTrauma(0.12); }
      if (next.go) {
        this.audio.countdownBeep(true);
        this.cameraShake.addTrauma(0.5);
        this.postfx.triggerFlash(0.5);
        this.raceManager.beginRacing();
        this.state.setScreen(Screen.RACING);
        this.hud.showMessage('GO', '', 'final');
        // Launch boost for everyone off the line.
        this.allCars.forEach((c) => { c.state.speed = 6; });
      }
    }
  }

  _abortToMenu() {
    this.raceManager.reset();
    this.audio.silenceLoops();
    this.state.setScreen(Screen.MENU);
    this._placeOnGrid();
  }

  _onRaceFinish(result) {
    this.audio.finishFanfare();
    this.audio.silenceLoops();
    this.postfx.triggerFlash(0.6);
    this.mainMenu.setResults(result, ordinal(result.position));
    this.hud.showMessage('FINISH', '', 'final', 3);
    setTimeout(() => {
      if (this.raceManager.phase === RacePhase.FINISHED) this.state.setScreen(Screen.RESULTS);
    }, 1800);
  }

  // ---------------------------------------------------------------- loop --

  _animate() {
    requestAnimationFrame(this._animate);
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    this.elapsed += dt;
    const elapsed = this.elapsed;

    this.input.update(dt);
    this._syncControllerStatus();
    this._handleCalibrationUi();

    if (this.input.consumeCameraCycle()) this.cameraModeIndex = (this.cameraModeIndex + 1) % CAMERA_MODES.length;
    const screen = this.state.screen;
    if (this.input.consumeReset() && screen === Screen.RACING) this.player.recover();

    if (screen === Screen.RACING) {
      this._updateRace(dt, elapsed);
      this._updateChaseCamera(dt);
    } else if (screen === Screen.COUNTDOWN) {
      this._updateCountdown(dt);
      this._updateIdleCars(dt, elapsed);
      this._updateCountdownCamera(dt);
      this._updateWorld(dt, elapsed, this.player.state.position, null);
    } else {
      this._updateIdleCars(dt, elapsed);
      if (screen === Screen.RESULTS) this._updateResultsCamera(elapsed);
      else this._updateMenuCamera(dt, elapsed);
      this._updateWorld(dt, elapsed, this.camera.position, null);
      this.audio.updateEngine(0, false, 0);
    }

    const racing = screen === Screen.RACING;
    const speedRatio = Math.abs(this.player.state.speed) / PHYSICS.maxSpeed;
    this.postfx.update(dt, {
      speedRatio: racing ? speedRatio : 0,
      nitro: racing && this.player.nitroActive,
      trauma: this.cameraShake.trauma,
      time: elapsed
    });
    this.speedLines.update(dt, racing ? (this.player.nitroActive ? 0.9 : Math.max(0, speedRatio - 0.7) * 1.6) : 0);
    this.postfx.render();

    this._adaptResolution(rawDt, screen);
  }

  _updateWorld(dt, elapsed, focus, carVelocity) {
    this.road.update(dt, elapsed);
    this.city.update(dt, elapsed);
    this.structures.update(dt, elapsed);
    const inTunnel = this.player.state.trackT !== undefined && this.track.isInTunnel(this.player.state.trackT);
    this.environment.rainVisibility = inTunnel && this.state.screen === Screen.RACING ? 0 : 1;
    this.environment.update(dt, elapsed, this.camera.position, carVelocity);
    this.fx.update(dt);
  }

  _updateIdleCars(dt, elapsed) {
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitroRequested: false };
    this.player.update(dt, idle, elapsed, false);
    this.aiCars.forEach((ai) => ai.update(dt, this.allCars, elapsed, false));
  }

  _syncControllerStatus() {
    const link = this.input.mpu.getLinkState();
    const latency = this.ws.connected ? this.ws.latencyMs : null;
    const rate = this.input.mpu.getPacketRateHz();
    this.state.controllerConnected = link !== 'offline';

    const now = performance.now();
    if (this.state.screen === Screen.CONTROLLER || this.state.screen === Screen.RACING) {
      const p = this.input.mpu.peek();
      if (this.state.screen === Screen.CONTROLLER) this.mainMenu.setControllerLive(p);
      else if (p.online) this.hud.setMotion(p.steer, p.brake - p.throttle, p.roll);
    }
    if (link === this._lastLink && now - (this._lastStatusPaint || 0) < 250) return;
    this._lastLink = link;
    this._lastStatusPaint = now;
    this.mainMenu.setControllerStatus(link, latency, rate, this.ws.url, this.ws.connected);
    this.hud.setConnection(link, latency);
  }

  _handleCalibrationUi() {
    const overlay = this.calibrationScreen.overlay;
    if (this.input.mpu.isCalibrating()) {
      this.calibrationScreen.setProgress(this.input.mpu.getCalibrationProgress());
      this._calibrating = true;
    } else if (this._calibrating) {
      this._calibrating = false;
      this.calibrationScreen.setProgress(1);
      document.querySelector('#calibration-overlay .calib-title').textContent =
        this.input.mpu.hasCalibration && this.input.mpu.connected ? 'CALIBRATION SAVED' : 'CALIBRATION FAILED — CONTROLLER LOST';
      setTimeout(() => {
        overlay.classList.add('hidden');
        document.querySelector('#calibration-overlay .calib-title').textContent = 'CALIBRATING CONTROLLER…';
        this.calibrationScreen.setProgress(0);
      }, 1400);
    }
  }

  _updateRace(dt, elapsed) {
    const controls = this.input.getControls();
    const player = this.player;
    const wasNitro = player.nitroActive;

    const wall = player.update(dt, controls, elapsed, true);
    if (!wasNitro && player.nitroActive) {
      this.audio.nitroWhoosh();
      this.cameraShake.addTrauma(0.3);
      this.postfx.triggerFlash(0.25);
    }
    if (wall.wallNormal) {
      if (wall.wallHit > 3) {
        const contact = player.state.position.clone().addScaledVector(wall.wallNormal, -PHYSICS.carRadius);
        contact.y = 0.5;
        this.fx.emitSparks(contact, wall.wallNormal, player.state.velocity, Math.min(1.5, wall.wallHit / 12));
        this.cameraShake.addTrauma(Math.min(0.6, wall.wallHit / 25));
        this.audio.collision(Math.min(1, wall.wallHit / 20));
      } else if (Math.abs(player.state.speed) > 10 && Math.random() < dt * 30) {
        const contact = player.state.position.clone().addScaledVector(wall.wallNormal, -PHYSICS.carRadius);
        contact.y = 0.4;
        this.fx.emitSparks(contact, wall.wallNormal, player.state.velocity, 0.15);
      }
    }
    this.audio.setScrape(wall.wallNormal ? Math.min(1, Math.abs(player.state.speed) / 30) : 0);

    // Rubber-banding keeps the pack close enough to be interesting on stage.
    this.aiCars.forEach((ai) => {
      const gap = this.raceManager.gapToPlayer(ai);
      const band = THREE.MathUtils.clamp(1 - gap / 1600, 0.9, 1.09);
      ai.update(dt, this.allCars, elapsed, true, band);
    });

    for (let i = 0; i < this.allCars.length; i++) {
      for (let j = i + 1; j < this.allCars.length; j++) {
        const a = this.allCars[i], b = this.allCars[j];
        const impact = resolveCarCollision(a.state, b.state, PHYSICS.carRadius);
        if (impact > 2 && (a === player || b === player)) {
          const mid = a.state.position.clone().add(b.state.position).multiplyScalar(0.5).setY(0.6);
          const n = new THREE.Vector3().subVectors(a.state.position, b.state.position).setY(0).normalize();
          this.fx.emitSparks(mid, n, player.state.velocity, Math.min(1.2, impact / 10));
          this.cameraShake.addTrauma(Math.min(0.5, impact / 18));
          this.audio.collision(Math.min(1, impact / 15));
        }
      }
    }

    this.allCars.forEach((car) => this._checkBoostPads(car));
    this._updateWorld(dt, elapsed, player.state.position, player.state.velocity);

    this.raceManager.tick(dt);
    const events = this.raceManager.update();
    this._handleRaceEvents(events);

    // Wrong-way warning.
    const tan = this.track.getTangentAt(player.state.trackT ?? 0);
    const fwdDot = Math.sin(player.state.heading) * tan.x + Math.cos(player.state.heading) * tan.z;
    this.hud.setWrongWay(fwdDot < -0.35 && Math.abs(player.state.speed) > 4);

    const speedRatio = Math.abs(player.state.speed) / PHYSICS.maxSpeed;
    this.audio.updateEngine(speedRatio, player.nitroActive, controls.throttle);
    this.audio.setSkid(player.state.isDrifting ? Math.min(1, Math.abs(player.state.driftAngle) * 2) : 0);

    if (this.raceManager.phase === RacePhase.RACING || this.raceManager.phase === RacePhase.FINISHED) this._updateHud();
  }

  _handleRaceEvents(events) {
    if (events.gatePassed !== null) {
      this.road.flashCheckpoint(events.gatePassed);
      this.audio.checkpoint();
    }
    if (events.lapCompleted) {
      const { lap, time, best } = events.lapCompleted;
      const label = events.finalLap ? 'FINAL LAP' : lap < this.raceManager.totalLaps ? `LAP ${lap + 1}` : '';
      if (label) this.hud.showMessage(label, `${best ? 'BEST ' : ''}${this._fmt(time)}`, events.finalLap ? 'final' : '', 2);
      this.audio.lapChime(best);
      this.postfx.triggerFlash(0.2);
    }
  }

  _fmt(ms) {
    const cs = Math.floor(ms / 10);
    return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  }

  _updateHud() {
    const rm = this.raceManager;
    const entry = rm.checkpoints.get(this.player);
    const ranking = rm.getRanking();
    const standings = ranking.map((car) => {
      const isPlayer = car === this.player;
      const gap = isPlayer ? 0 : rm.gapToPlayer(car);
      car._hudColor = car._hudColor || (isPlayer ? '#21f3ff' : `#${car.parts.accent.clone().multiplyScalar(1 / 3.4).getHexString()}`);
      return {
        name: isPlayer ? 'YOU' : car.name,
        isPlayer,
        color: car._hudColor,
        gap: isPlayer ? '—' : `${gap > 0 ? '+' : ''}${Math.round(gap)} M`
      };
    });
    const t = this.player.state.trackT ?? 0;
    this.hud.update({
      speedKmh: this.player.speedKmh,
      nitroActive: this.player.nitroActive,
      position: ranking.indexOf(this.player) + 1,
      totalRacers: this.allCars.length,
      lap: entry.lap,
      elapsedMs: rm.getElapsedMs(),
      lapMs: rm.getCurrentLapMs(),
      bestLapMs: entry.bestLapTime,
      // Gates sit at (i + 0.5) / count along the lap.
      checkpointsThisLap: entry.lap < 0 ? 0 : Math.min(RACE.checkpointCount, Math.floor(t * RACE.checkpointCount + 0.5)),
      nitro: this.player.nitro,
      gForce: this.player.state.lateralG,
      driftAngleDeg: THREE.MathUtils.radToDeg(this.player.state.driftAngle),
      standings,
      player: this.player,
      aiCars: this.aiCars
    });
  }

  _checkBoostPads(car) {
    this.track.boostPads.forEach((pad) => {
      const dx = car.state.position.x - pad.position.x;
      const dz = car.state.position.z - pad.position.z;
      const along = Math.abs(dx * pad.tangent.x + dz * pad.tangent.z);
      const across = Math.abs(dx * pad.tangent.z - dz * pad.tangent.x);
      const on = along < 5 && across < this.track.width * 0.33;
      if (on && !pad.used.has(car)) {
        pad.used.add(car);
        car.state.speed = Math.min(Math.max(car.state.speed, 0) + 16, PHYSICS.nitroMaxSpeed);
        if (car === this.player) {
          this.cameraShake.addTrauma(0.22);
          this.postfx.triggerFlash(0.18);
          this.audio.boostPad();
          this.hud.showMessage('BOOST', '', '', 0);
        }
      } else if (!on && along > 12) {
        pad.used.delete(car);
      }
    });
  }

  // -------------------------------------------------------------- cameras --

  _applyCameraShake(dt) {
    const s = this.cameraShake.update(dt);
    this.camera.position.x += s.x;
    this.camera.position.y += s.y;
    return s;
  }

  _updateChaseCamera(dt) {
    const car = this.player;
    const s = car.state;
    const mode = CAMERA_MODES[this.cameraModeIndex];

    // Camera yaw lags the car and leans toward the direction of travel, so
    // corners and drifts read clearly without the view snapping around.
    // s.heading is unbounded (it accumulates through laps) while atan2 is in
    // [-pi, pi], so every angle difference must be wrapped before blending.
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    let slip = 0;
    if (s.velocity.lengthSq() > 25) slip = wrap(Math.atan2(s.velocity.x, s.velocity.z) - s.heading);
    const target = s.heading + slip * 0.55;
    let d = target - this._camHeading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this._camHeading += d * (1 - Math.exp(-(mode === 'cockpit' ? 14 : 5.5) * dt));

    const fwd = new THREE.Vector3(Math.sin(this._camHeading), 0, Math.cos(this._camHeading));
    const carFwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    const speedRatio = Math.min(1.4, Math.abs(s.speed) / PHYSICS.maxSpeed);
    const nitro = car.nitroActive ? 1 : 0;

    let pos, look, fov;
    if (mode === 'chase') {
      const dist = 6.4 + speedRatio * 1.3 + nitro * 1.0;
      pos = car.object3D.position.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, 2.4 + speedRatio * 0.3, 0));
      // Against a wall the car is angled into it, so "behind the car" is
      // outside the barrier. Fall back to "behind along the track".
      if (car.lastWall.wallNormal) {
        const tan = this.track.getTangentAt(s.trackT);
        if (tan.dot(carFwd) < 0) tan.negate();
        pos = car.object3D.position.clone().addScaledVector(tan, -dist).add(new THREE.Vector3(0, 3.2, 0));
      }
      look = car.object3D.position.clone().addScaledVector(carFwd, 6).add(new THREE.Vector3(0, 1.2, 0));
      fov = BASE_FOV + speedRatio * 9 + nitro * 16;
    } else if (mode === 'low') {
      pos = car.object3D.position.clone().addScaledVector(fwd, -5.4).add(new THREE.Vector3(0, 0.85, 0));
      look = car.object3D.position.clone().addScaledVector(carFwd, 10).add(new THREE.Vector3(0, 0.9, 0));
      fov = BASE_FOV + 6 + speedRatio * 11 + nitro * 16;
    } else {
      pos = car.object3D.position.clone().addScaledVector(carFwd, 0.15).add(new THREE.Vector3(0, 1.12, 0));
      look = car.object3D.position.clone().addScaledVector(carFwd, 20).add(new THREE.Vector3(0, 1.0, 0));
      fov = BASE_FOV - 2 + speedRatio * 7 + nitro * 12;
    }

    const follow = mode === 'cockpit' ? 1 : 1 - Math.exp(-14 * dt);
    this.camera.position.lerp(pos, follow);
    this._keepCameraInsideTrack(s.trackT);
    const shake = this._applyCameraShake(dt);
    this.camera.lookAt(look);
    const driftTilt = s.isDrifting ? -s.driftAngle * 0.12 : 0;
    this.camera.rotateZ(shake.roll + driftTilt);
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-5 * dt));
    this.camera.updateProjectionMatrix();
  }

  // The lagging chase camera can swing outside the barrier on tight corners
  // (the dark wall then fills half the screen) — clamp it back inside, and
  // under the tunnel ceiling.
  _keepCameraInsideTrack(hintT) {
    const cam = this.camera.position;
    const c = this.track.closestPoint(cam, hintT);
    const limit = this.track.barrierOffset - 0.7;
    if (c.distance > limit) {
      const y = cam.y;
      cam.sub(c.point).setY(0).setLength(limit).add(c.point);
      cam.y = y;
    }
    if (this.track.isInTunnel(c.t)) cam.y = Math.min(cam.y, 7.8);
  }

  _updateCountdownCamera(dt) {
    const car = this.player;
    const k = THREE.MathUtils.smoothstep(Math.min(1, this._countdownT / COUNTDOWN_LENGTH), 0, 1);
    const angle = car.state.heading + THREE.MathUtils.lerp(Math.PI * 0.82, Math.PI * 2, k);
    const dist = THREE.MathUtils.lerp(6.5, 8.2, k);
    const height = THREE.MathUtils.lerp(1.0, 2.8, k);
    const pos = car.object3D.position.clone().add(new THREE.Vector3(-Math.sin(angle) * dist, height, -Math.cos(angle) * dist));
    this.camera.position.lerp(pos, 1 - Math.exp(-6 * dt));
    this._applyCameraShake(dt);
    this.camera.lookAt(car.object3D.position.clone().add(new THREE.Vector3(0, 1.0, 0)));
    this.camera.fov += (BASE_FOV - 4 - this.camera.fov) * (1 - Math.exp(-4 * dt));
    this.camera.updateProjectionMatrix();
    this._camHeading = car.state.heading;
  }

  _updateMenuCamera(dt, elapsed) {
    const t = (elapsed * 0.0085) % 1;
    const p = this.track.getPointAt(t);
    const n = this.track.getNormalAt(t);
    const ahead = this.track.getLookaheadPoint(t, 40);
    const target = p.clone().addScaledVector(n, Math.sin(elapsed * 0.21) * 4).setY(5.5 + Math.sin(elapsed * 0.33) * 2);
    if (this.camera.position.distanceToSquared(target) > 2500) this.camera.position.copy(target);
    this.camera.position.lerp(target, 1 - Math.exp(-2 * dt));
    this.camera.lookAt(ahead.x, 4.5, ahead.z);
    this.camera.rotateZ(Math.sin(elapsed * 0.17) * 0.03);
    this.camera.fov += (BASE_FOV + 4 - this.camera.fov) * 0.05;
    this.camera.updateProjectionMatrix();
  }

  _updateResultsCamera(elapsed) {
    const car = this.player.object3D.position;
    const a = elapsed * 0.25;
    this.camera.position.set(car.x + Math.cos(a) * 9, 2.6, car.z + Math.sin(a) * 9);
    this.camera.lookAt(car.x, 0.9, car.z);
    this.camera.fov = BASE_FOV - 10;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------ resize / perf --

  _applyPixelRatio() {
    const pr = this._basePixelRatio * this._dynScale;
    this.renderer.setPixelRatio(pr);
    this.postfx.setPixelRatio(pr);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.fx.setProjection(size.y, BASE_FOV);
    this.environment.setSize();
  }

  // Dynamic resolution: drop render scale when the frame rate sags (a
  // student laptop on a projector), recover slowly when there's headroom.
  _adaptResolution(rawDt, screen) {
    if (rawDt > 0.25 || document.hidden) return; // ignore stalls/tab switches
    const p = this._perf;
    p.acc += rawDt;
    p.frames++;
    p.timer += rawDt;
    if (p.timer < 2) return;
    const fps = p.frames / p.acc;
    p.acc = 0; p.frames = 0; p.timer = 0;
    this.fps = fps;
    if (fps < 42 && this._dynScale > 0.6) {
      this._dynScale = Math.max(0.6, this._dynScale - 0.1);
      this._applyPixelRatio();
    } else if (fps > 57 && this._dynScale < 1) {
      this._dynScale = Math.min(1, this._dynScale + 0.05);
      this._applyPixelRatio();
    }
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx.setSize(w, h);
    this.speedLines.resize();
    this._applyPixelRatio();
  }
}
