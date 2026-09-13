# NEON VECTOR

**"CONTROL THE RIDE."**

A browser-based 3D cyberpunk arcade racer driven by physical motion. Tilt a
handheld ESP32 + MPU6050 controller to steer, accelerate and brake a neon
hypercar through a rain-soaked night city. Shake it for nitro. Keyboard
controls stay live the whole time, so the game is always playable — with or
without the hardware.

```
PHYSICAL CONTROLLER → MPU6050 → ESP32 → Wi-Fi / WebSocket → THREE.JS → 3D CYBERPUNK WORLD
```

---

## 1. Project Overview

NEON VECTOR is a small arcade-racing technology showcase: a 1.67 km circuit
through a procedurally generated cyberpunk city, three AI rivals with
distinct personalities, nitro / drift / boost-pad mechanics, a glowing
integrated HUD and a cinematic HDR rendering pipeline (planar wet-road
reflections, bloom, ACES filmic tone mapping, lens effects).

The headline feature is the control scheme. The ESP32 samples the IMU at
250 Hz, fuses accelerometer + gyro into roll/pitch on-device with a
complementary filter, and streams compact JSON to the browser at ~30 Hz.
The game calibrates, smooths and dead-zones those angles into steering,
throttle and brake, with a live motion reticle on the HUD so an audience can
*see* the controller driving the car.

---

## 2. Features

**World**
- Procedural city: ~400 instanced towers with setback tiers, antennas and
  blinking aircraft beacons; neon blade signs and roof crown bands;
  holographic billboards (scanlines, flicker, glitch); storefront glow at
  street level; flying traffic; sweeping searchlights; light-pollution haze;
  a distant skyline twinkling through the fog
- Building facades are computed in a shader from world-scale coordinates, so
  every tower gets correctly sized windows — which switch on/off over time,
  and some flicker like screens
- Wet streets: a real-time planar reflection of the city, sampled through a
  procedural puddle mask with vertical streaking and animated rain ripples
  (the classic "neon on wet tarmac" look); pavement slabs off the road
- GPU rain streaks that slant toward the camera with speed and stop inside
  the tunnel
- Track set pieces: start/finish gantry with countdown lamps and a
  holographic title, a 180 m neon-ringed tunnel with a travelling light
  pulse, two elevated highways with moving traffic, checkpoint arches that
  flash as you pass, animated chevron boost pads, street lights with glowing
  light pools, neon-trimmed crash barriers

**Driving**
- Arcade physics: tapered acceleration, braking, speed-sensitive steering,
  handbrake drifting, nitro, frame-rate independent handling
- Barrier collisions that slide you along the wall and scale speed loss with
  impact angle; car-to-car impulses; sparks, camera shake and impact audio
