import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Lens + grade pass, applied in linear HDR before the OutputPass does ACES
// tone mapping and sRGB conversion. Combines:
//  - radial (zoom) blur driven by speed / nitro   -> velocity effect
//  - chromatic aberration growing toward the edges
//  - split-tone grade: shadows pushed to deep blue, highlights to magenta
//  - vignette, subtle film grain, nitro heat-shimmer distortion
const LensGradeShader = {
  name: 'NeonLensGrade',
  defines: { BLUR_TAPS: 6 },
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRadialBlur: { value: 0 },
    uAberration: { value: 0.0015 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
    uDistort: { value: 0 },
    uFlash: { value: 0 },
    uShadowTint: { value: new THREE.Vector3(0.82, 0.9, 1.18) },
    uHighlightTint: { value: new THREE.Vector3(1.1, 0.96, 1.06) },
    uAspect: { value: 1 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uRadialBlur, uAberration, uVignette, uGrain, uDistort, uFlash, uAspect;
    uniform vec3 uShadowTint, uHighlightTint;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      // Heat shimmer (nitro only): thin horizontal wobble.
      uv.x += sin(uv.y * 90.0 + uTime * 38.0) * 0.0009 * uDistort;
      uv.y += cos(uv.x * 70.0 + uTime * 31.0) * 0.0006 * uDistort;

      vec2 toCenter = uv - 0.5;
      vec2 aspectVec = vec2(toCenter.x * uAspect, toCenter.y);
      float dist = length(aspectVec);

      // Radial blur, weighted so the centre stays sharp.
      float blur = uRadialBlur * smoothstep(0.12, 0.75, dist);
      vec3 col = vec3(0.0);
      float ca = uAberration * (0.4 + dist * 1.6);
      for (int i = 0; i < BLUR_TAPS; i++) {
        float t = float(i) / float(BLUR_TAPS);
        vec2 suv = uv - toCenter * blur * t * 0.16;
        col.r += texture2D(tDiffuse, suv - toCenter * ca).r;
        col.g += texture2D(tDiffuse, suv).g;
        col.b += texture2D(tDiffuse, suv + toCenter * ca).b;
      }
      col /= float(BLUR_TAPS);

      // Split-tone grade in linear space.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float hl = smoothstep(0.05, 1.2, lum);
      col *= mix(uShadowTint, uHighlightTint, hl);

      // Vignette.
      float vig = smoothstep(1.05, 0.28, dist);
      col *= mix(1.0 - uVignette, 1.0, vig);

      // Film grain (luminance-weighted so blacks stay clean).
      float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime * 7.13));
      col *= 1.0 + (n - 0.5) * uGrain * (0.4 + hl);

      col += uFlash * vec3(0.6, 0.9, 1.0);
      if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `
};

export class PostFX {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: quality.msaaSamples
    });
    this.composer = new EffectComposer(renderer, this.target);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight),
      quality.bloomStrength, quality.bloomRadius, quality.bloomThreshold);
    this.composer.addPass(this.bloom);

    this.lens = new ShaderPass(LensGradeShader);
    this.composer.addPass(this.lens);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.flash = 0;
    this.applyQuality(quality);
    this.setSize(window.innerWidth, window.innerHeight);
  }

  applyQuality(q) {
    this.bloom.strength = q.bloomStrength;
    this.bloom.radius = q.bloomRadius;
    this.bloom.threshold = q.bloomThreshold;
    this.lens.uniforms.uGrain.value = q.grain;
    if (this.lens.material.defines.BLUR_TAPS !== q.radialBlurTaps) {
      this.lens.material.defines.BLUR_TAPS = q.radialBlurTaps;
      this.lens.material.needsUpdate = true;
    }
    if (this.target.samples !== q.msaaSamples) {
      this.composer.renderTarget1.samples = q.msaaSamples;
      this.composer.renderTarget2.samples = q.msaaSamples;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
  }

  triggerFlash(amount = 0.35) {
    this.flash = Math.max(this.flash, amount);
  }

  // speedRatio 0..1+, nitro bool, trauma 0..1 (camera shake energy)
  update(dt, { speedRatio = 0, nitro = false, trauma = 0, time = 0 } = {}) {
    const u = this.lens.uniforms;
    u.uTime.value = time;
    const targetBlur = (nitro ? 0.85 : 0) + Math.max(0, speedRatio - 0.55) * 0.9;
    u.uRadialBlur.value += (targetBlur - u.uRadialBlur.value) * (1 - Math.exp(-5 * dt));
    const targetDistort = nitro ? 1 : 0;
    u.uDistort.value += (targetDistort - u.uDistort.value) * (1 - Math.exp(-4 * dt));
    u.uAberration.value = 0.0012 + u.uRadialBlur.value * 0.0035 + trauma * 0.004;
    this.flash = Math.max(0, this.flash - dt * 2.5);
    u.uFlash.value = this.flash * this.flash;
  }

  setMenuMode(isMenu) {
    // Heavier vignette behind menus pulls focus to the UI.
    this.lens.uniforms.uVignette.value = isMenu ? 0.55 : 0.42;
  }

  // Render targets are sized in whole device pixels: EffectComposer's own
  // pixel-ratio path produces fractional sizes (e.g. 374 * 1.25 = 467.5).
  setSize(w, h) {
    this._w = w;
    this._h = h;
    this._applySize();
  }

  setPixelRatio(pr) {
    this._pr = pr;
    this._applySize();
  }

  _applySize() {
    if (!this._w) return;
    const pr = this._pr || this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(this._w * pr));
    const h = Math.max(1, Math.floor(this._h * pr));
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);
    this.lens.uniforms.uAspect.value = w / h;
  }

  render() {
    this.composer.render();
  }
}
