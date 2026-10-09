// Deskmate character v3 — "friendly" redesign (prototype).
// Soft, rounded, very high-poly shapes; gentle dark eyes with big highlights;
// a warm smile; sculpted hair that blends into the head (no helmet edge);
// cosy sweater, soft trousers and chunky sneakers. Same API as createAvatar().
import { THREE, Spring, ease } from './toon.js';

const TAU = Math.PI * 2;
const R = 0.3;              // head radius
const NECK_Y = 0.4;         // hips → neck
const SHOULDER_Y = 0.32;
const STAND_HIPS = 0.46;
const SIT_HIPS = 0.47;
const EYE_Y = -0.02;
const BROW_Y = 0.072;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)));
  return c;
}

// ---------------------------------------------------------------- materials
const fabric = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, roughness: 0.9, metalness: 0, sheen: 1, sheenRoughness: 0.75, sheenColor: shade(color, 0.22), ...o,
});
const skinMat = (color) => new THREE.MeshPhysicalMaterial({
  color, roughness: 0.52, metalness: 0, sheen: 0.6, sheenRoughness: 0.45, sheenColor: new THREE.Color('#ffd8c8'),
  clearcoat: 0.08, clearcoatRoughness: 0.6,
});
const glossy = (color) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
const plain = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const unlit = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });

// ---------------------------------------------------------------- shapes
// Head: chubby cheeks, soft short chin, slightly flat back.
function headPoint(d) {
  const v = d.clone().multiplyScalar(R);
  const ny = d.y;
  const cheek = Math.exp(-((ny + 0.36) ** 2) / 0.08) * 0.075;
  v.x *= 1.03 * (1 + cheek);
  if (v.z > 0) v.z *= 1 + cheek * 0.45; else v.z *= 0.93;
  if (ny < -0.6) v.y = -R * (0.6 + (-ny - 0.6) * 0.78);
  v.z *= 0.97;
  v.y *= 1.04;
  return v;
}

