import * as THREE from 'three';
import { neon } from '../config/settings.js';
import { LAYER_NO_REFLECT } from '../world/WetSurface.js';

// Procedurally modelled original sports car (no external GLTF: keeps the
// project self-contained and licence-free). Built from extruded side profiles
// so it reads as a low, wedge-shaped hypercar rather than a stack of boxes.

let shared = null;

function profileGeometry(points, width, bevel = 0.06) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4
  });
  // Shape X -> car forward (+Z), extrusion -> lateral (X), centred.
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - bevel * 2) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function radialTexture(stretchY = 1) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = Math.round(128 * stretchY);
  const g = c.getContext('2d');
  g.translate(64, c.height / 2);
  g.scale(1, stretchY);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(-64, -64, 128, 128);
  return new THREE.CanvasTexture(c);
}

function getShared() {
  if (shared) return shared;
  const body = profileGeometry([
    [-2.32, 0.26], [-2.34, 0.78], [-1.5, 0.9], [-0.2, 0.86], [1.2, 0.8], [2.02, 0.64], [2.46, 0.4], [2.36, 0.24]
  ], 2.0, 0.08);
  const cabin = profileGeometry([
    [-1.45, 0.84], [-0.7, 1.2], [0.2, 1.24], [1.12, 0.86], [1.12, 0.82], [-1.45, 0.82]
  ], 1.5, 0.05);
  const tire = new THREE.CylinderGeometry(0.43, 0.43, 0.36, 24);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.TorusGeometry(0.3, 0.035, 8, 28);
  rim.rotateY(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.2, 0.2, 0.38, 6);
  hub.rotateZ(Math.PI / 2);

  // Cone apex sits at +Y by default. Flame: wide base at the nozzle (z=0),
  // tip trailing 1.6 m behind. Beam: apex at the headlight, opening forward.
  const flame = new THREE.ConeGeometry(0.2, 1.6, 14, 1, true);
  flame.translate(0, 0.8, 0);
  flame.rotateX(-Math.PI / 2);

  const beam = new THREE.ConeGeometry(3.2, 18, 20, 1, true);
  beam.translate(0, -9, 0);
  beam.rotateX(-Math.PI / 2);

  shared = {
    body, cabin, tire, rim, hub, flame, beam,
    glowTex: radialTexture(1),
    poolTex: radialTexture(1.8),
    tireMat: new THREE.MeshStandardMaterial({ color: 0x0a0a0d, roughness: 0.85, metalness: 0.1 }),
    hubMat: new THREE.MeshStandardMaterial({ color: 0x2a2d38, roughness: 0.3, metalness: 0.95 }),
    glassMat: new THREE.MeshPhysicalMaterial({ color: 0x05070c, roughness: 0.04, metalness: 0.9, clearcoat: 1, envMapIntensity: 1.6 }),
    trimMat: new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.5, metalness: 0.6 })
  };
  return shared;
}

function flameMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: color }, uCore: { value: neon(0xffffff, 3) }, uIntensity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      uniform float uTime;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.xy *= 1.0 + sin(uTime * 60.0 + position.z * 9.0) * 0.08;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uCore;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        // Cone uv.y is 1 at the apex (tip), 0 at the nozzle. Clamp: with MSAA
        // the interpolated uv can land just outside [0,1], and pow() of a
        // negative base is NaN (bloom then smears it over the whole screen).
        float along = clamp(1.0 - vUv.y, 0.0, 1.0);
        vec3 col = mix(uColor, uCore, pow(along, 3.0));
        float a = pow(along, 1.4) * uIntensity;
        gl_FragColor = vec4(col * a, 1.0);
      }`
  });
}

// Faint volumetric headlight cone: fades along its length, toward its
// silhouette edges, and when the camera is close (so it never reads as a
// solid wedge from the chase camera).
function beamMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    uniforms: { uColor: { value: color } },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying float vFacing; varying float vDist;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        vDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; varying vec2 vUv; varying float vFacing; varying float vDist;
      void main() {
        float a = pow(clamp(vUv.y, 0.0, 1.0), 1.8) * pow(clamp(vFacing, 0.0, 1.0), 2.5) * smoothstep(2.0, 9.0, vDist) * 0.05;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`
  });
}

