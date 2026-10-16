// Focus-mode "power-up" aura: a flickering energy flame around the character, sparks rising off
// it, a glow on the floor, and a shockwave + flash at the moment they switch Focus on.
// Pure three.js, additive blending, no textures.
import { THREE } from './avatar.js';

const VERT = /* glsl */`
  uniform float uTime, uSpeed;
  varying vec2 vUv;
  varying float vRim;
  void main() {
    vUv = uv;
    // the flame wobbles: ripples run up the shell and get stronger towards the tip
    float a = uv.x * 6.2831853, t = uTime * uSpeed;
    float ripple = sin(a * 6.0 + t * 5.0 + uv.y * 9.0) * 0.6 + sin(a * 3.0 - t * 3.0 + uv.y * 5.0) * 0.4;
    vec3 p = position + normal * ripple * (0.02 + uv.y * 0.07);
    p.y += sin(a * 4.0 + t * 6.0) * 0.08 * uv.y * uv.y;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vec3 v = normalize(cameraPosition - wp.xyz);
    vRim = 1.0 - abs(dot(n, v));          // bright at the silhouette, clear in the middle
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const FRAG = /* glsl */`
  uniform float uTime, uPower, uSpeed;
  uniform vec3 uColor, uCore;
  varying vec2 vUv;
  varying float vRim;
  float wave(float x) { return 0.5 + 0.5 * sin(x); }
  void main() {
    float a = vUv.x * 6.2831853;
    float y = vUv.y;
    float t = uTime * uSpeed;
    // separate tongues of flame racing upwards, each with a ragged tip
    float tongues = wave(a * 7.0 + sin(y * 3.0 + t) * 1.5) ;
    tongues = pow(tongues, 1.5);
    float licks = 0.6 * wave(a * 13.0 - t * 4.0 + y * 11.0) + 0.4 * wave(a * 5.0 + t * 2.5 - y * 6.0);
    float height = 0.35 + 0.65 * tongues * (0.7 + 0.3 * licks);   // how far up each tongue reaches
    float body = smoothstep(height, height - 0.3, y);
    float streak = 0.55 + 0.45 * wave(y * 14.0 - t * 8.0 + a * 3.0);   // energy rushing upwards
    float base = smoothstep(0.0, 0.06, y);
    float rim = pow(vRim, 1.3);
    float alpha = clamp(body * base * streak * (0.12 + rim * 1.5) * uPower, 0.0, 0.9);
    vec3 col = mix(uColor, uCore, clamp(rim * 0.5 + (1.0 - y) * 0.4 + licks * 0.3, 0.0, 1.0));
    gl_FragColor = vec4(col, alpha);
  }`;

// a teardrop shell: wide around the body, flaring to a point above the head
function shellGeometry(scale) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const y = i / 24;
    const r = (0.36 + Math.sin(y * Math.PI * 0.85) * 0.22) * (1 - Math.pow(y, 2.2) * 0.92);
    pts.push(new THREE.Vector2(r * scale, y * 2.05 * scale));
  }
  return new THREE.LatheGeometry(pts, 48);
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let GLOW = null;

export class FocusAura {
  constructor({ color = '#7C3AED', core = '#5EEAD4', size = 1 } = {}) {
    this.size = size;
    GLOW ||= glowTexture();
    this.group = new THREE.Group();
    this.group.visible = false;
    this.power = 0;      // 0..1, eased
    this.target = 0;
    this.burstAt = -10;

    const flame = (scale, speed, c1, c2) => {
      const m = new THREE.ShaderMaterial({
        // normal blending so it reads on the light desk too (additive vanishes on white)
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
        blending: THREE.NormalBlending, side: THREE.DoubleSide,
        uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uSpeed: { value: speed }, uColor: { value: new THREE.Color(c1) }, uCore: { value: new THREE.Color(c2) } },
      });
      const mesh = new THREE.Mesh(shellGeometry(scale), m);
      mesh.renderOrder = 5;
      this.group.add(mesh);
      return mesh;
    };
    this.outer = flame(1.0, 1.0, color, core);
    this.inner = flame(0.82, 1.6, core, '#ffffff');

    // sparks drifting up through the flame
    const N = 48;
    this.sparkSeed = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, r: 0.15 + Math.random() * 0.4, s: 0.6 + Math.random() * 0.9, o: Math.random() }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({
      map: GLOW, color: '#ffffff', size: 0.11, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    }));
    this.sparks.renderOrder = 6;
    this.group.add(this.sparks);

    // glow pool on the floor + shockwave ring for the power-up moment
    const disc = (size, c) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
        map: GLOW, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
      }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.02;
      this.group.add(m);
      return m;
    };
    this.pool = disc(1.8, color);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 64), new THREE.MeshBasicMaterial({
      color: core, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide,
    }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.03;
    this.group.add(this.ring);
    this.flash = disc(2.6, core);
    this.flash.rotation.x = 0; this.flash.position.y = 0.9; // a camera-ish facing burst of light

    this.light = new THREE.PointLight(color, 0, 2.6, 2);
    this.light.position.y = 1.0;
    this.group.add(this.light);
  }

  // on: should the aura show; t: scene time
  set(on, t) {
    const want = on ? 1 : 0;
    if (want && !this.target) this.burstAt = t;   // power-up moment
    this.target = want;
  }

  update(t, dt, pos, { seated = true, faceCamera = null } = {}) {
    this.power += (this.target - this.power) * Math.min(1, dt * (this.target ? 2.2 : 4));
    const burst = Math.max(0, 1 - (t - this.burstAt) / 0.9);     // 1 → 0 over the first 0.9 s
    const p = this.power;
    this.group.visible = p > 0.01 || burst > 0;
    if (!this.group.visible) return;
    this.group.position.copy(pos);
    this.group.scale.setScalar(this.size);
    // flicker + a surge during the power-up
    const flick = 0.9 + Math.sin(t * 13.0) * 0.05 + Math.sin(t * 29.0) * 0.04;
    const surge = 1 + burst * 0.6;
    const yScale = seated ? 0.95 : 1;
    for (const [mesh, k] of [[this.outer, 1], [this.inner, 0.85]]) {
      mesh.material.uniforms.uTime.value = t;
      mesh.material.uniforms.uPower.value = p * flick * k * surge * 1.2;
      mesh.scale.set(surge * (0.96 + 0.04 * Math.sin(t * 7)), yScale * (surge * 0.9 + 0.1) * (0.97 + 0.05 * Math.sin(t * 5.3)), surge * (0.96 + 0.04 * Math.cos(t * 7)));
    }
    // sparks
    const arr = this.sparks.geometry.attributes.position.array;
    this.sparkSeed.forEach((s, i) => {
      const life = (t * s.s * 0.6 + s.o) % 1;
      const a = s.a + t * 0.8 * s.s;
      const r = s.r * (1 - life * 0.6);
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = (0.1 + life * 1.9) * yScale;
      arr[i * 3 + 2] = Math.sin(a) * r;
    });
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.material.opacity = p * 0.9;
    this.pool.material.opacity = p * (0.45 + 0.1 * Math.sin(t * 6));
    // shockwave ring races outwards, flash fades
    const k = 1 - burst;
    this.ring.material.opacity = burst * 0.9;
    this.ring.scale.setScalar(1 + k * 4);
    this.flash.material.opacity = Math.pow(burst, 2) * 0.8;
    if (faceCamera) this.flash.quaternion.copy(faceCamera.quaternion);
    this.light.intensity = p * (1.2 + 0.4 * Math.sin(t * 11)) + burst * 4;
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }
}
