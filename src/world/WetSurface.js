import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

// Layer used for objects the main camera sees but the reflection camera must
// NOT render: the wet road itself (it samples the reflection texture, so
// drawing it into that texture would be a feedback loop), light-pool decals,
// rain streaks.
export const LAYER_NO_REFLECT = 1;

// Shared wet-asphalt shader. Samples a planar reflection of the scene through
// a procedural puddle mask: puddles are sharp mirrors, the rest is a streaky,
// vertically-smeared reflection — the classic "neon on wet tarmac" look.
const WetShader = {
  name: 'WetAsphalt',
  defines: { TAPS: 7 },
  uniforms: {
    color: { value: null },          // required by Reflector (unused)
    tDiffuse: { value: null },
    textureMatrix: { value: null },  // required by Reflector (unused: we use world space)
    uWorldTexMatrix: { value: new THREE.Matrix4() },
    uBase: { value: new THREE.Color(0x07080d) },
    uPuddle: { value: 0.5 },
    uReflStrength: { value: 1.0 },
    uStreak: { value: 1.0 },
    uDry: { value: 0.25 },
    uTiles: { value: 0.0 },
    uNoiseScale: { value: 1.0 },
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color(0x0a0616) },
    uFogDensity: { value: 0.009 }
  },
  vertexShader: /* glsl */`
    uniform mat4 uWorldTexMatrix;
    varying vec4 vReflUv;
    varying vec3 vWorld;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vReflUv = uWorldTexMatrix * world;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 uBase, uFogColor;
    uniform float uPuddle, uReflStrength, uStreak, uNoiseScale, uTime, uFogDensity, uDry, uTiles;
    varying vec4 vReflUv;
    varying vec3 vWorld;

    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
      return v;
    }
    // Expanding raindrop rings inside puddles.
    vec2 ripple(vec2 p, float t) {
      vec2 cell = floor(p);
      vec2 acc = vec2(0.0);
      for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        float h = hash(c);
        vec2 center = c + vec2(hash(c + 3.1), hash(c + 7.7));
        float phase = fract(t * (0.6 + h * 0.5) + h * 10.0);
        vec2 d = p - center;
        float r = length(d);
        float ring = sin(clamp((r - phase * 0.9) * 28.0, -3.14159, 3.14159)) * (1.0 - phase) * smoothstep(0.9, 0.0, r);
        acc += (d / max(r, 0.001)) * ring;
      }
      return acc;
    }

    void main() {
      vec2 p = vWorld.xz * uNoiseScale;
      float n = fbm(p * 0.045);
      float puddle = smoothstep(0.55 - uPuddle * 0.3, 0.63 - uPuddle * 0.3, n);
      float grit = noise(p * 1.9) * 0.55 + noise(p * 7.3) * 0.45;

      vec3 V = normalize(cameraPosition - vWorld);
      float fres = 0.08 + 0.92 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);

      vec2 rip = ripple(p * 1.4, uTime) * puddle;
      vec2 distort = rip * 0.012 + vec2(0.0, (grit - 0.5) * 0.012) * (1.0 - puddle);

      // Blur radius: puddles are near-mirror, dry asphalt is rough and smeary.
      float spread = mix(0.012, 0.0022, puddle) * uStreak;
      vec4 base = vReflUv;
      base.xy += distort * base.w;
      vec3 refl = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < TAPS; i++) {
        float k = float(i) - float(TAPS - 1) * 0.5;
        float w = 1.0 - abs(k) / float(TAPS);
        vec4 s = base;
        s.y += k * spread * s.w * 1.7;
        s.x += k * spread * s.w * 0.18;
        refl += texture2DProj(tDiffuse, s).rgb * w;
        wsum += w;
      }
      refl /= wsum;

      vec3 asphalt = uBase * (0.5 + grit * 0.9);
      // Pavement slabs (ground only): darker grout lines that stay dull.
      vec2 tc = abs(fract(vWorld.xz / 3.2) - 0.5);
      float seam = smoothstep(0.47, 0.49, max(tc.x, tc.y)) * uTiles;
      asphalt *= 1.0 - seam * 0.6;
      float reflAmt = uReflStrength * mix(uDry, 1.0, puddle) * fres * (1.0 - seam * 0.8);
      vec3 col = asphalt * (1.0 - puddle * 0.5) + refl * reflAmt;

      float d = length(vWorld - cameraPosition);
      float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
      col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `
};

