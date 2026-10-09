// Cartoon "vector" look for three.js: cel shading + ink outlines.
import * as THREE from './three.module.min.js';

// 3-band light ramp: shadow / mid / lit. Nearest filtering gives hard, illustrated edges.
let ramp = null;
export function toonRamp() {
  if (ramp) return ramp;
  const tones = [110, 190, 255];
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  ramp = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

export function toonMat(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...opts });
}

/** Flat, unlit colour — for eyes, highlights, mouths (reads like a vector fill). */
export function flatMat(color, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, ...opts });
}

/**
 * Ink outline material (inverted hull). Vertices are pushed out along their
 * normals in the vertex shader, and only back faces are drawn.
 */
export function outlineMat(color = '#1f2433', width = 0.02) {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.userData.width = { value: width };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = m.userData.width;
    shader.vertexShader = 'uniform float outlineWidth;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;',
    );
  };
  m.customProgramCacheKey = () => 'deskmate-outline';
  return m;
}

const HULL_SCALE_TYPES = new Set(['BoxGeometry', 'CylinderGeometry', 'ConeGeometry']);

/**
 * Add an ink outline to a mesh. Smooth shapes extrude along normals;
 * hard-edged convex shapes (boxes, cylinders) use a scaled hull so corners stay closed.
 */
export function outline(mesh, mat) {
  const width = mat.userData.width.value;
  let hull;
  if (HULL_SCALE_TYPES.has(mesh.geometry.type)) {
    mesh.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    mesh.geometry.boundingBox.getSize(size);
    hull = new THREE.Mesh(mesh.geometry, scaledHullMat(mat));
    hull.scale.set(1 + (2 * width) / Math.max(size.x, 1e-3), 1 + (2 * width) / Math.max(size.y, 1e-3), 1 + (2 * width) / Math.max(size.z, 1e-3));
  } else {
    hull = new THREE.Mesh(mesh.geometry, mat);
  }
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.userData.isOutline = true;
  hull.raycast = () => {}; // never pickable
  mesh.add(hull);
  return hull;
}

// scaled hulls must not also be normal-extruded
const plainHulls = new WeakMap();
function scaledHullMat(mat) {
  if (!plainHulls.has(mat)) {
    const m = new THREE.MeshBasicMaterial({ color: mat.color, side: THREE.BackSide });
    m.userData.width = mat.userData.width;
    m.userData.twin = mat;
    plainHulls.set(mat, m);
  }
  return plainHulls.get(mat);
}

/** Damped spring — gives the bouncy, overshooting feel of Lottie/After Effects motion. */
export class Spring {
  constructor(value = 0, stiffness = 170, damping = 15) {
    this.x = value; this.v = 0; this.target = value; this.k = stiffness; this.c = damping;
  }
  step(dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = this.k * (this.target - this.x) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  kick(v) { this.v += v; }
  snap(x) { this.x = this.target = x; this.v = 0; }
}

export const ease = {
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  outBack: (u, s = 1.70158) => 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2),
  bump: (u) => (u <= 0 || u >= 1 ? 0 : Math.sin(u * Math.PI)),
};

export { THREE };
