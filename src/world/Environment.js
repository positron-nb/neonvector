import * as THREE from 'three';
import { COLORS, neon } from '../config/settings.js';
import { WetSurface, LAYER_NO_REFLECT } from './WetSurface.js';

export const FOG_COLOR = new THREE.Color(0x0b0718);

// Night sky, fog, lighting, neon environment map, wet reflective ground and
// GPU rain.
export class Environment {
  constructor(scene, camera, renderer, quality) {
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.group = new THREE.Group();
    scene.add(this.group);

    scene.fog = new THREE.FogExp2(FOG_COLOR, quality.fogDensity);
    scene.background = FOG_COLOR.clone();

    this._buildSky();
    this._buildLights();
    this._buildEnvMap(renderer);
    this.wet = new WetSurface(scene, camera, quality, FOG_COLOR);
    this._buildRain(quality.rainDrops);

    this.rainVisibility = 1;
  }

  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      name: 'NeonSky',
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uZenith: { value: new THREE.Color(0x020208) },
        uMid: { value: new THREE.Color(0x0d0822) },
        uHorizon: { value: new THREE.Color(0x3a0f3c) },
        uGlowA: { value: neon(COLORS.magenta, 0.55) },
        uGlowB: { value: neon(COLORS.cyan, 0.3) }
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // pin to far plane
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uZenith, uMid, uHorizon, uGlowA, uGlowB;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }
        void main() {
          float y = clamp(vDir.y, -0.1, 1.0);
          vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, y));
          col = mix(col, uZenith, smoothstep(0.18, 0.7, y));

          // Smog layer, lit from below by the city.
          vec2 cp = vDir.xz / max(vDir.y + 0.12, 0.05);
          float c = fbm(cp * 0.55 + vec2(uTime * 0.004, uTime * 0.002));
          float clouds = smoothstep(0.42, 0.85, c) * smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.35, 0.9, y));
          float angle = atan(vDir.z, vDir.x);
          float glowMix = 0.5 + 0.5 * sin(angle * 2.0 + 1.3);
          vec3 cityGlow = mix(uGlowA, uGlowB, glowMix);
          col += clouds * (cityGlow * (0.55 - y * 0.5) + vec3(0.02, 0.015, 0.04));

          // Horizon light pollution band.
          col += cityGlow * 0.35 * exp(-abs(y) * 22.0);

          // Sparse stars peeking through gaps in the smog.
          vec2 sp = vDir.xz / max(vDir.y + 1.0, 0.01) * 180.0;
          float star = step(0.9965, hash(floor(sp))) * smoothstep(0.25, 0.6, y) * (1.0 - clouds);
          col += star * 0.6;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), mat);
    this.sky.frustumCulled = false;
    this.group.add(this.sky);
  }

  _buildLights() {
    this.group.add(new THREE.AmbientLight(0x1a1638, 0.6));
    const hemi = new THREE.HemisphereLight(0x4a2a8a, 0x05030a, 0.55);
    this.group.add(hemi);
    const moon = new THREE.DirectionalLight(0x8090ff, 0.35);
    moon.position.set(-120, 200, -80);
    this.group.add(moon);
    // Magenta rim from the city glow on the opposite side.
    const rim = new THREE.DirectionalLight(0xff3fc8, 0.25);
    rim.position.set(160, 40, 120);
    this.group.add(rim);
  }

  // A tiny "neon room" rendered once into a PMREM cubemap: gives car paint,
  // glass and building windows believable coloured reflections for free.
  _buildEnvMap(renderer) {
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x020206);
    const panel = (color, intensity, w, h, pos, rotY = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: neon(color, intensity), side: THREE.DoubleSide }));
      m.position.copy(pos);
      m.rotation.y = rotY;
      envScene.add(m);
    };
    // Horizon ring of city-light bands: gives paint a continuous neon skyline
    // highlight instead of a few isolated specks.
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#05030c');
    grad.addColorStop(0.45, '#2a0e44');
    grad.addColorStop(0.62, '#ff4fd8');
    grad.addColorStop(0.7, '#3a1a6a');
    grad.addColorStop(1, '#040308');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 128);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = ['#21f3ff', '#ff2bd6', '#ffd6a0', '#8a3bff', '#cfe6ff'][i % 5];
      g.globalAlpha = 0.5 + Math.random() * 0.5;
      g.fillRect(Math.random() * 1024, 55 + Math.random() * 30, 4 + Math.random() * 30, 2 + Math.random() * 5);
    }
    g.globalAlpha = 1;
    const ringTex = new THREE.CanvasTexture(c);
    ringTex.colorSpace = THREE.SRGBColorSpace;
    ringTex.wrapS = THREE.RepeatWrapping;
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, 8, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: ringTex, side: THREE.BackSide, color: new THREE.Color(1.6, 1.6, 1.6) })
    );
    ring.position.y = 1;
    envScene.add(ring);

    panel(COLORS.magenta, 2.2, 6, 1.2, new THREE.Vector3(-8, 3, -4), Math.PI / 3);
    panel(COLORS.cyan, 2.2, 5, 1.0, new THREE.Vector3(8, 2.5, 3), -Math.PI / 3);
    panel(COLORS.violet, 1.6, 10, 2.0, new THREE.Vector3(0, 7, -9));
    panel(COLORS.orange, 1.4, 3, 0.6, new THREE.Vector3(5, 1.2, -8), -Math.PI / 6);
    panel(0x6fd8ff, 1.0, 14, 0.4, new THREE.Vector3(0, 9, 6), Math.PI);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(envScene, 0.035).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
  }

  // Rain as GPU line streaks: positions are computed in the vertex shader and
  // wrapped around the camera, so there is zero per-frame CPU cost.
  _buildRain(count) {
    this.rain = null;
    if (!count) return;
    const offsets = new Float32Array(count * 2 * 3);
    const ends = new Float32Array(count * 2);
    const seeds = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), s = Math.random();
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        offsets.set([x, y, z], k * 3);
        ends[k] = e;
        seeds[k] = s;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(offsets, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      name: 'RainStreaks',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(90, 50, 90) },
        uWind: { value: new THREE.Vector3(0, 0, 0) },
        uDrift: { value: new THREE.Vector3(0, 0, 0) },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(0.55, 0.7, 0.95) }
      },
      vertexShader: /* glsl */`
        attribute float aEnd;
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uCenter, uBox, uWind, uDrift;
        varying float vAlpha;
        void main() {
          float speed = 34.0 + aSeed * 14.0;
          vec3 p = position * uBox;
          p.y -= uTime * speed;
          p.xz += uDrift.xz;
          vec3 rel = mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 world = uCenter + rel;
          vec3 streak = normalize(vec3(uWind.x, -speed, uWind.z)) * (0.9 + aSeed * 0.6);
          world += streak * aEnd;
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float d = length(mv.xyz);
          vAlpha = (1.0 - aEnd * 0.85) * smoothstep(45.0, 8.0, d) * smoothstep(0.5, 3.0, d);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(uColor * vAlpha * uOpacity * 0.55, 1.0); }
      `
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.rain);
  }

  // rainVisibility lets the game fade rain out inside the tunnel.
  update(dt, elapsed, cameraPosition, carVelocity) {
    this.sky.position.copy(cameraPosition);
    this.sky.material.uniforms.uTime.value = elapsed;
    this.wet.update(elapsed);
    if (this.rain) {
      const u = this.rain.material.uniforms;
      u.uTime.value = elapsed;
      u.uCenter.value.copy(cameraPosition);
      // In the car's frame the rain streams backwards, so it slants toward
      // the camera as speed builds.
      if (carVelocity) u.uWind.value.set(-carVelocity.x * 0.6, 0, -carVelocity.z * 0.6);
      else u.uWind.value.set(0, 0, 0);
      u.uDrift.value.addScaledVector(u.uWind.value, dt);
      u.uDrift.value.x %= u.uBox.value.x;
      u.uDrift.value.z %= u.uBox.value.z;
      u.uOpacity.value += (this.rainVisibility - u.uOpacity.value) * Math.min(1, dt * 4);
    }
  }

  setSize() {
    this.wet.setSize();
  }

  dispose() {
    this.scene.remove(this.group);
    this.wet.dispose();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.envMap) this.envMap.dispose();
  }
}