export class WetSurface {
  constructor(scene, camera, quality, fogColor) {
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.fogColor = fogColor;
    this.materials = [];
    this.enabled = quality.reflections;

    if (this.enabled) this._buildReflector();
    else this._buildFallbackGround();
  }

  _buildReflector() {
    const { w, h } = this._targetSize();
    this.reflector = new Reflector(new THREE.PlaneGeometry(4000, 4000), {
      textureWidth: w,
      textureHeight: h,
      clipBias: 0.003,
      multisample: 0,
      shader: WetShader
    });
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.y = 0;
    this.reflector.renderOrder = -10; // draw (and update the mirror) before anything samples it
    this.reflector.material.defines.TAPS = this.quality.reflectionTaps;
    // Pavement: lighter slabs, patchy puddles, duller than the road.
    this._configure(this.reflector.material, { base: 0x14161f, puddle: 0.5, refl: 0.75, streak: 1.3, dry: 0.14, tiles: 1 });
    this.materials.push(this.reflector.material);

    // Keep a world-space texture matrix in sync so other flat surfaces (the
    // road) can sample the same mirror image.
    const worldTexMatrix = this.reflector.material.uniforms.uWorldTexMatrix.value;
    const texMatrix = this.reflector.material.uniforms.textureMatrix.value;
    const inv = new THREE.Matrix4();
    const originalOnBeforeRender = this.reflector.onBeforeRender;
    this.reflector.onBeforeRender = (renderer, scene, cam) => {
      originalOnBeforeRender(renderer, scene, cam);
      inv.copy(this.reflector.matrixWorld).invert();
      worldTexMatrix.multiplyMatrices(texMatrix, inv);
    };

    this.scene.add(this.reflector);
    this.ground = this.reflector;
  }

  _buildFallbackGround() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x06070b, roughness: 0.32, metalness: 0.75, envMapIntensity: 0.9 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), mat);
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
  }

  _configure(mat, { base, puddle, refl, streak, dry = 0.25, tiles = 0 }) {
    const u = mat.uniforms;
    u.uBase.value = new THREE.Color(base);
    u.uPuddle.value = puddle;
    u.uReflStrength.value = refl;
    u.uStreak.value = streak;
    u.uDry.value = dry;
    u.uTiles.value = tiles;
    u.uFogColor.value = this.fogColor;
    u.uFogDensity.value = this.quality.fogDensity;
  }

  // Material for other ground-level surfaces (the road ribbon). Falls back to
  // a glossy standard material when reflections are disabled.
  createSurfaceMaterial({ base = 0x0b0c12, puddle = 0.45, refl = 1.0, streak = 1.0, dry = 0.25, tiles = 0 } = {}) {
    if (!this.enabled) {
      return new THREE.MeshStandardMaterial({ color: base, roughness: 0.28, metalness: 0.7, envMapIntensity: 1.0 });
    }
    const src = this.reflector.material;
    const mat = new THREE.ShaderMaterial({
      name: 'WetRoad',
      defines: { TAPS: this.quality.reflectionTaps },
      uniforms: {
        ...THREE.UniformsUtils.clone(WetShader.uniforms),
        tDiffuse: src.uniforms.tDiffuse,
        uWorldTexMatrix: src.uniforms.uWorldTexMatrix,
        uTime: src.uniforms.uTime
      },
      vertexShader: WetShader.vertexShader,
      fragmentShader: WetShader.fragmentShader,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this._configure(mat, { base, puddle, refl, streak, dry, tiles });
    this.materials.push(mat);
    return mat;
  }

  _targetSize() {
    const pr = Math.min(window.devicePixelRatio, this.quality.pixelRatioCap);
    const s = this.quality.reflectionScale || 0.5;
    return { w: Math.max(256, Math.floor(window.innerWidth * pr * s)), h: Math.max(256, Math.floor(window.innerHeight * pr * s)) };
  }

  setSize() {
    if (!this.reflector) return;
    const { w, h } = this._targetSize();
    this.reflector.getRenderTarget().setSize(w, h);
  }

  update(elapsed) {
    if (this.reflector) this.reflector.material.uniforms.uTime.value = elapsed;
  }

  dispose() {
    this.scene.remove(this.ground);
    if (this.reflector) this.reflector.dispose();
    else { this.ground.geometry.dispose(); this.ground.material.dispose(); }
    this.materials.forEach((m) => m.dispose && m.dispose());
  }
}