- 3 AI rivals: RIVAL 01 Aggressive (brave in corners, won't yield),
  RIVAL 02 Balanced, RIVAL 03 Fast but unstable (twitchy, drifts). They pick
  racing lines, brake for upcoming curvature, overtake and use nitro on
  straights. Mild rubber-banding keeps the pack together on stage.
- Nitro: FOV kick, radial blur, heat shimmer, plasma exhaust flames and
  particles, speed lines, camera shake, drains and recharges

**Presentation**
- HUD: arc speedometer, position + live standings with gaps, lap / race /
  best-lap timers, segmented nitro bar, glowing minimap, G-force and drift
  angle, checkpoint counter, MPU link signal meter + latency, live motion
  reticle, WRONG WAY warning
- Countdown: gantry lamps, engine revs, a camera that sweeps from the car's
  nose round to the chase position, then a dramatic GO flash
- Results: position, total time, best lap, lap splits, top speed, drift
  distance, NEW RECORD (persisted in localStorage)
- Cameras: chase (lags into corners and drifts), low cinematic, cockpit
- Procedural Web Audio: layered engine with a fake gearbox, nitro whoosh,
  tyre skid, wall scrape, wind, boost, collisions, UI, countdown, fanfare

**Hardware link**
- Calibration screen with live roll/pitch readout and tilt reticle;
  calibration is saved and survives reloads
- Invert steering / pitch toggles (fix a flipped mounting without code)
- Link robustness designed for phone hotspots — see §9

---

## 3. Architecture

```
neon-vector/
├── index.html                 # canvas + all UI screen markup
├── vite.config.js, package.json
├── firmware/esp32_mpu_controller/
│   ├── esp32_mpu_controller.ino   # ESP32 + MPU firmware
│   └── build_opt.h                # compile flag (WebSocket queue depth)
└── src/
    ├── main.js                # bootstraps Game, visible error banner on failure
    ├── style.css              # HUD / menu / panel styling, responsive scale
    ├── config/settings.js     # tuning, quality presets, network, input
    ├── game/
    │   ├── Game.js            # orchestrator: loop, screens, cameras, wiring
    │   ├── GameState.js       # observable store (Screen enum)
    │   ├── RaceManager.js     # race clock, phases, events, results
    │   └── CheckpointSystem.js# laps, gates, positions
    ├── vehicle/
    │   ├── CarMesh.js         # procedural hypercar (extruded profiles)
    │   ├── Physics.js         # arcade physics, barrier + car collisions
    │   ├── PlayerCar.js
    │   └── AICar.js           # racing-line AI + personalities
    ├── world/
    │   ├── Track.js           # spline circuit, features, lookups
    │   ├── ribbon.js          # sweeps strips / walls along the spline
    │   ├── Road.js            # road, markings, barriers, lights, gates, gantry
    │   ├── Structures.js      # tunnel + overpasses + traffic
    │   ├── City.js            # buildings (shader facades), signs, sky life
    │   ├── Environment.js     # sky, fog, lights, env map, rain
    │   └── WetSurface.js      # planar reflection + wet-asphalt shader
    ├── effects/
    │   ├── PostFX.js          # bloom, lens/grade pass, ACES output
    │   ├── ParticleSystem.js  # pooled soft GPU particles
    │   ├── VehicleEffects.js  # exhaust / nitro / smoke / sparks
    │   ├── SpeedLines.js, CameraShake.js
    ├── input/                 # KeyboardController, MPUController, InputManager
    ├── network/WebSocketManager.js
    ├── ui/                    # MainMenu (+ results), CalibrationScreen, HUD
    └── audio/AudioManager.js
```

`ResultsScreen` lives in `MainMenu.js` (`setResults`) — it shares the same
show/hide plumbing as the other panels.

```
┌────────────────────────── BROWSER ──────────────────────────────┐
│ KeyboardController ─┐                                            │
│                     ├─▶ InputManager ─▶ PlayerCar ─▶ Physics      │
│ MPUController ──────┘   (merge)          │                        │
│  (calibrate, smooth,                     ▼                        │
│   dead-zone, shake)         RaceManager + CheckpointSystem        │
│        ▲                                 │                        │
│        │ JSON 30 Hz                      ▼                        │
│ WebSocketManager               HUD / MainMenu / Audio             │
│  (timeout, watchdog,                                              │
│   address rotation)     Scene ─▶ Reflection ─▶ Bloom ─▶ Lens ─▶ ACES
└────────▲─────────────────────────────────────────────────────────┘
         │ ws://<esp32>:81   (Wi-Fi: hotspot / router / own AP)
┌────────┴──────────────┐
│ ESP32                 │  async WebSocket server (never blocks)
│  MPU6050 @ 250 Hz I2C │  complementary filter → roll / pitch / motion
└───────────────────────┘
```

---

## 4. Required Hardware

- ESP32 DevKit (ESP32-WROOM-32 / "DevKit V1")
- MPU6050 breakout (GY-521). Clones carrying an **MPU6500 / MPU6886 /
  MPU9250** work too — the firmware talks to the registers directly and
  prints which chip it found.
- USB cable (flashing + power); a power bank for wireless demos
- 4 jumper wires

## 5. ESP32 Wiring

| MPU6050 | ESP32 |
|---|---|
| VCC | **3V3** (not 5V) |
| GND | GND |
| SCL | GPIO 22 |
| SDA | GPIO 21 |
| XDA, XCL, AD0, INT | not connected |

Pins are `SDA_PIN` / `SCL_PIN` at the top of the sketch. Mount the sensor
firmly — loose wiring makes noise that looks like a shake (nitro).

## 6. Arduino Libraries

Arduino IDE → **Tools → Manage Libraries**:

1. **ESP Async WebServer** — by ESP32Async
2. **Async TCP** — by ESP32Async
3. **ArduinoJson** — v7.x

Board package: **esp32** by Espressif Systems, v3.x (Boards Manager).

## 7. Firmware Setup

1. Open `firmware/esp32_mpu_controller/esp32_mpu_controller.ino`.
2. Copy `secrets.example.h` to `secrets.h` (same folder) and put your Wi-Fi
   networks in it (§8). `secrets.h` is git-ignored, so passwords never reach
   the repo.
3. Board: **ESP32 Dev Module**, and your COM port.
4. **Upload.** On boards without auto-reset (common on CH340 DevKits), if the
   upload stalls at `Connecting…` or reports *Wrong boot mode*: hold **BOOT**,
   tap **EN**, release **BOOT**, then upload again. (With `esptool` directly,
   add `--before no-reset` so it doesn't undo that.)
5. **Serial Monitor at 115200** shows the detected chip, the Wi-Fi status and
   the exact `ws://` URL. Commands: `s` rescan I2C, `r` reset the filter,
   `i` print link stats.

`build_opt.h` sets the WebSocket queue depth; the Arduino IDE picks it up
automatically.

## 8. Wi-Fi Setup

**Join an existing network / phone hotspot (recommended — the laptop keeps
internet):**

In `secrets.h`:

```cpp
const WifiNetwork NETWORKS[] = {
  { "HomeWiFi",   "..." },
  { "PhoneHotspot", "..." },   // add as many as you like
};
```

and `#define USE_ACCESS_POINT false` in the sketch.

At boot the ESP32 scans and joins the **strongest** known network in range.
If it loses that network for 12 s it tries the next one; if none are
reachable it also opens its own fallback hotspot (and keeps retrying the
networks once a minute). Networks must be **2.4 GHz** (on phone hotspots
enable "maximize compatibility" / 2.4 GHz).

Put the laptop on the same network as the ESP32. The game finds the
controller automatically — its IP differs per network, so it falls back to
`ws://neonvector.local:81` (mDNS), which works on any of them.

**Stand-alone hotspot (no router at all):**

Set `#define USE_ACCESS_POINT true` in the sketch; the hotspot name and
password are `AP_SSID` / `AP_PASSWORD` in `secrets.h`.

Join that network (default `NEON_VECTOR_CTRL`) from the laptop; the game address is
`ws://192.168.4.1:81`. (No internet on that network, so the web fonts fall
back to system fonts — everything else works.)

## 9. WebSocket Link

- Port `81`. The game connects **automatically at startup** and remembers the
  last working address. If it can't reach it, it rotates through
  `ws://neonvector.local:81` (mDNS — finds the ESP32 even after its DHCP
  address changes) and `ws://192.168.4.1:81` (the fallback hotspot).
- Packet (~30 Hz):
  ```json
  {"ax":0.12,"ay":-0.03,"az":9.72,"gx":0.8,"gy":-2.1,"gz":0.4,
   "roll":4.2,"pitch":-2.8,"yaw":0,"motion":0.13,"ok":1}
  ```
- Latency: the game sends `{"type":"ping"}` every 1.5 s; the firmware echoes
  a `pong`; the HUD shows the smoothed round-trip time.
- **Robustness (why it doesn't drop):**
  - Firmware uses a non-blocking async server. A slow or dead client can never
    stall the sensor loop (the previous blocking library could freeze for up
    to 5 s on a Wi-Fi hiccup).
  - Each client is served independently. A congested one has its stale frame
    skipped ("latest frame wins") while the others keep getting data; a client
    stalled for 8 s is dropped.
  - `TCP_NODELAY` is on: without it each small frame waits for the previous
    ACK, and Windows delays ACKs — bursty, laggy delivery.
  - Memory guard: frames are skipped (never a crash) if the heap runs low.
    The boot log and `/health` report the last reset reason.
  - Wi-Fi modem sleep is disabled (it causes 50–300 ms delivery stalls).
  - A hidden/background game tab releases the controller and reconnects when
    shown, so it can't hog a connection slot.
  - In the game, packet gaps are staged: < 250 ms holds the last input,
    up to ~1 s eases it to neutral and shows **SIGNAL WEAK**, and only 2.5 s
    of silence counts as **OFFLINE** (keyboard takes over, nothing else
    changes).
  - A connect timeout, a silence watchdog (reconnects half-open sockets) and
    fast capped backoff.
- Diagnostics: `http://<esp32-ip>:81/health` returns sensor status, RSSI,
  client count, frames sent/skipped, free/min heap, uptime and last reset
  reason.
- Measured on a phone hotspot (2 min soak): 30 Hz, median frame gap 33 ms,
  99th percentile 86 ms, median round trip ~20 ms, no disconnects.

## 10. PC Setup

Node.js 18+ (built and tested on Node 24).

```bash
npm install
```

## 11. npm Commands

```bash
npm run dev       # dev server on http://localhost:5173
npm run build     # production build to dist/
npm run preview   # serve the production build
```

## 12. Running the Game

```bash
npm install
npm run dev
```

Open `http://localhost:5173` (full screen: F11). Press **START RACE**, or
first visit **CONTROLLER** to confirm the link and calibrate. `ESC` during a
race returns to the menu.

## 13. Calibration

1. **CONTROLLER** screen — STATUS must read `CONNECTED` (the ROLL/PITCH line
   and the reticle move as you tilt).
2. Hold the controller the way you'll hold it to play, level and still, and
   press **CALIBRATE** (~1.5 s).
3. That pose becomes neutral. It's saved, so you only redo it if you change
   grip or remount the sensor.
4. If left steers right or forward brakes, tick **INVERT STEER** / **INVERT
   PITCH** — no code change needed.

## 14. Keyboard Controls

| Key | Action |
|---|---|
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake / reverse |
| `A` / `←`, `D` / `→` | Steer |
| `SHIFT` | Nitro |
| `SPACE` | Handbrake / drift |
| `C` | Camera mode (chase / low / cockpit) |
| `R` | Put the car back on the track |
| `ESC` | Abort race → menu |

## 15. MPU Controller Controls

| Motion | Action |
|---|---|
| Tilt forward | Accelerate (proportional) |
| Tilt backward | Brake (proportional) |
| Tilt left / right | Steer (proportional) |
| Twist | Fine steering |
| Quick shake | Nitro (1.5 s burst per shake) |

Sensitivity: **Settings** (0.5×–2.5×). Dead zone, max tilt, smoothing, shake
threshold and link timings: `INPUT.mpu` in `src/config/settings.js`.

## 16. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm install` blocks esbuild's install script | `npm approve-scripts esbuild`, then `npm install` again. |
| Upload fails: *Wrong boot mode (0x13)* / stuck at `Connecting…` | Hold BOOT, tap EN, release BOOT, upload again (see §7). |
| Serial says `NO devices found` | Wiring: VCC→3V3, SDA→21, SCL→22, firm jumpers; try swapping SDA/SCL. |
| Serial says `WHO_AM_I=0x70 (MPU6500)` | That's a clone chip — it's supported, nothing to do. |
| Controller OFFLINE | Laptop and ESP32 on the same 2.4 GHz network? Check the Serial URL, or open `http://<ip>:81/health`. On phone hotspots, keep the phone screen on (some phones drop idle clients). |
| Frequent SIGNAL WEAK | Weak Wi-Fi: move the ESP32 closer to the hotspot; keep a phone hotspot's screen on and battery-saver off; power the ESP32 from a good USB supply. For the most reliable stage setup use the ESP32's own hotspot (`USE_ACCESS_POINT true`) — a direct link with no phone in between. |
| Controller keeps reconnecting | Check the Serial log's `[SYS] Last reset:` line / `/health` `lastReset`. Close extra game tabs — each holds a connection (max 3). |
| Calibration bar never fills | It needs live packets — STATUS must be CONNECTED. |
| Steering reversed | CONTROLLER → INVERT STEER / INVERT PITCH. |
| Low FPS | Settings → LOW or MEDIUM. The game also lowers its render resolution automatically if FPS drops below ~42. |

Performance reference: on an AMD Radeon 780M (integrated laptop GPU) a full
frame at 1280×720 costs ~2 ms (LOW), ~7 ms (MEDIUM), ~7 ms (HIGH).

## 17. Asset Licenses

**ASSET:** All vehicle geometry — **SOURCE:** procedurally modelled in
`src/vehicle/CarMesh.js` (extruded side profiles + primitives) —
**LICENSE:** original, created for this project — **WHY:** the project must
run with no external/network asset dependencies; procedural geometry keeps it
tiny and licence-free while still reading as a sports car.

**ASSET:** All textures (facades, billboards, sky, signage, glows) —
**SOURCE:** generated at runtime (shaders and `CanvasTexture`) —
**LICENSE:** original — **WHY:** zero downloads, infinite variation.

**ASSET:** All audio — **SOURCE:** synthesised with the Web Audio API in
`src/audio/AudioManager.js` — **LICENSE:** original — **WHY:** the brief
forbids depending on external sound URLs.

**Fonts:** Orbitron and Rajdhani (Google Fonts, SIL Open Font License 1.1),
with system-font fallbacks when offline.

**Libraries:** three.js (MIT), Vite (MIT); firmware: ESPAsyncWebServer /
AsyncTCP (LGPL-3.0), ArduinoJson (MIT).

Billboard text and brands are invented; no third-party logos, vehicles or UI
are reproduced.

## 18. Future Improvements

- Magnetometer fusion (MPU9250) for true yaw / "point to steer"
- Elevated track sections (the ribbon builder already supports varying height)
- Split-screen race with a second controller
- Ghost replays of your best lap
- Haptics: a vibration motor on the controller for impacts and nitro
- Licensed GLTF car as an option (CarMesh returns a plain Group with anchor
  points, so a model can drop in)

---

Built with three.js, Vite and vanilla JS — no framework, no backend.
