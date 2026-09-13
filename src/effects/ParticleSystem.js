import * as THREE from 'three';

// Pooled GPU point-sprite particles with per-particle colour, size and alpha
// over lifetime. A fixed-size ring buffer means zero allocation per frame.
export class ParticleSystem {
  constructor(scene, { maxParticles = 200, blending = THREE.AdditiveBlending, gravity = 0, drag = 0.98, softness = 1.0 } = {}) {
    this.max = maxParticles;
    this.gravity = gravity;
    this.drag = drag;

    this.positions = new Float32Array(maxParticles * 3);
    this.colors = new Float32Array(maxParticles * 3);
    this.sizes = new Float32Array(maxParticles);
    this.alphas = new Float32Array(maxParticles);

    this.vel = new Float32Array(maxParticles * 3);
    this.life = new Float32Array(maxParticles);
    this.maxLife = new Float32Array(maxParticles);
    this.size0 = new Float32Array(maxParticles);
    this.size1 = new Float32Array(maxParticles);
    this.color0 = new Float32Array(maxParticles * 3);
    this.color1 = new Float32Array(maxParticles * 3);
    this.cursor = 0;
    this.activeCount = 0;

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);

    const additive = blending === THREE.AdditiveBlending;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: { uScale: { value: window.innerHeight * 0.5 }, uSoft: { value: softness } },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uSoft;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.0 + uSoft) * vAlpha;
          if (a < 0.003) discard;
          ${additive ? 'gl_FragColor = vec4(vColor * a, 1.0);' : 'gl_FragColor = vec4(vColor, a);'}
        }
      `
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    for (let i = 0; i < maxParticles; i++) this.positions[i * 3 + 1] = -9999;
  }

  // color0/color1 are THREE.Color (linear, HDR allowed) blended over lifetime.
  spawn(pos, vel, life, size0, size1, color0, color1 = color0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.vel[i * 3] = vel.x;
    this.vel[i * 3 + 1] = vel.y;
    this.vel[i * 3 + 2] = vel.z;
    this.color0[i * 3] = color0.r; this.color0[i * 3 + 1] = color0.g; this.color0[i * 3 + 2] = color0.b;
    this.color1[i * 3] = color1.r; this.color1[i * 3 + 1] = color1.g; this.color1[i * 3 + 2] = color1.b;
  }

  update(dt) {
    const drag = Math.pow(this.drag, dt * 60);
    let active = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        this.positions[i * 3 + 1] = -9999;
        continue;
      }
      active++;
      const k = 1 - this.life[i] / this.maxLife[i]; // 0 -> 1 over lifetime
      const i3 = i * 3;
      this.vel[i3 + 1] += this.gravity * dt;
      this.vel[i3] *= drag; this.vel[i3 + 1] *= drag; this.vel[i3 + 2] *= drag;
      this.positions[i3] += this.vel[i3] * dt;
      this.positions[i3 + 1] += this.vel[i3 + 1] * dt;
      this.positions[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.gravity !== 0 && this.positions[i3 + 1] < 0.05) {
        this.positions[i3 + 1] = 0.05;
        this.vel[i3 + 1] *= -0.35;
      }
      this.sizes[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * k;
      this.alphas[i] = Math.min(1, k * 8) * (1 - k);
      this.colors[i3] = this.color0[i3] + (this.color1[i3] - this.color0[i3]) * k;
      this.colors[i3 + 1] = this.color0[i3 + 1] + (this.color1[i3 + 1] - this.color0[i3 + 1]) * k;
      this.colors[i3 + 2] = this.color0[i3 + 2] + (this.color1[i3 + 2] - this.color0[i3 + 2]) * k;
    }
    this.activeCount = active;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  setViewportHeight(h) {
    this.material.uniforms.uScale.value = h * 0.5;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
