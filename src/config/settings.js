// Central tunable configuration for NEON VECTOR.
import * as THREE from 'three';

export const COLORS = {
  cyan: 0x21f3ff,
  magenta: 0xff2bd6,
  violet: 0x8a3bff,
  orange: 0xff7a1a,
  electricBlue: 0x2f6bff,
  red: 0xff2233,
  deepBg: 0x02030a
};

// Rendering is HDR: the bloom pass only picks up values above ~1.0, so neon
// surfaces are authored as colour x intensity. Everything else stays below 1
// and reads as dark, lit geometry — that contrast is what makes bloom look
// cinematic instead of blurry.
export function neon(hex, intensity = 3) {
  return new THREE.Color(hex).multiplyScalar(intensity);
}

export const QUALITY_PRESETS = {
  low: {
    pixelRatioCap: 1.0,
    msaaSamples: 0,
    bloomStrength: 0.7,
    bloomRadius: 0.4,
    bloomThreshold: 1.0,
    reflections: false,
    reflectionScale: 0,
    reflectionTaps: 5,
    nearBuildings: 70,
    midBuildings: 50,
    farBuildings: 60,
    rainDrops: 0,
    particlePoolSize: 90,
    flyers: 8,
    grain: 0.0,
    radialBlurTaps: 4,
    fogDensity: 0.0105
  },
  medium: {
    pixelRatioCap: 1.25,
    msaaSamples: 2,
    bloomStrength: 0.85,
    bloomRadius: 0.5,
    bloomThreshold: 1.0,
    reflections: true,
    reflectionScale: 0.45,
    reflectionTaps: 7,
    nearBuildings: 130,
    midBuildings: 110,
    farBuildings: 110,
    rainDrops: 1400,
    particlePoolSize: 180,
    flyers: 18,
    grain: 0.035,
    radialBlurTaps: 6,
    fogDensity: 0.0095
  },
  high: {
    pixelRatioCap: 1.75,
    msaaSamples: 4,
    bloomStrength: 0.95,
    bloomRadius: 0.55,
    bloomThreshold: 0.95,
    reflections: true,
    reflectionScale: 0.7,
    reflectionTaps: 9,
    nearBuildings: 190,
    midBuildings: 170,
    farBuildings: 150,
    rainDrops: 3200,
    particlePoolSize: 280,
    flyers: 30,
    grain: 0.045,
    radialBlurTaps: 8,
    fogDensity: 0.009
  }
};

export const PHYSICS = {
  maxSpeed: 62,           // m/s (~223 km/h) base top speed
  nitroMaxSpeed: 88,       // m/s during nitro (~317 km/h)
  acceleration: 22,
  reverseAcceleration: 10,
  brakeDeceleration: 38,
  coastDeceleration: 6,
  maxSteerAngle: 0.62,     // radians
  steerSpeed: 3.2,
  steerReturnSpeed: 4.5,
  turnRateBase: 1.8,       // how fast heading changes per steer unit at ref speed
  driftGrip: 0.35,
  normalGrip: 0.92,
  driftSteerBoost: 1.35,
  carRadius: 1.15,
  wallBounce: 0.35,        // fraction of into-wall velocity reflected
  wallScrapeDecel: 9,      // m/s^2 lost while grinding along a barrier
  wallImpactLoss: 0.55,    // max fraction of speed lost on a head-on barrier hit
  nitroForce: 34,
  nitroDrainPerSec: 0.34,
  nitroRechargePerSec: 0.09,
  nitroMinToActivate: 0.12
};

export const KM_H_PER_MS = 3.6; // m/s -> km/h

export const INPUT = {
  keyboardSteerSpeed: 2.6,
  mpu: {
    deadZoneDeg: 2.0,
    maxTiltDeg: 28,
    smoothing: 0.22,          // exponential smoothing factor (0-1, higher = snappier)
    sensitivity: 1.3,
    throttleTiltDeg: 18,
    shakeMotionThreshold: 2.4,
    shakeCooldownMs: 900,
    staleAfterMs: 250,        // gap before input starts easing to neutral ("SIGNAL WEAK")
    staleFadeMs: 700,         // how long the ease-to-neutral takes
    packetTimeoutMs: 2500,    // gap before the link is declared OFFLINE
    twistSteer: 0.15,         // fine steering from twisting the controller (yaw rate)
    steerSign: 1,             // flip to -1 if tilting left steers right
    pitchSign: 1              // flip to -1 if tilting forward brakes
  }
};

export const NETWORK = {
  defaultUrl: 'ws://10.106.101.62:81',
  // Tried in rotation after the primary URL, so a new DHCP address (via mDNS)
  // or the ESP32's fallback hotspot are found without typing anything.
  fallbackUrls: ['ws://neonvector.local:81', 'ws://192.168.4.1:81'],
  connectTimeoutMs: 2500,
  silenceTimeoutMs: 4000,     // open socket with no data -> assume half-open, reconnect
  reconnectBaseDelayMs: 400,
  reconnectMaxDelayMs: 2000,
  pingIntervalMs: 1500
};

export const RACE = {
  totalLaps: 3,
  aiCount: 3,
  checkpointCount: 10
};

export const STORAGE_KEYS = {
  bestLap: 'neonvector_best_lap',
  quality: 'neonvector_quality',
  audio: 'neonvector_audio',
  sensitivity: 'neonvector_sensitivity',
  wsUrl: 'neonvector_ws_url',
  calibration: 'neonvector_calibration',
  invertSteer: 'neonvector_invert_steer',
  invertPitch: 'neonvector_invert_pitch'
};
