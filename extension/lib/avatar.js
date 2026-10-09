// Deskmate teammate — soft "animated film" style 3D kid built procedurally:
// big glossy eyes, thick brows, button nose, swoopy quiff, hoodie with drawstrings,
// joggers with a side stripe, chunky sneakers. Motion is spring-driven
// (anticipation, overshoot, squash & stretch) for a Lottie / Pixar feel.
import { THREE, Spring, ease } from './toon.js';
import { mergeGeometries } from './BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const HEAD_R = 0.28;
const NECK_Y = 0.52;      // hips → neck
const STAND_HIPS = 0.58;
const SIT_HIPS = 0.47;

/** Lighten/darken a hex colour. */
export function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)));
  return c;
}

const soft = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0, ...o });
const fabric = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0 });
const skinMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0, emissive: shade(color, -0.1), emissiveIntensity: 0.06 });
const gloss = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0 });
const flat = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });

/** Studio lighting used by every Deskmate 3D view (key, fill, rim, sky). */
export function addSoftLights(scene, { shadows = true } = {}) {
  const hemi = new THREE.HemisphereLight('#ffffff', '#c9cfdc', 1.15);
  const key = new THREE.DirectionalLight('#fff1e2', 2.3);
  key.position.set(3, 6, 5);
  if (shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -8; key.shadow.camera.right = 8;
    key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
    key.shadow.radius = 6;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
  }
  const fill = new THREE.DirectionalLight('#dce6ff', 0.7);
  fill.position.set(-5, 3, 3);
  const rim = new THREE.DirectionalLight('#ffffff', 1.4);
  rim.position.set(-2, 5, -6);
  scene.add(hemi, key, fill, rim);
  return { hemi, key, fill, rim };
}

export function configureRenderer(r) {
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.0;
}

// ---------------------------------------------------------------- geometry helpers
function latheFrom(points, segs = 48) {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r, y)));
  const g = new THREE.LatheGeometry(curve.getPoints(48), segs);
  g.computeVertexNormals();
  return { geo: g, curve };
}

// A teardrop "lock" of hair that tapers to a tip and curls (bend) toward +z.
function lockGeometry(len, rad, bend, flatten = 0.7) {
  const g = new THREE.SphereGeometry(1, 18, 12);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const u = (v.y + 1) / 2;                       // 0 root … 1 tip
    const taper = (1 - Math.pow(u, 2.0) * 0.94) * (0.75 + 0.25 * Math.sin(Math.min(1, u * 3) * Math.PI / 2));
    const x = v.x * rad * taper;
    const z = v.z * rad * taper * flatten;
    const y = u * len;
    pos.setXYZ(i, x, y, z + bend * len * u * u);
  }
  g.computeVertexNormals();
  return g;
}

// Single smooth head: rounder cheeks and a soft jaw (no seams between parts).
function headGeometry() {
  const g = new THREE.SphereGeometry(HEAD_R, 56, 42);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ny = y / HEAD_R;
    const cheek = Math.exp(-((ny + 0.32) ** 2) / 0.09) * 0.11;   // chubby cheeks
    x *= 1 + cheek;
    if (z > 0) z *= 1 + cheek * 0.55;
    if (ny < -0.55) y = -HEAD_R * (0.55 + (-ny - 0.55) * 0.82);  // softer, shorter chin
    if (z < 0) z *= 0.94;                                          // flatter back
    pos.setXYZ(i, x, y * 1.02, z * 0.97);
  }
  g.computeVertexNormals();
  return g;
}

function pickEye(seed) {
  const eyes = ['#3aa6a1', '#6b4a33', '#3e72c4', '#4d8a46', '#7a5a3a'];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return eyes[h % eyes.length];
}