export function buildCarMesh({ bodyColor = 0x1a2233, accentColor = 0x21f3ff, headlights = true } = {}) {
  const S = getShared();
  const root = new THREE.Group();
  const chassis = new THREE.Group(); // pitches/rolls for weight transfer
  root.add(chassis);

  const accent = neon(accentColor, 3.4);
  const accentMat = new THREE.MeshBasicMaterial({ color: accent });
  const rimMat = new THREE.MeshBasicMaterial({ color: neon(accentColor, 1.4) });
  // Glossy metallic clear-coat that picks up the neon environment map — this
  // is what makes the dark car read against a dark street.
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: bodyColor, metalness: 0.75, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 2.4,
    emissive: new THREE.Color(accentColor), emissiveIntensity: 0.025
  });

  const body = new THREE.Mesh(S.body, bodyMat);
  chassis.add(body);
  const cabin = new THREE.Mesh(S.cabin, S.glassMat);
  chassis.add(cabin);

  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    chassis.add(m);
    return m;
  };

  // Neon side lines, roof spine, spoiler.
  [-1.005, 1.005].forEach((x) => box(0.03, 0.05, 3.6, accentMat, x, 0.5, 0.05));
  box(0.05, 0.03, 1.3, accentMat, 0, 1.27, -0.2);
  box(0.12, 0.34, 0.12, S.trimMat, -0.72, 1.0, -2.05);
  box(0.12, 0.34, 0.12, S.trimMat, 0.72, 1.0, -2.05);
  box(1.95, 0.07, 0.48, S.trimMat, 0, 1.2, -2.12);
  box(1.95, 0.025, 0.05, accentMat, 0, 1.24, -2.35);
  box(1.7, 0.18, 0.3, S.trimMat, 0, 0.3, -2.25); // diffuser

  // Front light bar + headlight eyes.
  const headMat = new THREE.MeshBasicMaterial({ color: neon(0xe6fbff, 5) });
  box(1.5, 0.035, 0.05, headMat, 0, 0.6, 2.2);
  [-0.68, 0.68].forEach((x) => {
    const eye = box(0.42, 0.07, 0.06, headMat, x, 0.56, 2.28);
    eye.rotation.y = x > 0 ? -0.25 : 0.25;
  });

  // Full-width rear light bar (brightens under braking).
  const tailMat = new THREE.MeshBasicMaterial({ color: neon(0xff1a2e, 2.2) });
  box(1.9, 0.07, 0.05, tailMat, 0, 0.72, -2.37);
  [-0.8, 0.8].forEach((x) => box(0.25, 0.14, 0.05, tailMat, x, 0.64, -2.37));

  // Wheels: pivot (steering) -> spinner (roll) -> tire + glowing rim.
  const wheels = [];
  const steerPivots = [];
  [[-0.98, 1.42], [0.98, 1.42], [-0.98, -1.42], [0.98, -1.42]].forEach(([x, z], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.43, z);
    const spinner = new THREE.Group();
    spinner.add(new THREE.Mesh(S.tire, S.tireMat));
    const rim = new THREE.Mesh(S.rim, rimMat);
    rim.position.x = x > 0 ? 0.19 : -0.19;
    spinner.add(rim);
    spinner.add(new THREE.Mesh(S.hub, S.hubMat));
    pivot.add(spinner);
    root.add(pivot);
    wheels.push(spinner);
    if (i < 2) steerPivots.push(pivot);
  });

  // Exhausts + nitro flames.
  const exhaustAnchors = [];
  const flames = [];
  [-0.45, 0.45].forEach((x) => {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 10).rotateX(Math.PI / 2), S.hubMat);
    tip.position.set(x, 0.36, -2.36);
    chassis.add(tip);
    const anchor = new THREE.Object3D();
    anchor.position.set(x, 0.36, -2.5);
    chassis.add(anchor);
    exhaustAnchors.push(anchor);
    const flame = new THREE.Mesh(S.flame, flameMaterial(neon(accentColor, 2.5)));
    flame.position.set(x, 0.36, -2.46);
    flame.scale.setScalar(0.001);
    chassis.add(flame);
    flames.push(flame);
  });

  // Underglow on the ground.
  const underMat = new THREE.MeshBasicMaterial({
    map: S.glowTex, color: neon(accentColor, 0.55), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 6.4), underMat);
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.09;
  under.layers.set(LAYER_NO_REFLECT);
  root.add(under);

  // Fake volumetric headlight beams + light pool on the road ahead.
  let beamMat = null;
  if (headlights) {
    beamMat = beamMaterial(neon(0xd8f4ff, 1));
    [-0.68, 0.68].forEach((x) => {
      const beam = new THREE.Mesh(S.beam, beamMat);
      beam.position.set(x, 0.56, 2.3);
      beam.rotation.x = 0.07;
      beam.layers.set(LAYER_NO_REFLECT);
      chassis.add(beam);
    });
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 16),
      new THREE.MeshBasicMaterial({ map: S.poolTex, color: neon(0xcfefff, 0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.1, 10);
    pool.layers.set(LAYER_NO_REFLECT);
    root.add(pool);
  }

  return { root, chassis, wheels, steerPivots, bodyMat, tailMat, headMat, underMat, beamMat, exhaustAnchors, flames, accent };
}