function sphereMap(segW, segH, fn) {
  const g = new THREE.SphereGeometry(1, segW, segH);
  const pos = g.attributes.position;
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    const p = fn(d);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

// Hair as a shell over the scalp whose thickness fades to zero at the hairline,
// so it melts into the skin. Styles change the hairline, volume and sculpted locks.
const dirFrom = (a, elev) => new THREE.Vector3(Math.sin(a) * Math.cos(elev), Math.sin(elev), Math.cos(a) * Math.cos(elev));
const bump = (d, a, elev, width) => Math.exp(-d.distanceToSquared(dirFrom(a, elev)) / width);

// Distance of the hair surface from the head centre along direction d.
function hairPoint(d, style) {
  const base = headPoint(d);
  const elev = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  const a = Math.atan2(d.x, d.z);                     // 0 = front
  const front = (1 + Math.cos(a)) / 2;                // 1 front … 0 back
  const pole = Math.cos(elev);                        // fades angular patterns out at the crown
  let line = -0.55 + 0.93 * front ** 0.9;
  line += 0.035 * Math.sin(7 * a + 0.5) * pole * (1 - front * 0.6);   // scalloped tips
  const fringe = style === 'bun' ? 0 : bump(d, 0.42, 0.3, 0.06);
  line -= 0.11 * fringe;
  let top = 0.03, lift = 0, groove = 0.005;
  const edge = 0.012 * fringe;
  if (style === 'long') { line = Math.min(line, -1.05 + 1.3 * front ** 2.4 - 0.11 * fringe); groove = 0.006; }
  if (style === 'bun') { top = 0.012; groove = 0.002; }
  if (style === 'curly') { top = 0.05; groove = 0; }
  if (style === 'messy') { top = 0.08; groove = 0.004; line -= 0.02; }
  if (style === 'short' || style === 'spiky') lift = (style === 'spiky' ? 0.07 : 0.035) * bump(d, -0.15, 0.78, 0.12);
  const h = elev - line;
  const m = smooth(-0.025, 0.025, h);
  const e = smooth(0.0, 0.4, h);
  let t = 0.003 + edge + e * (0.012 + top * smooth(-0.2, 1.2, elev)) + lift;
  t += (groove + 0.005) * e * pole * Math.sin(7 * (a - 0.7 * elev) + 1.3);
  if (style === 'curly') t += 0.02 * e * (0.5 + 0.5 * pole * Math.sin(12 * a) * Math.sin(10 * elev + 1));
  if (style === 'spiky') t += 0.035 * e * pole * Math.max(0, Math.sin(8 * a + elev * 3)) ** 2 * smooth(0.4, 1.0, elev);
  const off = m * t - (1 - m) * 0.014;
  return base.add(d.clone().multiplyScalar(off));
}

function hairGeometry(style) {
  return sphereMap(240, 180, (d) => hairPoint(d, style));
}

// A sculpted clump of hair: a tapered, flattened tube laid along the hair surface.
// path: [[a, elev], ...] in head angles; r0: root radius; lift: height above the shell.
function lockGeometry(path, style, r0 = 0.04, lift = -0.004, flat = 0.42) {
  const pts = path.map(([a, el]) => {
    const d = dirFrom(a, el);
    return hairPoint(d, style).add(d.multiplyScalar(lift));
  });
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const TS = 72, RS = 28;
  const pos = [], idx = [];
  const frames = curve.computeFrenetFrames(TS, false);
  for (let i = 0; i <= TS; i++) {
    const u = i / TS;
    const c = curve.getPointAt(u);
    const out = c.clone().normalize();                       // away from the head
    const tan = frames.tangents[i];
    const side = new THREE.Vector3().crossVectors(tan, out).normalize();
    const up = new THREE.Vector3().crossVectors(side, tan).normalize();
    const r = r0 * Math.pow(1 - u, 0.85) * Math.min(1, 0.35 + u * 6) + 0.0015;
    for (let j = 0; j <= RS; j++) {
      const th = (j / RS) * TAU;
      const p = c.clone()
        .addScaledVector(side, Math.cos(th) * r)
        .addScaledVector(up, Math.sin(th) * r * flat);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < TS; i++) for (let j = 0; j < RS; j++) {
    const a = i * (RS + 1) + j, b = a + RS + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Hand-placed clumps per style (angles: a = around the head from the front, elev = up).
function lockPaths(style) {
  if (style === 'messy') {
    const L = [];
    // big swoopy fringe clumps sweeping across the forehead
    const fr = [[-0.75, 1.05, 0.09], [-0.45, 1.1, 0.1], [-0.15, 1.12, 0.1], [0.15, 1.1, 0.095], [0.45, 1.02, 0.085]];
    fr.forEach(([a0, e0, r], i) => L.push({ r: r * 1.15, path: [[a0 - 0.25, e0 + 0.2], [a0 + 0.05, e0 - 0.08], [a0 + 0.32, e0 - 0.4], [a0 + 0.52, e0 - 0.66], [a0 + 0.6, e0 - 0.72], [a0 + 0.66, e0 - 0.62]], lift: 0.03 }));
    // crown tufts flicking up and back
    for (let i = 0; i < 6; i++) {
      const a0 = -1.4 + i * 0.56;
      L.push({ r: 0.1, path: [[a0 * 0.3, 1.25], [a0 * 0.75, 0.98], [a0 * 1.05, 0.66], [a0 * 1.2 + 0.2, 0.38], [a0 * 1.25 + 0.32, 0.44]], lift: 0.03 });
    }
    // side clumps over the ears, flicking out
    for (const sd of [-1, 1]) for (let i = 0; i < 3; i++) {
      const a0 = sd * (1.05 + i * 0.4);
      L.push({ r: 0.085, path: [[a0, 0.8], [a0 + sd * 0.15, 0.45], [a0 + sd * 0.25, 0.12], [a0 + sd * 0.42, 0.02], [a0 + sd * 0.5, 0.08]], lift: 0.025 });
    }
    // back
    for (let i = 0; i < 5; i++) {
      const a0 = Math.PI - 0.9 + i * 0.45;
      L.push({ r: 0.08, path: [[a0, 0.95], [a0, 0.6], [a0 + 0.1, 0.25], [a0 + 0.15, 0.05]], lift: 0.006 });
    }
    return L;
  }
  if (style === 'short' || style === 'spiky') {
    const L = [];
    // side-swept fringe: from the parting across the forehead, curling at the temple
    for (let i = 0; i < 4; i++) {
      const a0 = -0.6 + i * 0.2, e0 = 1.02 - i * 0.05;
      L.push({ r: 0.075 - i * 0.006, path: [[a0, e0], [a0 + 0.25, e0 - 0.25], [a0 + 0.55, e0 - 0.5], [a0 + 0.85, e0 - 0.64], [a0 + 1.02, e0 - 0.6]] });
    }
    // crown, swept back
    for (let i = 0; i < 4; i++) {
      const a0 = -0.9 + i * 0.6;
      L.push({ r: 0.065, path: [[a0 * 0.4, 1.05], [a0 * 0.8, 0.8], [a0 + Math.sign(a0 || 1) * 0.3, 0.45], [a0 * 1.2 + Math.sign(a0 || 1) * 0.6, 0.2]] });
    }
    // above the ears, swept back
    for (const s of [-1, 1]) for (let i = 0; i < 2; i++) {
      L.push({ r: 0.05, path: [[s * (1.0 + i * 0.25), 0.45 - i * 0.05], [s * (1.4 + i * 0.25), 0.25], [s * (1.8 + i * 0.25), 0.1], [s * (2.1 + i * 0.25), 0.02]] });
    }
    return L;
  }
  if (style === 'long') {
    const L = [];
    for (let i = 0; i < 6; i++) {
      const a0 = -0.5 + i * 0.13, e0 = 1.0 - i * 0.03;
      L.push({ r: 0.045, path: [[a0, e0], [a0 + 0.3, e0 - 0.3], [a0 + 0.62, e0 - 0.58], [a0 + 0.95, e0 - 0.8]] });
    }
    return L;
  }
  return [];
}

// keep only the part of a geometry above y = cut (non-indexed result)
function clipBelow(geo, cut) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position, nor = g.attributes.normal;
  const P = [], N = [];
  for (let i = 0; i < pos.count; i += 3) {
    if (pos.getY(i) < cut && pos.getY(i + 1) < cut && pos.getY(i + 2) < cut) continue;
    for (let k = 0; k < 3; k++) { P.push(pos.getX(i + k), Math.max(cut, pos.getY(i + k)), pos.getZ(i + k)); N.push(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k)); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return out;
}

// knitted rib on a torus: modulate the tube radius around the ring
function ribbedTorus(geo, ribs, amt) {
  const p = geo.attributes.position;
  const params = geo.parameters;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const ang = Math.atan2(v.y, v.x);
    c.set(Math.cos(ang) * params.radius, Math.sin(ang) * params.radius, 0);
    const off = v.clone().sub(c);
    off.multiplyScalar(1 + (amt / params.tube) * Math.sin(ribs * ang));
    p.setXYZ(i, c.x + off.x, c.y + off.y, c.z + off.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function lathe(points, segs = 96, samples = 80) {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r, y)));
  const g = new THREE.LatheGeometry(curve.getPoints(samples), segs);
  g.computeVertexNormals();
  return g;
}

function radialTexture(inner = 'rgba(255,120,130,0.9)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, inner);
  g.addColorStop(1, 'rgba(255,120,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// D-shaped open smile, bent to follow the face.
function smileGeometry(w, h, depth = 0.006) {
  const s = new THREE.Shape();
  s.moveTo(-w, 0);
  s.bezierCurveTo(-w * 0.95, -h * 1.25, w * 0.95, -h * 1.25, w, 0);
  s.quadraticCurveTo(0, h * 0.18, -w, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 8, curveSegments: 64 });
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) - (pos.getX(i) ** 2) * 1.8 - (pos.getY(i) ** 2) * 0.8);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the character
export function createCharacter({
  color = '#8EB8FF', skin = '#F2C7A5', hair = '#5B3A29', style = 'beanie', glasses = 'none',
  pants = '#8E97A8', shoes, hat, eyes: eyeCol = '#22160f', stripe: sideStripe = false, tee = false, species = 'human', glow = '#7CF5C8', suitTrim = '#F4F1FA',
} = {}) {
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  const hips = new THREE.Group();
  rig.add(hips);

  const M = {
    top: fabric(color),
    topRib: fabric(shade(color, -0.07)),
    collar: fabric(shade(color, 0.12)),
    pants: fabric(pants || shade(color, -0.3)),
    skin: skinMat(skin),
    nose: skinMat(shade(skin, -0.025)),
    hair: new THREE.MeshPhysicalMaterial({ color: hair, roughness: 0.42, sheen: 0.8, sheenRoughness: 0.3, sheenColor: shade(hair, 0.35), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    brow: plain(species === 'alien' ? shade(skin, -0.32) : shade(hair, -0.02), { roughness: 0.8 }),
    eye: glossy(eyeCol),
    eyeGlow: glossy(shade(eyeCol, 0.16)),
    tee: fabric('#eef0f4'),
    trim: plain(suitTrim, { roughness: 0.4 }),
    glow: new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 0.9, roughness: 0.3 }),
    spot: skinMat(shade(skin, -0.1)),
    stripe: fabric('#f4f4f6'),
    shine: unlit('#ffffff'),
    lash: plain('#2a1c15'),
    mouth: plain('#7a2e3a', { roughness: 0.5 }),
    tongue: plain('#f08595', { roughness: 0.5 }),
    teeth: plain('#ffffff', { roughness: 0.3 }),
    lip: plain('#a3505a', { roughness: 0.55 }),
    blush: new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,110,120,0.55)'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    shoe: plain('#fbfaf8', { roughness: 0.45 }),
    sole: plain('#ece7e0', { roughness: 0.8 }),
    accent: plain(shoes || shade(color, -0.05), { roughness: 0.45 }),
    lace: plain('#ffffff'),
    knit: fabric(hat || shade(color, -0.1)),
    knitRib: fabric(shade(hat || shade(color, -0.1), -0.06)),
    hoodIn: fabric(shade(color, -0.22)),
    aglet: plain('#d7dbe2', { roughness: 0.35, metalness: 0.2 }),
    earIn: skinMat(shade(skin, -0.05)),
    gear: plain('#2b2f3a', { roughness: 0.35 }),
    gearPad: fabric(shade(color, 0.1)),
    bowl: plain('#ef7d6d', { roughness: 0.3 }),
    bowlIn: plain('#ffffff', { roughness: 0.3 }),
    noodle: plain('#F4C152'),
    wood: plain('#c9965f'),
  };

  const mesh = (geo, mat, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    parent?.add(m);
    return m;
  };
  const sphere = (r, w = 96, h = 64, ...rest) => new THREE.SphereGeometry(r, w, h, ...rest);
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 24, 64);
  const torus = (r, t, rs = 32, ts = 128, arc = TAU) => new THREE.TorusGeometry(r, t, rs, ts, arc);

  // ================= hoodie + joggers
  const torso = mesh(lathe([
    [0.0, -0.02], [0.17, -0.012], [0.205, 0.04], [0.213, 0.12], [0.206, 0.21],
    [0.186, 0.28], [0.152, 0.34], [0.1, 0.376], [0.0, 0.39],
  ]), M.top, hips);
  const hem = mesh(torus(0.2, 0.025), M.topRib, hips);
  hem.rotation.x = Math.PI / 2; hem.position.y = 0.022;
  const seat = mesh(sphere(0.175), M.pants, hips);       // rounded bottom of the joggers
  seat.scale.set(1.08, 0.55, 0.95); seat.position.y = 0.0;
  // hood bunched around the neck, with a V opening at the front
  const hood = mesh(torus(0.098, 0.046, 48, 160), M.top, hips);
  hood.rotation.x = Math.PI / 2 - 0.28; hood.position.set(0, 0.372, -0.018); hood.scale.set(1.16, 1.06, 1);
  const hoodBack = mesh(sphere(0.14), M.top, hips);
  hoodBack.scale.set(1.25, 0.78, 0.62); hoodBack.position.set(0, 0.35, -0.13);
const alien = species === 'alien';
  const vNeck = mesh(sphere(0.045), tee ? M.tee : M.hoodIn, hips);
  vNeck.visible = !alien;
  hood.visible = hoodBack.visible = !alien;
  vNeck.scale.set(tee ? 1.25 : 0.9, 1.3, 0.35); vNeck.position.set(0, 0.338, 0.112);
  if (tee) {
    for (const yy of [0.285, 0.245]) {
      const b = mesh(capsule(0.009, 0.014), M.topRib, hips);
      b.rotation.z = Math.PI / 2; b.position.set(0, yy, 0.188); b.scale.set(1, 1, 0.6);
    }
  }
  if (alien) {
    // space suit: rounded collar ring, glowing chest badge, utility belt
    const ring = mesh(torus(0.08, 0.03, 48, 160), M.trim, hips);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.37;
    const badge = new THREE.Group();
    badge.position.set(0.075, 0.27, 0.183); badge.rotation.set(-0.25, 0.38, 0);
    const disc = mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.012, 64), M.trim, badge); disc.rotation.x = Math.PI / 2;
    const star = new THREE.Shape();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.01 : 0.022, a = i * Math.PI / 5 + Math.PI / 2; i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    mesh(new THREE.ExtrudeGeometry(star, { depth: 0.004, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.002, bevelSegments: 3 }), M.glow, badge).position.z = 0.006;
    hips.add(badge);
    const belt = mesh(torus(0.207, 0.017, 24, 160), M.trim, hips);
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.075;
    const buckle = mesh(new THREE.BoxGeometry(0.05, 0.034, 0.016), M.glow, hips);
    buckle.position.set(0, 0.075, 0.222);
  }
  // drawstrings with aglets
  for (const sd of (alien ? [] : [-1, 1])) {
    const str = new THREE.Group();
    str.position.set(sd * 0.045, 0.345, 0.155);
    str.rotation.set(-0.3, 0, sd * 0.06);
    mesh(capsule(0.0085, 0.1), M.topRib, str).position.y = -0.06;
    mesh(capsule(0.011, 0.018), M.aglet, str).position.y = -0.125;
    hips.add(str);
  }
  // kangaroo pocket: a rounded trapezoid wrapped onto the hoodie front
  if (!alien) {
    const ps = new THREE.Shape();
    const tw = 0.085, bw = 0.12, ph = 0.1, rr = 0.018;
    ps.moveTo(-bw + rr, 0); ps.lineTo(bw - rr, 0); ps.quadraticCurveTo(bw, 0, bw - 0.004, rr);
    ps.lineTo(tw + 0.004, ph - rr); ps.quadraticCurveTo(tw, ph, tw - rr, ph);
    ps.lineTo(-tw + rr, ph); ps.quadraticCurveTo(-tw, ph, -tw - 0.004, ph - rr);
    ps.lineTo(-bw + 0.004, rr); ps.quadraticCurveTo(-bw, 0, -bw + rr, 0);
    const pg = new THREE.ExtrudeGeometry(ps, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 6, curveSegments: 24, steps: 1 });
    const pp = pg.attributes.position;
    const RAD = 0.216;
    for (let i = 0; i < pp.count; i++) {
      const x = pp.getX(i), z = pp.getZ(i), y = pp.getY(i);
      const ang = x / RAD, rad = RAD + z * 0.6;
      pp.setXYZ(i, Math.sin(ang) * rad, y, Math.cos(ang) * rad);
    }
    pg.computeVertexNormals();
    mesh(pg, M.topRib, hips).position.y = 0.05;
  }

  // ================= head
  const headG = new THREE.Group();
  headG.position.y = NECK_Y;
  hips.add(headG);
  mesh(capsule(0.062, 0.06), M.skin, headG).position.y = 0.02;
  const head = new THREE.Group();
  head.position.y = R + (species === 'alien' ? -0.03 : 0.025);
  headG.add(head);
  const skull = mesh(sphereMap(200, 150, headPoint), M.skin, head);
  const antennae = [];
  for (const s of (alien ? [] : [-1, 1])) {
    const ear = mesh(sphere(0.078), M.skin, head);
    ear.scale.set(0.42, 0.95, 0.9); ear.position.set(s * 0.3, -0.035, -0.015); ear.rotation.y = s * 0.28;
    const inner = mesh(sphere(0.05, 64, 48), M.earIn, head);
    inner.scale.set(0.25, 0.75, 0.7); inner.position.set(s * 0.322, -0.035, -0.008); inner.rotation.y = s * 0.28;
  }

  if (alien) {
    // little rounded fins instead of ears
    for (const sd of [-1, 1]) {
      const fin = mesh(sphere(0.07), M.skin, head);
      fin.scale.set(0.38, 1.0, 1.35); fin.position.set(sd * 0.3, 0.0, -0.03); fin.rotation.set(0, sd * 0.25, sd * -0.65);
    }
    // two bouncy antennae with glowing tips
    for (const sd of [-1, 1]) {
      const pts = [[0, 0], [0.01, 0.06], [0.035, 0.12], [0.07, 0.16]].map(([x, y]) => new THREE.Vector3(sd * x, y, 0));
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.011, 24);
      const g = new THREE.Group();
      g.position.set(sd * 0.11, R * 0.9, 0.02); g.rotation.z = -sd * 0.15;
      mesh(tube, M.skin, g);
      const tip = mesh(sphere(0.03), M.glow, g); tip.position.copy(pts[3]);
      head.add(g);
      antennae.push(g);
    }
  }

  const face = new THREE.Group();
  head.add(face);
  const ray = new THREE.Raycaster();
  const surf = (x, y) => {
    ray.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(skull, false)[0];
    return hit ? hit.point.z : 0.27;
  };
  const faceNormalAt = (x, y) => {
    const z = surf(x, y);
    const n = new THREE.Vector3(x * 1.0, y * 0.9, z).normalize();
    return { z, n };
  };
  const stickTo = (obj, x, y, inset = 0) => {
    const { z, n } = faceNormalAt(x, y);
    obj.position.set(x, y, z - inset);
    obj.lookAt(obj.position.clone().add(n));
  };

  // eyes: friendly dark glossy ovals with a warm glow and big highlights
  const eyes = [];
  for (const s of [-1, 1]) {
    const eg = new THREE.Group();
    stickTo(eg, s * 0.108, EYE_Y, 0.012);
    face.add(eg);
    const lid = new THREE.Group();
    eg.add(lid);
    const ball = mesh(sphere(alien ? 0.066 : 0.056), M.eye, lid);
    ball.scale.set(0.72, style === 'messy' ? 0.98 : 1.12, 0.42);
    const glow = mesh(sphere(0.03, 64, 48), M.eyeGlow, lid);
    glow.scale.set(0.7, 0.5, 0.3); glow.position.set(0, -0.026, 0.015);
    const look = new THREE.Group(); // highlights drift with the gaze
    lid.add(look);
    mesh(sphere(0.016, 48, 32), M.shine, look).position.set(0.01, 0.024, 0.022);
    mesh(sphere(0.0065, 32, 24), M.shine, look).position.set(-0.012, -0.012, 0.02);
    // ^‿^ happy-closed eye shown for big smiles
    const happy = mesh(torus(0.03, 0.0065, 16, 64, Math.PI), M.lash, eg);
    happy.position.set(0, -0.006, 0.012); happy.visible = false;
    eyes.push({ lid, iris: look, pupil: glow, happy });
  }
  // short, soft brows sitting high = relaxed, friendly
  const brows = [];
  for (const s of [-1, 1]) {
    const bg = new THREE.Group();
    stickTo(bg, s * 0.11, BROW_Y - (style === 'messy' ? 0.008 : 0), 0.0);
    const b = mesh(capsule(style === 'messy' ? 0.019 : 0.0155, 0.048), M.brow, bg);
    b.rotation.z = Math.PI / 2 - s * 0.1;
    b.scale.set(1, 1, 0.55);
    face.add(bg);
    brows.push(bg);
  }

  // mouth: closed smile line, or an open "D" smile (teeth + tongue)
  const mouthG = new THREE.Group();
  stickTo(mouthG, 0, -0.118, 0.003);
  face.add(mouthG);
  const smile = mesh(torus(0.036, 0.0075, 16, 96, Math.PI * 0.8), M.lip, mouthG);
  smile.rotation.z = Math.PI + Math.PI * 0.075;
  smile.position.y = 0.012;
  const open = new THREE.Group();
  mouthG.add(open);
  mesh(smileGeometry(0.046, 0.036), M.mouth, open).position.set(0, 0.006, -0.004);
  const teeth = mesh(smileGeometry(0.038, 0.009, 0.003), M.teeth, open);
  teeth.position.set(0, 0.002, 0.0015); teeth.scale.set(1, 1, 1);
  const tongue = mesh(sphere(0.02, 48, 32), M.tongue, open);
  tongue.scale.set(1.25, 0.6, 0.35); tongue.position.set(0, -0.022, 0.0);
  for (const s of [-1, 1]) {
    const bl = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.075), M.blush);
    stickTo(bl, s * 0.17, -0.085, -0.004);
    face.add(bl);
  }

  if (alien) {
    for (const [x, y, r] of [[0.07, 0.2, 0.022], [-0.1, 0.22, 0.016], [0.16, 0.15, 0.014]]) {
      const sp = mesh(sphere(r, 32, 24), M.spot, face);
      sp.scale.set(1, 1, 0.12); stickTo(sp, x, y, 0.0005);
    }
  }
  // ================= hair
  const hairG = new THREE.Group();
  head.add(hairG);
  if (alien) {
    // no hair
  } else if (style === 'beanie') {
    // knitted beanie: ribbed dome + thick folded brim
    const dome = mesh(sphereMap(200, 120, (d) => {
      const base = headPoint(d);
      const a = Math.atan2(d.x, d.z);
      const rib = 0.0035 * Math.sin(44 * a) * Math.cos(Math.asin(d.y)) ** 0.5;
      return base.add(d.clone().multiplyScalar(0.03 + rib + 0.012 * Math.max(0, d.y)));
    }), M.knit, hairG);
    dome.geometry = clipBelow(dome.geometry, -0.0);
    dome.rotation.x = -0.14;
    dome.position.y = 0.09;
    const brim = mesh(torus(R * 1.02, 0.05, 48, 560), M.knitRib, hairG);
    brim.geometry = ribbedTorus(brim.geometry, 56, 0.0035);
    brim.rotation.x = Math.PI / 2 - 0.14;
    brim.position.set(0, 0.125, -0.016);
    brim.scale.set(1.05, 1.0, 0.98);
  } else {
    mesh(hairGeometry(style), M.hair, hairG);
    for (const l of lockPaths(style)) mesh(lockGeometry(l.path, style, l.r, l.lift ?? -0.004, style === 'messy' ? 0.55 : 0.42), M.hair, hairG);
  }
  if (style === 'bun') {
    const bun = mesh(sphere(0.11), M.hair, hairG);
    bun.position.set(0, 0.29, -0.1);
    const band = mesh(torus(0.07, 0.016), M.accent, hairG);
    band.position.set(0, 0.235, -0.075); band.rotation.x = Math.PI / 2 - 0.5;
  }

  // ================= glasses
  if (glasses === 'sunglasses' || glasses === 'round') {
    const shades = glasses === 'sunglasses';
    const frameM = shades ? glossy('#1a1c22') : plain('#3a3f4b', { roughness: 0.35 });
    const lensM = shades ? glossy('#20232b') : new THREE.MeshPhysicalMaterial({ color: '#e8f0ff', roughness: 0.05, transparent: true, opacity: 0.18 });
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      stickTo(g, s * 0.108, EYE_Y + 0.004, -0.014);
      const r = shades ? 0.064 : 0.058;
      const lens = mesh(new THREE.CylinderGeometry(r, r, 0.008, 96), lensM, g);
      lens.rotation.x = Math.PI / 2; lens.scale.set(shades ? 1.18 : 1, 1, shades ? 0.9 : 1);
      const rim = mesh(torus(r, shades ? 0.011 : 0.0075, 24, 128), frameM, g);
      rim.scale.set(shades ? 1.18 : 1, shades ? 0.9 : 1, 1);
      face.add(g);
      const arm = mesh(capsule(0.006, 0.2), frameM, face);
      arm.rotation.x = Math.PI / 2; arm.position.set(s * 0.258, EYE_Y + 0.01, 0.07); arm.rotation.y = -s * 0.1;
    }
    const bridge = mesh(torus(0.022, 0.006, 16, 48, Math.PI), frameM, face);
    bridge.position.set(0, EYE_Y + 0.012, surf(0, EYE_Y) + 0.012);
  }

  // ================= headset
  const phones = new THREE.Group();
  mesh(torus(R + 0.06, 0.02, 24, 128, Math.PI), M.gear, phones).position.y = 0.0;
  for (const s of [-1, 1]) {
    const cup = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 96), M.gear, phones);
    cup.rotation.z = Math.PI / 2; cup.position.set(s * (R + 0.04), -0.03, 0);
    const pad = mesh(torus(0.055, 0.018, 24, 96), M.gearPad, phones);
    pad.rotation.y = Math.PI / 2; pad.position.set(s * (R + 0.012), -0.03, 0);
  }
  const mic = new THREE.Group();
  const boom = mesh(capsule(0.009, 0.18), M.gear, mic);
  boom.rotation.x = Math.PI / 2.2; boom.position.set(0, -0.07, 0.09);
  mesh(sphere(0.022), M.accent, mic).position.set(0, -0.11, 0.18);
  mic.position.set(R + 0.03, -0.05, 0); mic.rotation.y = -0.55;
  phones.add(mic);
  phones.visible = false;
  head.add(phones);

  // ================= arms: soft sleeves, rounded mitten hands
  const makeArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.17 * side, SHOULDER_Y, 0);
    mesh(sphere(0.064), M.top, shoulder);
    const upper = mesh(capsule(0.064, 0.09), M.top, shoulder);
    upper.position.y = -0.08;
    const elbow = new THREE.Group();
    elbow.position.y = -0.16;
    shoulder.add(elbow);
    mesh(sphere(0.064), M.top, elbow);
    // balloon sleeve gathered into a ribbed cuff
    mesh(lathe([[0.064, 0.0], [0.068, -0.04], [0.064, -0.085], [0.05, -0.11], [0.0, -0.115]], 64, 40), M.top, elbow);
    const cuff = mesh(torus(0.042, 0.017, 24, 96), M.topRib, elbow);
    cuff.rotation.x = Math.PI / 2; cuff.position.y = -0.112;
    const hand = new THREE.Group();
    hand.position.y = -0.14;
    elbow.add(hand);
    // palm faces the body; four fingers + thumb, gently curled
    const palm = mesh(sphere(0.042), M.skin, hand);
    palm.scale.set(0.62, 1.0, 1.05); palm.position.y = -0.012;
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Group();
      f.position.set(-side * 0.003, -0.045, -0.026 + i * 0.0175);
      f.rotation.set(0, 0, side * 0.18);
      const len = [0.026, 0.032, 0.03, 0.024][i];
      mesh(capsule(0.0105, len), M.skin, f).position.y = -len / 2 - 0.004;
      hand.add(f);
    }
    const thumb = new THREE.Group();
    thumb.position.set(-side * 0.012, -0.02, 0.04);
    thumb.rotation.set(-0.6, 0, -side * 0.35);
    mesh(capsule(0.0125, 0.026), M.skin, thumb).position.y = -0.018;
    hand.add(thumb);
    hips.add(shoulder);
    const setReach = (k) => { upper.scale.y = k; upper.position.y = -0.08 * k; elbow.position.y = -0.16 * k; };
    return { shoulder, elbow, hand, upper, setReach };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  // ================= legs + chunky sneakers
  const makeLeg = (side) => {
    const thigh = new THREE.Group();
    thigh.position.set(0.095 * side, 0.0, 0);
    mesh(capsule(0.085, 0.2), M.pants, thigh).position.y = -0.12;
    const knee = new THREE.Group();
    knee.position.y = -0.2;
    thigh.add(knee);
    mesh(sphere(0.083), M.pants, knee);
    if (sideStripe) {
      const st1 = mesh(capsule(0.009, 0.2), M.stripe, thigh); st1.position.set(side * 0.084, -0.12, 0);
      const st2 = mesh(capsule(0.009, 0.12), M.stripe, knee); st2.position.set(side * 0.09, -0.07, 0); st2.rotation.z = side * 0.04;
    }
    // baggy lower leg, gathered into a ribbed ankle cuff
    mesh(lathe([[0.0845, 0.03], [0.086, -0.02], [0.089, -0.05], [0.093, -0.1], [0.085, -0.135], [0.06, -0.152], [0.054, -0.17], [0.052, -0.22], [0.0, -0.23]], 96, 64), M.pants, knee);
    const legCuff = mesh(torus(0.058, 0.02, 24, 96), M.pants, knee);
    legCuff.rotation.x = Math.PI / 2; legCuff.position.y = -0.165;
    const shoe = new THREE.Group();
    shoe.position.set(0, -0.205, 0.03);
    knee.add(shoe);
    // sneaker: coloured upper, white rounded sole + toe cap, white laces
    const upperShoe = mesh(sphere(0.082), M.shoe, shoe);
    upperShoe.scale.set(0.98, 0.72, 1.4);
    const sole = mesh(sphere(0.088, 96, 48, 0, TAU, Math.PI * 0.5, Math.PI * 0.5), M.shoe, shoe);
    sole.scale.set(1.0, 0.5, 1.45); sole.position.y = -0.008;
    const toe = mesh(sphere(0.06, 96, 48), M.sole, shoe);
    toe.scale.set(1.15, 0.62, 0.8); toe.position.set(0, -0.012, 0.072);
    for (let i = 0; i < 3; i++) {
      const lace = mesh(capsule(0.0065, 0.045), M.lace, shoe);
      lace.rotation.z = Math.PI / 2; lace.position.set(0, 0.052 - i * 0.003, -0.01 + i * 0.026);
    }
    const heelTab = mesh(sphere(0.032, 48, 32), M.accent, shoe);
    heelTab.scale.set(0.9, 1.1, 0.6); heelTab.position.set(0, 0.03, -0.1);
    const stripe = mesh(torus(0.07, 0.008, 16, 96, Math.PI * 0.9), M.accent, shoe);
    stripe.rotation.set(0, Math.PI / 2, 0); stripe.scale.set(1, 0.45, 1.25); stripe.position.set(0, 0.0, -0.005);
    hips.add(thigh);
    return { thigh, knee };
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // ================= noodle bowl (eating)
  const bowl = new THREE.Group();
  mesh(sphere(0.08, 96, 48, 0, TAU, Math.PI / 2, Math.PI / 2), M.bowl, bowl);
  const rim = mesh(torus(0.079, 0.009), M.bowlIn, bowl);
  rim.rotation.x = Math.PI / 2;
  const noodles = mesh(new THREE.CircleGeometry(0.073, 64), M.noodle, bowl);
  noodles.rotation.x = -Math.PI / 2; noodles.position.y = -0.01;
  for (const s of [-1, 1]) {
    const stick = mesh(capsule(0.005, 0.2), M.wood, bowl);
    stick.position.set(0.018 * s, 0.07, -0.01); stick.rotation.set(-0.3, 0, -0.3 + s * 0.06);
  }
  bowl.position.set(0, -0.03, 0.065);
  bowl.rotation.x = 0.8;
  bowl.visible = false;
  armR.hand.add(bowl);

  // ================= motion (spring-driven, Lottie-like)
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
    pose: 'sit', activity: 'type', lookAround: true,
    phase: Math.random() * 10, walkPhase: 0, opacity: 1,
    setHeadphones(on, withMic = false) { phones.visible = on; mic.visible = on && withMic; },
    hop(strength = 1) { S.squash.kick(-2.2 * strength); },
    setOpacity(o) {
      if (Math.abs(o - api.opacity) < 0.001) return;
      api.opacity = o;
      root.traverse(obj => {
        for (const m of obj.material ? [].concat(obj.material) : []) {
          m.userData.baseOpacity ??= m.opacity;
          m.transparent = o < 0.999 || m.userData.baseOpacity < 1 || m === M.blush;
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
        for (const m of o.material ? [].concat(o.material) : []) if (!seen.has(m)) { seen.add(m); m.map?.dispose(); m.dispose(); }
      });
    },
  };

  function step(t, dt) {
    const p = t + api.phase;
    const pose = api.pose, act = api.activity;

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

    if (t >= timers.nextBlink) {
      timers.blinkAt = t;
      timers.double = Math.random() < 0.2;
      timers.nextBlink = t + 2.2 + Math.random() * 3.5;
    }
    let blink = ease.bump((t - timers.blinkAt) / 0.14);
    if (timers.double) blink = Math.max(blink, ease.bump((t - timers.blinkAt - 0.22) / 0.14));

    if (t >= timers.nextLook && api.lookAround) {
      const wide = act === 'idle' || act === 'listen' || pose !== 'sit';
      timers.lookY = (Math.random() - 0.5) * (wide ? 0.8 : 0.3);
      timers.lookX = (Math.random() - 0.5) * 0.12;
      timers.nextLook = t + 1.4 + Math.random() * (act === 'type' ? 4 : 2.5);
    }

    let hipsY, thigh, knee, lean = 0;
    let aLx, aLz, aRx, aRz, eL, eR, eLz = 0, eRz = 0, lift = 0, reach = 1;
    let hX = timers.lookX, hY = timers.lookY, hZ = Math.sin(p * 0.7) * 0.03;
    let mouth = 0.0, brow = 0.1, browTilt = 0, eye = 1;
    let gazeX = timers.lookY * 0.6, gazeY = 0;
    const breath = Math.sin(p * 1.6);

    if (pose === 'sit') { hipsY = SIT_HIPS; thigh = -Math.PI / 2; knee = Math.PI / 2; }
    else if (pose === 'walk') { hipsY = STAND_HIPS + 0.01; thigh = 0; knee = 0.1; lean = 0.1; }
    else { hipsY = STAND_HIPS; thigh = 0; knee = 0; }

    const rest = () => {
      if (pose === 'sit') { aLx = -0.5; aRx = -0.5; aLz = 0.14; aRz = -0.14; eL = eR = -1.0; }
      else { aLx = 0.04 + breath * 0.03; aRx = 0.04 - breath * 0.03; aLz = -0.14; aRz = 0.14; eL = eR = -0.22; }
    };

    switch (act) {
      case 'type': {
        const burst = Math.sin(p * 0.55) + Math.sin(p * 1.3) * 0.5 > -0.6 ? 1 : 0;
        const tap = (o) => burst * Math.max(0, Math.sin(p * 17 + o)) ** 3;
        aLx = -0.7; aRx = -0.7; aLz = 0.22; aRz = -0.22;
        eL = -1.3 + tap(0) * 0.14; eR = -1.3 + tap(2.1) * 0.14;
        lean = pose === 'sit' ? 0.08 : 0;
        hX = 0.1 + burst * Math.sin(p * 17) * 0.006 + (1 - burst) * 0.03;
        hY = timers.lookY * (burst ? 0.12 : 0.45);
        gazeY = -0.6; gazeX = Math.sin(p * 0.9) * 0.4 * burst;
        brow = 0; mouth = 0;
        break;
      }
      case 'eat': {
        const cyc = (p * 0.45) % 1;
        const up = ease.inOut(cyc < 0.5 ? cyc * 2 : 2 - cyc * 2);
        aRx = -0.35 - up * 0.25; aRz = -0.15 - up * 0.15; eR = -1.35 - up * 0.85;
        aLx = -0.5; aLz = 0.14; eL = -1.0;
        hX = 0.1 - up * 0.08; hY = -up * 0.1;
        mouth = up > 0.7 ? 0.45 + Math.sin(p * 18) * 0.25 : 0.05;
        eye = up > 0.8 ? 0.1 : 1;     // ^‿^
        brow = 0.25; gazeY = -0.4;
        break;
      }
      case 'raise': {
        aRx = -Math.PI + 0.12; aRz = 0.28 + Math.sin(p * 7) * 0.12; eR = -0.1 + Math.sin(p * 7) * 0.1;
        lift = 0.05; reach = 1.25;
        aLx = pose === 'sit' ? -0.5 : 0.1; aLz = pose === 'sit' ? 0.14 : -0.25; eL = pose === 'sit' ? -1.0 : -0.3;
        hX = -0.1; hY = Math.sin(p * 2.2) * 0.22; hZ = Math.sin(p * 3.1) * 0.07;
        brow = 0.45; browTilt = 0.25; mouth = 0.35; gazeY = 0.3;
        if (t >= timers.nextHop) { S.squash.kick(-2.4); timers.nextHop = t + 2.4; }
        break;
      }
      case 'wave': {
        aRx = -Math.PI + 0.45; aRz = 0.45 + Math.sin(p * 9) * 0.45; eR = -0.35;
        lift = 0.04; reach = 1.1;
        aLx = pose === 'sit' ? -0.5 : 0.05; aLz = pose === 'sit' ? 0.14 : -0.15; eL = pose === 'sit' ? -1.0 : -0.22;
        hZ = Math.sin(p * 9) * 0.05 + 0.06; hX = -0.06; hY *= 0.3;
        brow = 0.45; mouth = 0.55; eye = 0.1; gazeX = 0; gazeY = 0;   // big happy ^‿^ wave
        break;
      }
      case 'talk': {
        aLx = -0.35 + Math.sin(p * 2.3) * 0.15; aRx = -0.4 + Math.sin(p * 2.9 + 1) * 0.2;
        aLz = 0.05 - Math.max(0, Math.sin(p * 1.7)) * 0.3; aRz = -0.05 + Math.max(0, Math.sin(p * 2.1)) * 0.3;
        eL = -1.3 + Math.sin(p * 2.3) * 0.35; eR = -1.4 + Math.sin(p * 2.9) * 0.4;
        mouth = 0.12 + Math.abs(Math.sin(p * 11) * Math.sin(p * 3.7)) * 0.45;
        hX = Math.sin(p * 2.6) * 0.06; brow = 0.15 + Math.sin(p * 1.9) * 0.2;
        break;
      }
      case 'pockets': {   // hands tucked in the hoodie pocket
        aLx = -0.3; aRx = -0.3; aLz = -0.36; aRz = 0.36; eL = eR = -0.9; eLz = 0.95; eRz = -0.95;
        hZ = Math.sin(p * 0.8) * 0.04; brow = 0.15;
        break;
      }
      case 'cross': {
        aLx = -1.25; aRx = -1.1; aLz = -0.12; aRz = 0.12; eL = -0.15; eR = -0.05; eLz = 1.5; eRz = -1.5;
        hY = timers.lookY * 0.5; brow = 0.15; hX = -0.03;
        break;
      }
      case 'listen':
        rest();
        hX = 0.05 + Math.max(0, Math.sin(p * 2.2)) * 0.1; brow = 0.2;
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
      bounce = Math.abs(Math.cos(api.walkPhase)) * 0.035;
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
    torso.scale.set(1 + breath * 0.012, 1 + breath * 0.004, 1 + breath * 0.012);

    armL.shoulder.rotation.set(S.aLx.x, 0, S.aLz.x);
    armR.shoulder.rotation.set(S.aRx.x, 0, S.aRz.x);
    armL.elbow.rotation.set(S.eL.x, 0, S.eLz.x);
    armR.elbow.rotation.set(S.eR.x, 0, S.eRz.x);
    armR.shoulder.position.y = SHOULDER_Y + S.lift.x;
    armR.setReach(Math.max(0.9, S.reach.x));

    headG.rotation.set(S.hX.x, S.hY.x, S.hZ.x);
    antennae.forEach((g, i) => { g.rotation.x = -S.hX.v * 0.05 + Math.sin(p * 2.4 + i) * 0.06 - S.squash.v * 0.02; });
    hairG.rotation.x = -S.hX.v * 0.008;
    hairG.rotation.z = -S.hZ.v * 0.01;

    const happy = S.eye.x < 0.35;
    const eyeOpen = Math.max(0.06, (happy ? 1 : S.eye.x) * (1 - blink * 0.94));
    for (const e of eyes) {
      e.lid.visible = !happy;
      e.happy.visible = happy;
      e.lid.scale.y = eyeOpen;
      e.iris.position.x = S.gazeX.x * 0.006; e.iris.position.y = S.gazeY.x * 0.006;
    }
    brows[0].position.y = brows[1].position.y = BROW_Y + S.brow.x * 0.02;
    brows[0].rotation.z = -S.browTilt.x * 0.3; brows[1].rotation.z = S.browTilt.x * 0.3;
    const mo = Math.max(0, S.mouth.x);
    smile.visible = mo < 0.12;
    open.visible = mo >= 0.12;
    open.scale.set(0.8 + mo * 0.35, Math.min(1.2, 0.35 + mo * 1.2), 1);
    bowl.visible = act === 'eat' && pose !== 'walk';
  }

  step(0, 0.016);
  for (const k in S) S[k].snap(S[k].target);
  step(0, 0.016);
  return api;
}