// ---------------------------------------------------------------- the character
export function createAvatar({
  color = '#6C8CFF', skin = '#F5D0B5', hair = '#3b2a1f', style = 'short', eyes: eyeColor, glasses = 'none',
} = {}) {
  const root = new THREE.Group();
  const rig = new THREE.Group();           // squash & stretch pivots at the floor
  root.add(rig);
  const hips = new THREE.Group();
  rig.add(hips);

  const M = {
    hoodie: fabric(new THREE.Color(color)),
    rib: fabric(shade(color, -0.08)),
    trim: fabric(shade(color, -0.14)),
    tee: fabric('#eef0f4'),
    pants: fabric(shade(color, -0.42)),
    stripe: soft('#f4f4f2'),
    skin: skinMat(skin),
    nose: skinMat(shade(skin, -0.03)),
    hair: new THREE.MeshStandardMaterial({ color: hair, roughness: 0.45, metalness: 0 }),
    brow: soft(shade(hair, -0.04), { roughness: 0.8 }),
    sclera: gloss('#ffffff'),
    iris: gloss(eyeColor || pickEye(skin + hair + color)),
    pupil: gloss('#14161c'),
    shine: flat('#ffffff'),
    lip: soft(shade(skin, -0.28), { roughness: 0.6 }),
    mouth: soft('#5b2333'),
    tongue: soft('#f08b9b'),
    teeth: soft('#ffffff'),
    blush: flat('#ff9a9a', { transparent: true, opacity: 0.28, depthWrite: false }),
    shoe: soft('#fbfbfb', { roughness: 0.55 }),
    sole: soft('#e9e6e1', { roughness: 0.8 }),
    accent: soft(shade(color, 0.05), { roughness: 0.5 }),
    lace: soft('#ffffff'),
    zip: soft('#9aa0aa', { metalness: 0.4, roughness: 0.4 }),
    gear: soft('#2a2e38', { roughness: 0.45 }),
    gearPad: fabric(shade(color, 0.1)),
    bowl: soft('#ef6b5b', { roughness: 0.35 }),
    bowlIn: soft('#ffffff', { roughness: 0.35 }),
    noodle: soft('#F4C152'),
    wood: soft('#c9965f'),
  };

  const mesh = (geo, mat, parent, { shadow = true } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    if (parent) parent.add(m);
    return m;
  };
  const sphere = (r, w = 40, h = 28, ...rest) => new THREE.SphereGeometry(r, Math.min(w, 32), Math.min(h, 22), ...rest);
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 8, 20);

  // ================= hoodie torso
  const { geo: torsoGeo, curve: torsoCurve } = latheFrom([
    [0.0, -0.02], [0.16, -0.01], [0.198, 0.05], [0.205, 0.17], [0.2, 0.3],
    [0.19, 0.4], [0.16, 0.47], [0.1, 0.515], [0.0, 0.53],
  ]);
  const torso = mesh(torsoGeo, M.hoodie, hips);
  const hem = mesh(new THREE.TorusGeometry(0.19, 0.024, 16, 64), M.trim, hips);
  hem.rotation.x = Math.PI / 2; hem.position.y = 0.02;
  const pocket = mesh(sphere(0.15, 40, 20), M.rib, hips);          // kangaroo pocket
  pocket.scale.set(0.95, 0.36, 0.28); pocket.position.set(0, 0.13, 0.165);
  const hood = mesh(new THREE.TorusGeometry(0.11, 0.048, 18, 48), M.hoodie, hips); // hood collar
  hood.rotation.x = Math.PI / 2 - 0.4; hood.position.set(0, 0.5, -0.035); hood.scale.set(1.2, 1.05, 1);
  const hoodBack = mesh(sphere(0.17, 40, 24), M.hoodie, hips);
  hoodBack.scale.set(1.15, 0.62, 0.62); hoodBack.position.set(0, 0.45, -0.15);
  for (const s of [-1, 1]) {     // drawstrings
    const str = new THREE.Group();
    str.position.set(s * 0.05, 0.455, 0.14);
    str.rotation.x = 0.12;
    mesh(capsule(0.008, 0.12), M.lace, str, { shadow: false }).position.y = -0.07;
    mesh(capsule(0.011, 0.025), M.zip, str, { shadow: false }).position.y = -0.145;
    hips.add(str);
  }

  // ================= head (pivots at the neck)
  const headG = new THREE.Group();
  headG.position.y = NECK_Y;
  hips.add(headG);
  mesh(capsule(0.07, 0.06), M.skin, headG).position.y = 0.02;
  const head = new THREE.Group();
  head.position.y = HEAD_R + 0.02;
  headG.add(head);
  const skull = mesh(headGeometry(), M.skin, head);
  for (const s of [-1, 1]) {
    const ear = mesh(sphere(0.06, 28, 20), M.skin, head);
    ear.scale.set(0.5, 1, 0.8); ear.position.set(s * 0.272, -0.02, -0.01); ear.rotation.y = s * 0.3;
  }

  const face = new THREE.Group();
  head.add(face);
  // z of the face surface at (x, y): cast a ray at the head mesh
  const ray = new THREE.Raycaster();
  const surf = (x, y) => {
    ray.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(skull, false)[0];
    return hit ? hit.point.z : 0.25;
  };

  // eyes: glossy white, coloured iris, pupil, two highlights
  const eyes = [];
  for (const s of [-1, 1]) {
    const eg = new THREE.Group();
    eg.position.set(s * 0.1, 0.0, surf(0.1, 0.0) - 0.034);
    eg.rotation.y = s * 0.28;
    face.add(eg);
    const lid = new THREE.Group();            // scales for blinks
    eg.add(lid);
    mesh(sphere(0.074, 40, 28), M.sclera, lid, { shadow: false }).scale.set(0.84, 1.0, 0.62);
    const iris = mesh(sphere(0.049, 36, 24), M.iris, lid, { shadow: false });
    iris.scale.set(1, 1.05, 0.42); iris.position.set(0, -0.004, 0.036);
    const pupil = mesh(sphere(0.025, 24, 16), M.pupil, lid, { shadow: false });
    pupil.scale.set(1, 1.05, 0.4); pupil.position.set(0, -0.004, 0.052);
    mesh(sphere(0.014, 12, 10), M.shine, lid, { shadow: false }).position.set(0.016, 0.019, 0.058);
    mesh(sphere(0.007, 10, 8), M.shine, lid, { shadow: false }).position.set(-0.014, -0.02, 0.056);
    eyes.push({ lid, iris, pupil });
  }
  // thick, expressive brows
  const brows = [];
  for (const s of [-1, 1]) {
    const bg = new THREE.Group();
    bg.position.set(s * 0.1, 0.098, surf(0.1, 0.098) - 0.008);
    bg.rotation.set(-0.35, s * 0.3, 0);
    const b = mesh(new THREE.TorusGeometry(0.09, 0.021, 12, 24, 0.8), M.brow, bg, { shadow: false });
    b.rotation.z = Math.PI / 2 - 0.4;
    b.position.y = -0.082;
    b.scale.set(1, 1, 0.6);
    face.add(bg);
    brows.push(bg);
  }
  const nose = mesh(sphere(0.034, 28, 20), M.nose, face);          // button nose
  nose.scale.set(1.15, 0.85, 0.85); nose.position.set(0, -0.065, surf(0, -0.065) - 0.008);
  // mouth: a smile line, or an open mouth that scales
  const mouthG = new THREE.Group();
  mouthG.position.set(0, -0.13, surf(0, -0.13) - 0.003);
  mouthG.rotation.x = 0.42;
  face.add(mouthG);
  const smile = mesh(new THREE.TorusGeometry(0.042, 0.008, 10, 28, Math.PI * 0.8), M.lip, mouthG, { shadow: false });
  smile.rotation.z = Math.PI + Math.PI * 0.1;
  const open = new THREE.Group();
  mouthG.add(open);
  mesh(sphere(0.042, 28, 20), M.mouth, open, { shadow: false }).scale.set(1, 0.8, 0.32);
  const teeth = mesh(sphere(0.03, 20, 10, 0, TAU, 0, Math.PI * 0.35), M.teeth, open, { shadow: false });
  teeth.scale.set(1.1, 0.5, 0.35); teeth.position.set(0, 0.012, 0.004);
  const tongue = mesh(sphere(0.024, 16, 12), M.tongue, open, { shadow: false });
  tongue.scale.set(1.2, 0.55, 0.4); tongue.position.set(0, -0.018, 0.006);
  for (const s of [-1, 1]) {
    const bl = mesh(sphere(0.045, 20, 14), M.blush, face, { shadow: false });
    bl.scale.set(1.2, 0.7, 0.25);
    bl.position.set(s * 0.165, -0.085, surf(0.165, -0.085) - 0.007);
    bl.rotation.y = s * 0.55;
  }

  // ================= hair
  const hairG = new THREE.Group();
  head.add(hairG);
  const cap = mesh(sphere(HEAD_R + 0.016, 64, 36, 0, TAU, 0, Math.PI * 0.52), M.hair, hairG);
  cap.rotation.x = -0.62; cap.scale.set(1.04, 1.03, 1.04);
  const backHead = mesh(sphere(HEAD_R + 0.012, 48, 32), M.hair, hairG);
  backHead.scale.set(1.03, 0.94, 0.88); backHead.position.set(0, 0.0, -0.06);
  const locks = [];
  // place a lock: polar angle (0 = up) / azimuth (0 = front), tilt back, curl
  const lock = (theta, phi, len, rad, bend, tilt = 0, roll = 0, flatten = 0.7, up = 0.25) => {
    const g = new THREE.Group();
    const dir = new THREE.Vector3(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
    g.position.copy(dir).multiplyScalar(HEAD_R * 0.86);
    const target = dir.clone().add(new THREE.Vector3(0, up, -tilt)).normalize();
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), target);
    g.rotateY(Math.PI + roll);   // curl backwards by default
    mesh(lockGeometry(len, rad, bend, flatten), M.hair, g);
    hairG.add(g);
    locks.push(g);
    return g;
  };
  if (style === 'short' || style === 'long' || style === 'spiky') {
    const tall = style === 'spiky';
    // volume on top so the quiff has mass
    const mass = mesh(sphere(0.2, 48, 32), M.hair, hairG);
    mass.scale.set(1.3, tall ? 0.75 : 0.6, 1.05); mass.position.set(0, tall ? 0.21 : 0.19, 0.0); mass.rotation.x = -0.25;
    // quiff: chunky clumps rise from the hairline, sweep up and curl back
    for (let i = 0; i < 5; i++) {
      const phi = -0.7 + i * 0.35;
      const mid = 1 - Math.abs(phi) / 0.8;
      lock(0.86 + Math.abs(phi) * 0.06, phi, (tall ? 0.3 : 0.2) + mid * (tall ? 0.14 : 0.07), 0.13, tall ? 0.32 : 0.65,
        tall ? 0.3 : 0.55, Math.sin(i * 1.7) * 0.3, 0.5, tall ? 1.3 : 0.8);
    }
    // crown clumps, swept back
    for (let i = 0; i < 5; i++) {
      const phi = -1.1 + i * 0.55;
      lock(0.4, phi, tall ? 0.28 : 0.2, 0.12, tall ? 0.3 : 0.6, tall ? 0.7 : 1.1, Math.sin(i * 2.3) * 0.4, 0.5, tall ? 0.8 : 0.3);
    }
    // sides + back, short and tucked
    for (let i = 0; i < 8; i++) {
      const phi = Math.PI / 2 + 0.15 + i * ((Math.PI - 0.3) / 7);
      lock(1.0, phi, 0.15, 0.11, 0.3, 1.6, 0, 0.5, 0);
    }
  }
  if (style === 'long') {
    const backHair = mesh(capsule(0.22, 0.22), M.hair, hairG);
    backHair.position.set(0, -0.15, -0.1); backHair.scale.set(1.3, 1, 0.7);
    for (const s of [-1, 1]) {
      const side = mesh(lockGeometry(0.3, 0.075, -0.15, 0.7), M.hair, hairG);
      side.position.set(s * 0.25, 0.08, 0.05); side.rotation.set(Math.PI, 0, s * 0.12);
    }
  } else if (style === 'bun') {
    for (let i = 0; i < 4; i++) lock(0.55, -0.6 + i * 0.4, 0.17, 0.08, 0.7, 0.9, 0, 0.55);
    mesh(sphere(0.12, 40, 28), M.hair, hairG).position.set(0, 0.28, -0.1);
    const band = mesh(new THREE.TorusGeometry(0.075, 0.018, 12, 32), M.accent, hairG);
    band.position.set(0, 0.21, -0.075); band.rotation.x = Math.PI / 2 - 0.45;
  } else if (style === 'curly') {
    for (let i = 0; i < 26; i++) {
      const a = i * 2.39996;               // golden-angle spread over the scalp
      const th = 0.15 + (i / 26) * 1.15;
      const c = mesh(sphere(0.075 + (i % 3) * 0.008, 28, 20), M.hair, hairG);
      c.position.set(Math.sin(th) * Math.sin(a) * 0.29, Math.cos(th) * 0.3 + 0.02, Math.sin(th) * Math.cos(a) * 0.27 - 0.02);
      if (c.position.z > 0.18 && c.position.y < 0.12) c.visible = false; // keep the face clear
    }
  }

  // ================= glasses
  if (glasses === 'sunglasses' || glasses === 'round') {
    const shades = glasses === 'sunglasses';
    const frameM = shades ? gloss('#15171d') : soft('#2a2e38', { roughness: 0.35 });
    const lensM = shades
      ? new THREE.MeshStandardMaterial({ color: '#1a1d24', roughness: 0.06, metalness: 0.4 })
      : new THREE.MeshStandardMaterial({ color: '#dfe9ff', roughness: 0.05, transparent: true, opacity: 0.25 });
    const gl = new THREE.Group();
    const z0 = surf(0, 0.0) + 0.02;
    gl.position.set(0, 0.0, 0);
    for (const s of [-1, 1]) {
      const lensG = new THREE.Group();
      lensG.position.set(s * 0.105, 0.005, surf(0.105, 0.005) + 0.016);
      lensG.rotation.y = s * 0.28;
      const lr = shades ? 0.082 : 0.075;
      const lens = mesh(new THREE.CylinderGeometry(lr, lr, 0.012, 48), lensM, lensG, { shadow: false });
      lens.rotation.x = Math.PI / 2; lens.scale.set(shades ? 1.22 : 1, 1, shades ? 0.88 : 1);
      const rimG = mesh(new THREE.TorusGeometry(lr, shades ? 0.014 : 0.008, 12, 48), frameM, lensG, { shadow: false });
      rimG.scale.set(shades ? 1.22 : 1, shades ? 0.88 : 1, 1);
      // temple arm back to the ear
      const arm = mesh(capsule(0.008, 0.2), frameM, gl, { shadow: false });
      arm.rotation.x = Math.PI / 2; arm.rotation.y = s * -0.12;
      arm.position.set(s * 0.25, 0.01, 0.08);
      gl.add(lensG);
    }
    const bridge = mesh(new THREE.TorusGeometry(0.026, 0.008, 8, 20, Math.PI), frameM, gl, { shadow: false });
    bridge.position.set(0, 0.012, z0);
    face.add(gl);
  }

  // ================= headset (focus / calls)
  const phones = new THREE.Group();
  mesh(new THREE.TorusGeometry(HEAD_R + 0.05, 0.022, 14, 56, Math.PI), M.gear, phones).position.y = 0.03;
  for (const s of [-1, 1]) {
    const cup = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.065, 40), M.gear, phones);
    cup.rotation.z = Math.PI / 2; cup.position.set(s * (HEAD_R + 0.03), 0, 0);
    const pad = mesh(new THREE.TorusGeometry(0.06, 0.02, 12, 32), M.gearPad, phones);
    pad.rotation.y = Math.PI / 2; pad.position.set(s * HEAD_R, 0, 0);
  }
  const mic = new THREE.Group();
  const boom = mesh(capsule(0.01, 0.2), M.gear, mic);
  boom.rotation.x = Math.PI / 2.2; boom.position.set(0, -0.06, 0.1);
  mesh(sphere(0.024, 16, 12), M.accent, mic).position.set(0, -0.1, 0.2);
  mic.position.set(0.3, -0.04, 0); mic.rotation.y = -0.5;
  phones.add(mic);
  phones.visible = false;
  head.add(phones);

  // ================= arms: shoulder → elbow → mitten hand with thumb
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.205 * side, 0.43, 0);
    const upper = mesh(capsule(0.066, 0.12), M.hoodie, shoulder);
    upper.position.y = -0.1;
    const elbow = new THREE.Group();
    elbow.position.y = -0.2;
    shoulder.add(elbow);
    mesh(capsule(0.06, 0.1), M.hoodie, elbow).position.y = -0.085;
    const cuff = mesh(new THREE.TorusGeometry(0.05, 0.022, 12, 32), M.rib, elbow);
    cuff.rotation.x = Math.PI / 2; cuff.position.y = -0.165;
    const hand = new THREE.Group();
    hand.position.y = -0.215;
    elbow.add(hand);
    mesh(sphere(0.058, 32, 24), M.skin, hand).scale.set(0.95, 1.12, 0.72);
    const thumb = mesh(capsule(0.021, 0.03), M.skin, hand);
    thumb.position.set(-side * 0.045, 0.012, 0.025); thumb.rotation.set(0.4, 0, -side * 0.6);
    hips.add(shoulder);
    const setReach = (k) => { upper.scale.y = k; upper.position.y = -0.1 * k; elbow.position.y = -0.2 * k; };
    return { shoulder, elbow, hand, upper, setReach };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  // ================= joggers + sneakers
  const makeLeg = (side) => {
    const thigh = new THREE.Group();
    thigh.position.set(0.1 * side, 0.03, 0);
    mesh(capsule(0.088, 0.13), M.pants, thigh).position.y = -0.12;
    mesh(capsule(0.009, 0.2), M.stripe, thigh, { shadow: false }).position.set(side * 0.086, -0.12, 0);
    const knee = new THREE.Group();
    knee.position.y = -0.25;
    thigh.add(knee);
    mesh(capsule(0.078, 0.12), M.pants, knee).position.y = -0.1;
    mesh(capsule(0.009, 0.17), M.stripe, knee, { shadow: false }).position.set(side * 0.077, -0.1, 0);
    const cuff = mesh(new THREE.TorusGeometry(0.06, 0.025, 12, 32), M.pants, knee);
    cuff.rotation.x = Math.PI / 2; cuff.position.y = -0.2;
    const shoe = new THREE.Group();
    shoe.position.set(0, -0.275, 0.035);
    knee.add(shoe);
    mesh(sphere(0.085, 40, 28), M.shoe, shoe).scale.set(0.9, 0.62, 1.45);
    const toe = mesh(sphere(0.08, 32, 20, 0, TAU, 0, Math.PI * 0.5), M.accent, shoe);
    toe.scale.set(0.92, 0.5, 0.6); toe.position.set(0, 0.0, 0.07);
    const heel = mesh(sphere(0.07, 32, 20), M.accent, shoe);
    heel.scale.set(1.05, 0.62, 0.55); heel.position.set(0, 0.005, -0.075);
    const sole = mesh(new THREE.CylinderGeometry(1, 1, 1, 40), M.sole, shoe);
    sole.scale.set(0.08, 0.025, 0.125); sole.position.y = -0.045;
    for (let i = 0; i < 3; i++) {
      const l = mesh(capsule(0.006, 0.05), M.lace, shoe, { shadow: false });
      l.rotation.z = Math.PI / 2; l.position.set(0, 0.05 - i * 0.004, i * 0.03);
    }
    hips.add(thigh);
    return { thigh, knee };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // ================= noodle bowl (eating) in the right hand
  const bowl = new THREE.Group();
  mesh(sphere(0.085, 36, 18, 0, TAU, Math.PI / 2, Math.PI / 2), M.bowl, bowl);
  const rim = mesh(new THREE.TorusGeometry(0.084, 0.01, 10, 40), M.bowlIn, bowl);
  rim.rotation.x = Math.PI / 2;
  const noodles = mesh(new THREE.CircleGeometry(0.078, 32), M.noodle, bowl, { shadow: false });
  noodles.rotation.x = -Math.PI / 2; noodles.position.y = -0.012;
  for (const s of [-1, 1]) {
    const stick = mesh(capsule(0.006, 0.22), M.wood, bowl);
    stick.position.set(0.02 * s, 0.08, -0.01); stick.rotation.set(-0.3, 0, -0.3 + s * 0.06);
  }
  bowl.position.set(0, -0.03, 0.07);
  bowl.rotation.x = 0.8; // tip it so the noodles show
  bowl.visible = false;
  armR.hand.add(bowl);

  // ================= bake: merge static parts into a few meshes (far fewer draw calls)
  const animated = new Set([torso, mic, bowl, phones, ...eyes.map(e => e.lid.parent), ...brows, mouthG,
    armL.upper, armR.upper, armL.shoulder, armR.shoulder, armL.elbow, armR.elbow, armL.hand, armR.hand,
    legL.thigh, legR.thigh, legL.knee, legR.knee, headG, hairG, face]);
  const bakeGroup = (G) => {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(G.matrixWorld).invert();
    const byMat = new Map();
    const victims = [];
    const visit = (o) => {
      for (const c of [...o.children]) {
        if (animated.has(c)) continue;
        if (c.isMesh) {
          const g = c.geometry.index ? c.geometry.clone() : null;
          if (!g) continue;
          g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld));
          for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
          if (!g.attributes.uv) continue;
          if (!byMat.has(c.material)) byMat.set(c.material, []);
          byMat.get(c.material).push(g);
          victims.push(c);
        }
        if (!c.isMesh || c.children.length) visit(c);
      }
    };
    visit(G);
    for (const v of victims) { v.parent.remove(v); v.geometry.dispose(); }
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos, false);
      geos.forEach(g => g.dispose());
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      G.add(m);
    }
  };
  bakeGroup(hips);
  bakeGroup(head);
  bakeGroup(face);
  bakeGroup(hairG);
  bakeGroup(phones);
  bakeGroup(bowl);
  for (const a of [armL, armR]) { bakeGroup(a.elbow); bakeGroup(a.hand); }
  for (const l of [legL, legR]) { bakeGroup(l.thigh); bakeGroup(l.knee); }

  // ================= motion
  const S = {
    hipsY: new Spring(SIT_HIPS, 220, 22),
    squash: new Spring(0, 320, 9),
    lean: new Spring(0, 120, 14),
    aLx: new Spring(-0.5, 240, 20), aLz: new Spring(0, 240, 20), eL: new Spring(-1, 260, 22), eLz: new Spring(0, 260, 22),
    aRx: new Spring(-0.5, 240, 20), aRz: new Spring(0, 240, 20), eR: new Spring(-1, 260, 22), eRz: new Spring(0, 260, 22),
    lift: new Spring(0, 200, 18), reach: new Spring(1, 220, 16),
    hX: new Spring(0, 90, 11), hY: new Spring(0, 70, 10), hZ: new Spring(0, 90, 11),
    thigh: new Spring(-Math.PI / 2, 300, 28), knee: new Spring(Math.PI / 2, 300, 28),
    mouth: new Spring(0, 260, 18), brow: new Spring(0, 200, 16), browTilt: new Spring(0, 200, 16),
    eye: new Spring(1, 400, 30), gazeX: new Spring(0, 160, 18), gazeY: new Spring(0, 160, 18),
  };
  const timers = { nextBlink: 1 + Math.random() * 3, blinkAt: -1, double: false, nextLook: Math.random() * 2, lookY: 0, lookX: 0, nextHop: 0 };
  let lastActivity = null, lastPose = null;

  const api = {
    root, hips, headG, armL, armR, legL, legR, phones, mic, bowl,
    pose: 'sit',        // sit | stand | walk
    activity: 'type',   // type | idle | eat | raise | wave | talk | listen
    phase: Math.random() * 10,
    walkPhase: 0,
    opacity: 1,
    setHeadphones(on, withMic = false) { phones.visible = on; mic.visible = on && withMic; },
    hop(strength = 1) { S.squash.kick(-2.2 * strength); },
    setOpacity(o) {
      if (Math.abs(o - api.opacity) < 0.001) return;
      api.opacity = o;
      root.traverse(obj => {
        for (const m of obj.material ? [].concat(obj.material) : []) {
          m.userData.baseOpacity ??= m.opacity;
          m.transparent = o < 0.999 || m.userData.baseOpacity < 1;
          m.opacity = m.userData.baseOpacity * o;
          m.depthWrite = o > 0.6 && m !== M.blush;
        }
      });
      root.visible = o > 0.02;
    },
    update(t, dt) { step(t, Math.min(dt, 0.1)); },
    dispose() {
      const seen = new Set();
      root.traverse(o => {
        if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
        for (const m of o.material ? [].concat(o.material) : []) if (!seen.has(m)) { seen.add(m); m.dispose(); }
      });
    },
  };

  function step(t, dt) {
    const p = t + api.phase;
    const pose = api.pose, act = api.activity;

    // anticipation / landing impulses
    if (act !== lastActivity) {
      if (lastActivity !== null && (act === 'raise' || act === 'wave')) S.squash.kick(2.6);
      if (act === 'raise') timers.nextHop = t + 0.18;
      lastActivity = act;
    }
    if (pose !== lastPose) {
      if (lastPose === 'walk' && pose === 'sit') S.squash.kick(3.2);
      if (lastPose === 'sit' && pose !== 'sit') S.squash.kick(-2);
      lastPose = pose;
    }

    // blinking (sometimes a double blink)
    if (t >= timers.nextBlink) {
      timers.blinkAt = t;
      timers.double = Math.random() < 0.2;
      timers.nextBlink = t + 2.2 + Math.random() * 3.5;
    }
    let blink = ease.bump((t - timers.blinkAt) / 0.13);
    if (timers.double) blink = Math.max(blink, ease.bump((t - timers.blinkAt - 0.2) / 0.13));

    // glance around now and then
    if (t >= timers.nextLook) {
      const wide = act === 'idle' || act === 'listen' || pose !== 'sit';
      timers.lookY = (Math.random() - 0.5) * (wide ? 0.9 : 0.35);
      timers.lookX = (Math.random() - 0.5) * 0.15;
      timers.nextLook = t + 1.2 + Math.random() * (act === 'type' ? 4 : 2.5);
    }

    let hipsY, thigh, knee, lean = 0;
    let aLx, aLz, aRx, aRz, eL, eR, eLz = 0, eRz = 0, lift = 0, reach = 1;
    let hX = timers.lookX, hY = timers.lookY, hZ = 0;
    let mouth = 0, brow = 0, browTilt = 0, eye = 1;
    let gazeX = timers.lookY * 0.6, gazeY = 0;
    const breath = Math.sin(p * 1.6);

    if (pose === 'sit') { hipsY = SIT_HIPS; thigh = -Math.PI / 2; knee = Math.PI / 2; }
    else if (pose === 'walk') { hipsY = STAND_HIPS + 0.01; thigh = 0; knee = 0.1; lean = 0.12; }
    else { hipsY = STAND_HIPS; thigh = 0; knee = 0; }

    const rest = () => {
      if (pose === 'sit') { aLx = -0.45; aRx = -0.45; aLz = 0.12; aRz = -0.12; eL = eR = -1.05; }
      else { aLx = 0.05 + breath * 0.03; aRx = 0.05 - breath * 0.03; aLz = -0.12; aRz = 0.12; eL = eR = -0.25; }
    };

    switch (act) {
      case 'type': {
        // bursts of typing on the laptop, then a short pause to read the screen
        const burst = Math.sin(p * 0.55) + Math.sin(p * 1.3) * 0.5 > -0.6 ? 1 : 0;
        const tap = (o) => burst * Math.max(0, Math.sin(p * 17 + o)) ** 3;
        aLx = -0.62; aRx = -0.62;
        aLz = 0.2; aRz = -0.2;
        eL = -1.36 + tap(0) * 0.14; eR = -1.36 + tap(2.1) * 0.14;
        lean = pose === 'sit' ? 0.1 : 0;
        hX = 0.12 + burst * Math.sin(p * 17) * 0.008 + (1 - burst) * 0.04;
        hY = timers.lookY * (burst ? 0.12 : 0.45);
        gazeY = -0.6; gazeX = Math.sin(p * 0.9) * 0.4 * burst;   // eyes track the text
        brow = burst ? -0.12 : 0; browTilt = 0;
        break;
      }
      case 'eat': {
        const cyc = (p * 0.45) % 1;
        const up = ease.inOut(cyc < 0.5 ? cyc * 2 : 2 - cyc * 2);
        aRx = -0.35 - up * 0.25; aRz = -0.15 - up * 0.15; eR = -1.35 - up * 0.85;
        aLx = -0.45; aLz = 0.12; eL = -1.05;
        hX = 0.12 - up * 0.08; hY = -up * 0.1;
        mouth = up > 0.7 ? 0.45 + Math.sin(p * 18) * 0.25 : 0.05;
        eye = up > 0.8 ? 0.35 : 1;     // happy squint
        brow = 0.2; gazeY = -0.4;
        break;
      }
      case 'raise': {
        aRx = -Math.PI + 0.12; aRz = 0.28 + Math.sin(p * 7) * 0.12; eR = -0.1 + Math.sin(p * 7) * 0.1;
        lift = 0.06; reach = 1.25;
        aLx = pose === 'sit' ? -0.45 : 0.1; aLz = pose === 'sit' ? 0.12 : -0.25; eL = pose === 'sit' ? -1.05 : -0.3;
        hX = -0.12; hY = Math.sin(p * 2.2) * 0.25; hZ = Math.sin(p * 3.1) * 0.08;
        brow = 0.4; browTilt = 0.4; mouth = 0.3 + Math.sin(p * 4) * 0.05; gazeY = 0.3;
        if (t >= timers.nextHop) { S.squash.kick(-2.4); timers.nextHop = t + 2.4; }
        break;
      }
      case 'wave': {
        aRx = -Math.PI + 0.45; aRz = 0.45 + Math.sin(p * 9) * 0.45; eR = -0.35;
        lift = 0.05; reach = 1.1;
        aLx = pose === 'sit' ? -0.45 : 0.05; aLz = pose === 'sit' ? 0.12 : -0.15; eL = pose === 'sit' ? -1.05 : -0.25;
        hZ = Math.sin(p * 9) * 0.06; hX = -0.08; hY *= 0.3;
        brow = 0.3; mouth = 0.4; eye = 0.9; gazeX = 0; gazeY = 0;
        break;
      }
      case 'talk': {
        aLx = -0.35 + Math.sin(p * 2.3) * 0.15; aRx = -0.4 + Math.sin(p * 2.9 + 1) * 0.2;
        aLz = 0.05 - Math.max(0, Math.sin(p * 1.7)) * 0.3; aRz = -0.05 + Math.max(0, Math.sin(p * 2.1)) * 0.3;
        eL = -1.3 + Math.sin(p * 2.3) * 0.35; eR = -1.4 + Math.sin(p * 2.9) * 0.4;
        mouth = 0.08 + Math.abs(Math.sin(p * 11) * Math.sin(p * 3.7)) * 0.5;
        hX = Math.sin(p * 2.6) * 0.06; brow = Math.sin(p * 1.9) * 0.25;
        break;
      }
      case 'cross': {    // arms folded, cool and relaxed
        aLx = -1.25; aRx = -1.1; aLz = -0.12; aRz = 0.12; eL = -0.15; eR = -0.05; eLz = 1.5; eRz = -1.5;
        hZ = Math.sin(p * 0.8) * 0.05; hY = timers.lookY * 0.5; mouth = 0; brow = 0.05;
        hX = -0.04;
        break;
      }
      case 'listen':
        rest();
        hX = 0.05 + Math.max(0, Math.sin(p * 2.2)) * 0.12;   // nodding along
        brow = 0.1;
        break;
      default:
        rest();
    }

    if (pose === 'walk') {
      api.walkPhase += dt * 10;
      const s = Math.sin(api.walkPhase);
      aLx = -s * 0.55; aRx = s * 0.55; aLz = -0.1; aRz = 0.1; eL = eR = -0.35;
      hY = 0; hX = 0.02; mouth = 0.05; gazeX = 0; gazeY = 0;
    }

    S.hipsY.target = hipsY; S.lean.target = lean; S.thigh.target = thigh; S.knee.target = knee;
    S.aLx.target = aLx; S.aLz.target = aLz; S.eL.target = eL; S.eLz.target = eLz;
    S.aRx.target = aRx; S.aRz.target = aRz; S.eR.target = eR; S.eRz.target = eRz;
    S.lift.target = lift; S.reach.target = reach;
    S.hX.target = hX; S.hY.target = hY; S.hZ.target = hZ;
    S.mouth.target = mouth; S.brow.target = brow; S.browTilt.target = browTilt; S.eye.target = eye;
    S.gazeX.target = gazeX; S.gazeY.target = gazeY;
    S.squash.target = 0;
    for (const k in S) S[k].step(dt);

    let bounce = 0;
    if (pose === 'walk') {
      const s = Math.sin(api.walkPhase);
      bounce = Math.abs(Math.cos(api.walkPhase)) * 0.04;
      legL.thigh.rotation.x = s * 0.55; legR.thigh.rotation.x = -s * 0.55;
      legL.knee.rotation.x = Math.max(0, -s) * 0.7 + 0.05; legR.knee.rotation.x = Math.max(0, s) * 0.7 + 0.05;
    } else {
      legL.thigh.rotation.x = legR.thigh.rotation.x = S.thigh.x;
      legL.knee.rotation.x = legR.knee.rotation.x = S.knee.x;
    }
    const sq = THREE.MathUtils.clamp(S.squash.x, -0.22, 0.22);
    const air = Math.max(0, -S.squash.x) * 0.5;
    hips.position.y = S.hipsY.x + bounce + air * (pose === 'sit' ? 0.3 : 1);
    rig.scale.set(1 + sq * 0.4, 1 - sq, 1 + sq * 0.4);
    hips.rotation.x = S.lean.x;
    torso.scale.set(1 + breath * 0.01, 1, 1 + breath * 0.01);

    armL.shoulder.rotation.set(S.aLx.x, 0, S.aLz.x);
    armR.shoulder.rotation.set(S.aRx.x, 0, S.aRz.x);
    armL.elbow.rotation.set(S.eL.x, 0, S.eLz.x);
    armR.elbow.rotation.set(S.eR.x, 0, S.eRz.x);
    armR.shoulder.position.y = 0.43 + S.lift.x;
    armR.setReach(Math.max(0.9, S.reach.x));

    headG.rotation.set(S.hX.x, S.hY.x, S.hZ.x);
    hairG.rotation.x = -S.hX.v * 0.01;          // hair lags the head a touch
    hairG.rotation.z = -S.hZ.v * 0.012;

    const eyeOpen = Math.max(0.06, S.eye.x * (1 - blink * 0.94));
    for (const e of eyes) {
      e.lid.scale.y = eyeOpen;
      e.iris.position.x = S.gazeX.x * 0.012; e.iris.position.y = -0.004 + S.gazeY.x * 0.012;
      e.pupil.position.x = S.gazeX.x * 0.013; e.pupil.position.y = -0.004 + S.gazeY.x * 0.013;
    }
    brows[0].position.y = brows[1].position.y = 0.098 + S.brow.x * 0.022;
    brows[0].rotation.z = -S.browTilt.x * 0.35; brows[1].rotation.z = S.browTilt.x * 0.35;
    const mo = Math.max(0, S.mouth.x);
    smile.visible = mo < 0.12;
    open.visible = mo >= 0.12;
    open.scale.set(0.75 + mo * 0.45, Math.min(1.25, mo * 1.6), 1);
    bowl.visible = act === 'eat' && pose !== 'walk';
  }

  step(0, 0.016);
  for (const k in S) S[k].snap(S[k].target);
  step(0, 0.016);
  return api;
}

/** Emoji sprite (canvas texture). */
export function emojiSprite(text, size = 0.4) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = '96px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 72);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size, size, size);
  s.userData.text = text;
  s.userData.size = size;
  return s;
}

export { THREE };
