// The shared virtual desk: everyone on an arc-shaped bench facing you,
// with a café corner where people walk off to when they go for lunch.
import { THREE, createAvatar, emojiSprite, shade, addSoftLights, configureRenderer } from '../lib/avatar.js';
import { ease, Spring } from '../lib/toon.js';
import { makeCharacter } from '../lib/characters.js';
import { FocusAura } from '../lib/aura.js';
import { Pet } from '../lib/pets.js';
import { buildPlant, plantStage } from '../lib/plant.js';
import { Sky } from '../lib/sky.js';

// soft, film-like materials for the furniture (matches the characters)
const toonMat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...o });
const flatMat = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
const outlineMat = () => null;
const outline = () => {};

const INK = '#1f2433';
const OUTLINE_W = 0.022;
import { display, STATUS } from '../lib/status.js';

const SEAT_ARC = 1.25;   // spacing between seats along the arc
const DESK_DEPTH = 0.7;

function dndTexture(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 300;
  const x = c.getContext('2d');
  x.fillStyle = '#EF4444';
  x.beginPath(); x.roundRect(6, 6, 500, 288, 34); x.fill();
  x.strokeStyle = '#ffffff'; x.lineWidth = 10;
  x.beginPath(); x.roundRect(22, 22, 468, 256, 24); x.stroke();
  x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 62px -apple-system, "Segoe UI", Roboto, sans-serif';
  x.fillText('DO NOT', 256, 92);
  x.fillText('DISTURB', 256, 160);
  x.font = '600 34px -apple-system, "Segoe UI", Roboto, sans-serif';
  const first = String(name || '').split(' ')[0].slice(0, 14);
  x.fillText(`🎧 ${first} is focusing`, 256, 232);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// the pet is handled separately, so changing it doesn't rebuild the character
const lookKey = (m) => { const { pet, ...a } = m.avatar || {}; return JSON.stringify([m.color, a]); };
const DESK_TOP = 0.785;
const STANDUP_STATES = new Set(['desk', 'dnd']);

export class DeskScene {
  constructor(container, { onSelect, dark = false } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.people = new Map(); // id -> person
    this.helps = [];
    this.clock = new THREE.Clock();
    this.t = 0;
    this.dark = dark;
    this.zoom = 1;
    this.yaw = 0;
    this.radius = 3;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    configureRenderer(r);
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

    this.scene.add(this.camera);             // the sky hangs off the camera
    this.sky = new Sky(this.camera, container);
    const lights = addSoftLights(this.scene);
    this.hemi = lights.hemi;
    this.sun = lights.key;
    this.lights = lights;

    const fade = document.createElement('canvas');
    fade.width = fade.height = 256;
    const fctx = fade.getContext('2d');
    const grad = fctx.createRadialGradient(128, 128, 30, 128, 128, 128);
    grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(1, '#000');
    fctx.fillStyle = grad; fctx.fillRect(0, 0, 256, 256);
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, alphaMap: new THREE.CanvasTexture(fade), depthWrite: false });
    const floor = this.floor = new THREE.Mesh(new THREE.CircleGeometry(10, 64), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.renderOrder = -20;   // drawn before the sky, so the sky shows over the far floor
    this.scene.add(floor);

    this.furniture = new THREE.Group();
    this.scene.add(this.furniture);
    this.cafe = this.#buildCafe();
    this.scene.add(this.cafe.group);

    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    container.appendChild(this.labels);

    this.raycaster = new THREE.Raycaster();
    this.#bindInput();
    this.setTheme(dark);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.layout(1);

    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      // ~30 fps is plenty for this scene and halves GPU/battery use in the side panel
      const now = performance.now();
      if (now - (this.lastFrame || 0) < 32) return;
      this.lastFrame = now;
      this.#frame();
    };
    loop();
  }

  setTheme(dark) {
    this.dark = dark;
    this.floorMat.color.set(dark ? '#262a33' : '#eef1f6');
    this.hemi.color.set(dark ? '#cfd8ff' : '#ffffff');
    this.hemi.groundColor.set(dark ? '#1b1e25' : '#b9c3d6');
    this.hemi.intensity = dark ? 0.8 : 1.15;
    this.sun.intensity = dark ? 1.8 : 2.3;
    this.lights.rim.intensity = dark ? 1.8 : 1.4;
    this.base = { hemi: this.hemi.intensity, sun: this.sun.intensity };   // the sky scales these
    this.sky?.setTheme(dark);
  }

  // ---------- layout ----------
  seatTransform(seat, count) {
    // Up to 4 people share one gently curved bench; bigger teams get a second
    // (staggered) row behind, like a studio, so everyone stays big and visible.
    const n = Math.max(count, 1);
    const rows = n <= 4 ? 1 : Math.max(2, Math.ceil(n / 5));
    const perRow = Math.ceil(n / rows);
    const row = Math.floor(seat / perRow);
    const inRow = row < rows - 1 ? perRow : n - perRow * (rows - 1);
    const col = seat - row * perRow;
    const SP = 1.22;
    const x = (col - (inRow - 1) / 2) * SP + (row % 2 ? SP * 0.5 : 0);
    const z = -row * 2.1 - x * x * 0.07;
    const rotY = -x * 0.12;
    return { x, z, rotY, a: rotY, row };
  }

  layout(count) {
    const n = Math.max(count, 1);
    if (this.laidOut === n) return;
    this.laidOut = n;
    this.radius = Math.max(2.8, (n * SEAT_ARC) / (Math.PI * 0.6));
    // rebuild desks + chairs
    this.furniture.clear();
    this.seats = [];
    for (let i = 0; i < n; i++) {
      const tr = this.seatTransform(i, n);
      const g = this.#buildWorkstation();
      g.position.set(tr.x, 0, tr.z);
      g.rotation.y = tr.rotY;
      this.furniture.add(g);
      this.seats.push({ ...tr, group: g, chair: g.userData.chair, screen: g.userData.screen, lid: g.userData.lid, seatMat: g.userData.seatMat, logo: g.userData.logo, dnd: g.userData.dnd, dndBoard: g.userData.dndBoard, dndShow: 0 });
    }
    // café sits behind the bench on the right, visible over everyone's heads
    let backZ = 0, maxX = 0;
    for (let i = 0; i < n; i++) { const t = this.seatTransform(i, n); backZ = Math.min(backZ, t.z); maxX = Math.max(maxX, t.x); }
    this.cafe.group.position.set(maxX * 0.55 + 0.7, 0, backZ - 1.9);
    // the BRB corner: back-left, opposite the café
    this.brbCorner = { x: -(maxX * 0.55 + 0.9), z: backZ - 1.6 };
    this.benchEdge = maxX + 1.0;   // walking round the end of the bench
    this.frontZ = 1.0;             // just in front of the desks
    this.cafe.group.rotation.y = 0;
    this.#frameCamera();
    // reassign people to seats
    for (const p of this.people.values()) this.#placeAtSeat(p, true);
  }

  // Fit the camera so every seat, desk and the café are in view, as tight as possible.
  #frameCamera() {
    const n = this.laidOut || 1;
    const pts = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const add = (x, y, z) => { pts.push(new THREE.Vector3(x, y, z)); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
    for (let i = 0; i < n; i++) {
      const s = this.seatTransform(i, n);
      const fx = Math.sin(s.rotY), fz = Math.cos(s.rotY);
      add(s.x, 2.15, s.z);                      // head + label room
      add(s.x - fx * 0.4, 0, s.z - fz * 0.4);   // chair
      add(s.x + fx * 0.95, 0, s.z + fz * 0.95); // desk front
    }
    const c = this.cafe.group.position;
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(c.x + dx, 0, c.z + dz);
    add(c.x, 1.9, c.z);
    const bc = this.brbCorner;
    for (const [dx, dz] of [[-0.9, -0.5], [0.9, -0.5], [-0.9, 0.9], [0.9, 0.9]]) add(bc.x + dx, 0, bc.z + dz);
    add(bc.x, 1.8, bc.z);
    if (this.standup) {                         // make room for the stand-up circle in front
      const c = this.#circle();
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) add(c.x + dx * (c.r + 0.5), 0, c.z + dz * (c.r + 0.5));
      add(c.x, 2.1, c.z + c.r);
    }
    const elev = this.elev = this.seatTransform(n - 1, n).row > 0 ? 0.66 : 0.55;
    this.target = new THREE.Vector3((minX + maxX) / 2, 0.7, (minZ + maxZ) / 2);
    const cam = this.camera;
    cam.aspect = (this.width / this.height) || 1;
    cam.updateProjectionMatrix();
    const place = (dist) => {
      cam.position.set(this.target.x, this.target.y + Math.sin(elev) * dist, this.target.z + Math.cos(elev) * dist);
      cam.lookAt(this.target);
      cam.updateMatrixWorld();
    };
    const bounds = () => {
      const v = new THREE.Vector3();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { v.copy(p).project(cam); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      return { x0, x1, y0, y1 };
    };
    const fit = (limit) => {
      let lo = 2, hi = 60;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        place(mid);
        const b = bounds();
        if (Math.max(-b.x0, b.x1) < limit && Math.max(-b.y0, b.y1) < limit) hi = mid; else lo = mid;
      }
      return hi;
    };
    // fit, re-centre the projected content, then fit again
    for (let k = 0; k < 2; k++) {
      const d = fit(0.9);
      place(d);
      const b = bounds();
      const half = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * d;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      this.target.addScaledVector(up, ((b.y0 + b.y1) / 2) * half);
      this.target.addScaledVector(right, ((b.x0 + b.x1) / 2) * half * cam.aspect);
    }
    this.camDist = fit(0.88);
  }

  #mats() {
    if (this._m) return this._m;
    this._m = {
      ink: outlineMat(INK, OUTLINE_W),
      top: toonMat('#fdfcf8'),
      edge: toonMat('#e4e1d8'),
      leg: toonMat('#b9c0cc'),
      panel: toonMat('#eceef3'),
      alu: toonMat('#d5dae3'),
      keys: toonMat('#3a3f4c'),
      mug: toonMat('#ffffff'),
      coffee: flatMat('#7a4a2a'),
      wood: toonMat('#e3bf8f'),
      woodDark: toonMat('#c99d6a'),
      metal: toonMat('#4a5060'),
      rug: toonMat('#f7ead0'),
      pot: toonMat('#ef8a68'),
      leaf: toonMat('#5cc184'),
      leafDark: toonMat('#3fa56b'),
      screenOff: '#2b2f38',
    };
    return this._m;
  }

  #buildWorkstation() {
    const M = this.#mats();
    const g = new THREE.Group();
    const add = (geo, mat, { x = 0, y = 0, z = 0, ink = true, parent = g, shadow = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow; m.receiveShadow = true;
      if (ink) outline(m, M.ink);
      parent.add(m);
      return m;
    };
    // desk top in front of the seat (towards viewer = +z)
    add(new THREE.BoxGeometry(1.15, 0.05, DESK_DEPTH), M.top, { y: 0.76, z: 0.55 });
    add(new THREE.BoxGeometry(1.15, 0.018, DESK_DEPTH), M.edge, { y: 0.728, z: 0.55, ink: false, shadow: false });
    for (const x of [-0.52, 0.52]) add(new THREE.BoxGeometry(0.045, 0.72, DESK_DEPTH - 0.12), M.leg, { x, y: 0.36, z: 0.55 });
    add(new THREE.BoxGeometry(1.08, 0.3, 0.02), M.panel, { y: 0.56, z: 0.87 });

    // laptop pulled to the front edge so hands land on the keyboard
    add(new THREE.BoxGeometry(0.44, 0.018, 0.28), M.alu, { y: 0.795, z: 0.34 });
    add(new THREE.BoxGeometry(0.36, 0.004, 0.13), M.keys, { y: 0.806, z: 0.37, ink: false, shadow: false });
    const lid = new THREE.Group();
    lid.position.set(0, 0.8, 0.48);
    add(new THREE.BoxGeometry(0.44, 0.29, 0.014), M.alu, { y: 0.145, parent: lid });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.39, 0.25), new THREE.MeshBasicMaterial({ color: '#9fb4ff' }));
    screen.position.set(0, 0.145, -0.008);
    screen.rotation.y = Math.PI;
    lid.add(screen);
    // glowing logo on the back of the lid (the side we see)
    const logo = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    logo.position.set(0, 0.15, 0.008);
    lid.add(logo);
    lid.rotation.x = 0.22;
    g.add(lid);

    // mug with coffee
    const mug = add(new THREE.CylinderGeometry(0.048, 0.042, 0.1, 32), M.mug, { x: 0.4, y: 0.835, z: 0.36 });
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.04, 24), M.coffee);
    coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.046;
    mug.add(coffee);
    const handle = add(new THREE.TorusGeometry(0.026, 0.009, 10, 20), M.mug, { x: 0.05, parent: mug });
    handle.rotation.y = Math.PI / 2;

    // chair (cushion tinted per person)
    const chair = new THREE.Group();
    const seatMat = toonMat('#c9ced8');
    add(new THREE.BoxGeometry(0.5, 0.08, 0.48), seatMat, { y: 0.43, parent: chair });
    const back = add(new THREE.BoxGeometry(0.48, 0.5, 0.07), seatMat, { y: 0.78, z: -0.25, parent: chair });
    back.rotation.x = -0.08;
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.36, 16), M.metal, { y: 0.21, parent: chair, ink: false });
    add(new THREE.CylinderGeometry(0.24, 0.24, 0.035, 5), M.metal, { y: 0.03, parent: chair });
    g.add(chair);
    // "Do not disturb" desk sign: a little A-frame board on the front of the desk, shown in Focus mode
    const dnd = new THREE.Group();
    dnd.position.set(-0.3, 0.785, 0.74);
    dnd.rotation.y = 0.12;
    const boardMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.018), [M.top, M.top, M.top, M.top, boardMat, M.top]);
    board.position.set(0, 0.155, 0.014); board.rotation.x = -0.05; board.castShadow = true;
    dnd.add(board);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.28, 0.012), M.alu);
    leg.position.set(0, 0.14, -0.04); leg.rotation.x = 0.3;
    dnd.add(leg);
    dnd.scale.setScalar(0.001); dnd.visible = false;
    g.add(dnd);
    g.userData = { chair, screen, lid, seatMat, logo, dnd, dndBoard: boardMat };
    return g;
  }

  #buildCafe() {
    const M = this.#mats();
    const group = new THREE.Group();
    const add = (geo, mat, { x = 0, y = 0, z = 0, ink = true, shadow = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow; m.receiveShadow = true;
      if (ink) outline(m, M.ink);
      group.add(m);
      return m;
    };
    const rug = add(new THREE.CircleGeometry(1.25, 64), M.rug, { y: 0.005, ink: false, shadow: false });
    rug.rotation.x = -Math.PI / 2;
    add(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 48), M.wood, { y: 0.72 });
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 16), M.metal, { y: 0.36, ink: false });
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 32), M.metal, { y: 0.015 });
    // plant
    add(new THREE.CylinderGeometry(0.17, 0.12, 0.3, 32), M.pot, { x: 0.95, y: 0.15, z: -0.75 });
    for (let i = 0; i < 7; i++) {
      const leaf = add(new THREE.SphereGeometry(0.15, 32, 20), i % 2 ? M.leaf : M.leafDark,
        { x: 0.95 + Math.cos(i * 0.9) * 0.12, y: 0.42 + (i % 3) * 0.11, z: -0.75 + Math.sin(i * 0.9) * 0.12 });
      leaf.scale.set(1, 1.15, 1);
    }
    const label = emojiSprite('☕', 0.35);
    label.position.set(0, 1.25, 0);
    label.material.opacity = 0.6;
    group.add(label);
    // seat slots around the table
    const slots = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * 0.35 + i * (Math.PI * 2 / 6);
      const x = Math.cos(a) * 0.85, z = Math.sin(a) * 0.85;
      add(new THREE.CylinderGeometry(0.17, 0.15, 0.42, 32), M.woodDark, { x, y: 0.21, z });
      slots.push({ x, z, rotY: Math.atan2(-x, -z) });
    }
    return { group, slots };
  }

  // ---------- people ----------
  update(snapshot) {
    const members = snapshot.members || [];
    this.helps = snapshot.helps || [];
    this.meId = snapshot.me?.id;
    // the sky follows my own weather
    const w = snapshot.me?.weather || null;
    if ((w && w.code) !== (this.weather && this.weather.code) || !!w !== !!this.weather) { this.weather = w; this.sky.set(w); }
    // stand-up: everyone in it walks to a circle in front of the desks
    const su = snapshot.standup || null;
    if ((su && su.id) !== (this.standup && this.standup.id)) {
      this.standup = su;
      this.#frameCamera();
    } else this.standup = su;
    const speakerKey = su ? su.id + ':' + su.turn : '';
    if (speakerKey !== this.speakerKey) {
      this.speakerKey = speakerKey;
      if (su) setTimeout(() => this.wave(su.order[su.turn], 2), 300);   // "hi, my turn"
    }
    const ids = new Set(members.map(m => m.id));
    for (const [id, p] of this.people) if (!ids.has(id)) this.#remove(p);
    // seats are compacted so the arc stays tidy
    const sorted = [...members].sort((a, b) => a.seat - b.seat);
    this.layout(sorted.length);
    sorted.forEach((m, i) => {
      let p = this.people.get(m.id);
      if (!p) p = this.#add(m);
      else if (p.lookKey !== lookKey(m)) this.#swapLook(p, m);   // they picked a new character
      p.member = m;
      p.seatIndex = i;
      this.#setPet(p, m.avatar?.pet || '');
      this.#applyStatus(p);
    });
    this.#assignCafe();
  }

  #add(m) {
    const av = makeCharacter({ id: m.id, color: m.color, avatar: m.avatar || {} });
    av.root.userData.personId = m.id;
    this.scene.add(av.root);
    const label = document.createElement('button');
    label.className = 'label';
    label.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="st"></span>`;
    label.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect?.(m.id, label.getBoundingClientRect()); });
    this.labels.appendChild(label);
    const p = { id: m.id, lookKey: lookKey(m), member: m, av, label, pos: new THREE.Vector3(), rotY: 0, path: [], badge: null, badgeText: '', fx: [] };
    this.people.set(m.id, p);
    p.isNew = true;
    return p;
  }

  // cardboard box with a "brb" sign, one per person, created on first use
  #box(p) {
    if (p.box) return p.box;
    const g = new THREE.Group();
    const card = new THREE.MeshStandardMaterial({ color: '#C99A62', roughness: 0.85 });
    const cardDark = new THREE.MeshStandardMaterial({ color: '#B4844F', roughness: 0.9 });
    const tape = new THREE.MeshStandardMaterial({ color: '#E8D4A6', roughness: 0.6 });
    const W = 0.78, H = 1.45, D = 0.72;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), card);
    body.position.y = H / 2; body.castShadow = body.receiveShadow = true;
    g.add(body);
    // edge bevels so it reads as a box, not a block
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.03, H, 0.03), cardDark);
      e.position.set(x * W / 2, H / 2, z * D / 2);
      g.add(e);
    }
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, D + 0.01), tape);
    strip.position.y = H + 0.004;
    g.add(strip);
    for (const sx of [-1, 1]) {               // open flaps on top
      const flap = new THREE.Mesh(new THREE.BoxGeometry(W / 2, 0.015, D), cardDark);
      flap.geometry.translate(sx * W / 4, 0, 0);
      flap.position.set(sx * W / 2, H, 0);
      flap.rotation.z = sx * 0.55;
      flap.castShadow = true;
      g.add(flap);
    }
    // little sign on the front
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fffaf0'; ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#B4844F'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 248, 120);
    ctx.fillStyle = '#5a3d22'; ctx.font = 'bold 64px -apple-system, Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('BRB ☕', 128, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    sign.position.set(0, H * 0.62, D / 2 + 0.003);
    sign.rotation.z = -0.06;
    g.add(sign);
    g.visible = false;
    this.scene.add(g);
    p.box = { group: g, spring: new Spring(0, 90, 7), target: 0 };   // low damping → lands with a bounce
    return p.box;
  }

  #swapLook(p, m) {
    const old = p.av;
    this.scene.remove(old.root);
    old.dispose();
    const av = makeCharacter({ id: m.id, color: m.color, avatar: m.avatar || {} });
    av.root.userData.personId = m.id;
    av.pose = old.pose; av.activity = old.activity;
    av.root.position.copy(old.root.position);
    av.root.rotation.y = old.root.rotation.y;
    av.setOpacity?.(old.opacity ?? 1);
    this.scene.add(av.root);
    av.hop?.(1.2);
    p.av = av;
    p.lookKey = lookKey(m);
  }

  #remove(p) {
    this.scene.remove(p.av.root);
    p.av.dispose();
    p.label.remove();
    if (p.badge) this.scene.remove(p.badge);
    if (p.box) this.scene.remove(p.box.group);
    p.aura?.dispose(this.scene);
    if (p.pet) { this.scene.remove(p.pet.root); p.pet.dispose(); }
    if (p.mic) this.scene.remove(p.mic);
    this.people.delete(p.id);
  }

  #seatPoint(p) {
    const s = this.seats[p.seatIndex];
    // the sitter is slightly behind the desk centre in local space
    return { x: s.x, z: s.z, rotY: s.rotY };
  }

  #placeAtSeat(p, snap) {
    const sp = this.#seatPoint(p);
    if (snap || p.isNew) { p.pos.set(sp.x, 0, sp.z); p.rotY = sp.rotY; }
  }

  #mode(p) {
    const m = p.member;
    if (m.state === 'lunch') return 'cafe';
    if (m.state === 'brb') return 'brb';     // stepped away, still visible
    if (m.state === 'afk' || m.state === 'leave') return 'away';
    if (this.standup?.order.includes(m.id) && STANDUP_STATES.has(m.state)) return 'standup';
    return 'seat';
  }

  #assignCafe() {
    let i = 0;
    for (const p of this.people.values()) {
      if (this.#mode(p) === 'cafe') p.cafeSlot = i++ % this.cafe.slots.length;
    }
    let j = 0;
    for (const p of this.people.values()) if (this.#mode(p) === 'brb') p.brbSlot = j++;
    for (const p of this.people.values()) this.#route(p);
  }

  #worldCafe(slot) {
    const s = this.cafe.slots[slot];
    const g = this.cafe.group;
    const v = new THREE.Vector3(s.x, 0, s.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
    return { x: v.x, z: v.z, rotY: s.rotY + g.rotation.y };
  }

  #route(p) {
    const mode = this.#mode(p);
    const suSlot = mode === 'standup' ? this.standup.order.indexOf(p.id) + '/' + this.standup.order.length : '';
    const key = mode + ':' + (mode === 'cafe' ? p.cafeSlot : mode === 'brb' ? p.brbSlot : mode === 'standup' ? suSlot : p.seatIndex) + ':' + this.laidOut;
    if (p.routeKey === key) return;
    const firstTime = !p.routeKey;
    p.prevMode = p.mode;
    p.mode = mode;
    p.routeKey = key;
    const seat = this.#seatPoint(p);
    const back = { x: seat.x - Math.sin(seat.rotY) * 0.9, z: seat.z - Math.cos(seat.rotY) * 0.9 };
    let dest;
    if (mode === 'cafe') dest = this.#worldCafe(p.cafeSlot);
    else if (mode === 'brb') {
      // walk to the corner; boxes line up in a little grid there
      const k = p.brbSlot || 0, col = k % 2, row = Math.floor(k / 2);
      dest = { x: this.brbCorner.x + (col ? 0.75 : 0) - row * 0.2, z: this.brbCorner.z + row * 0.8, rotY: 0.25 };
    }
    else if (mode === 'away') dest = { x: seat.x - Math.sin(seat.rotY) * 1.3, z: seat.z - Math.cos(seat.rotY) * 1.3, rotY: seat.rotY + Math.PI };
    else if (mode === 'standup') dest = this.#circleSlot(this.standup.order.indexOf(p.id), this.standup.order.length);
    else dest = seat;
    if (firstTime || p.isNew) {
      p.pos.set(dest.x, 0, dest.z); p.rotY = dest.rotY; p.path = []; p.isNew = false;
      p.arrived = true;
      return;
    }
    // leave via the space behind the chair, then on to the destination
    p.path = [new THREE.Vector3(back.x, 0, back.z), new THREE.Vector3(dest.x, 0, dest.z)];
    if (mode === 'brb' || p.prevMode === 'brb') {
      // leave/return via the space behind the chairs
      const via = mode === 'brb' ? back : { x: seat.x - Math.sin(seat.rotY) * 0.9, z: seat.z - Math.cos(seat.rotY) * 0.9 };
      // going to the corner: via the back of the chair. Leaving it: straight to wherever
      // they're headed now (desk, café…), passing behind the chair only when returning to it.
      p.path = mode === 'brb' ? [new THREE.Vector3(via.x, 0, via.z), new THREE.Vector3(dest.x, 0, dest.z)]
        : mode === 'seat' ? [new THREE.Vector3(via.x, 0, via.z), new THREE.Vector3(seat.x, 0, seat.z)]
        : [new THREE.Vector3(dest.x, 0, dest.z)];
    }
    // to / from the stand-up circle: out behind the chair, round the end of the bench
    if (mode === 'standup' || (p.prevMode === 'standup' && p.prevMode !== mode)) {
      const from = mode === 'standup' ? seat : p.pos;
      const side = from.x < (this.target?.x || 0) ? -this.benchEdge : this.benchEdge;
      const around = [new THREE.Vector3(side, 0, back.z), new THREE.Vector3(side, 0, this.frontZ + 0.6)];
      if (mode === 'standup') p.path = [new THREE.Vector3(back.x, 0, back.z), ...around, new THREE.Vector3(dest.x, 0, dest.z)];
      else if (mode === 'seat') p.path = [...around.reverse(), new THREE.Vector3(back.x, 0, back.z), new THREE.Vector3(seat.x, 0, seat.z)];
      else p.path = [...around.reverse(), new THREE.Vector3(dest.x, 0, dest.z)];
    }
    if (p.prevMode === 'seat' && mode === 'away') p.path = [new THREE.Vector3(dest.x, 0, dest.z)];
    if (p.prevMode === 'away' && mode === 'seat') p.path = [new THREE.Vector3(seat.x, 0, seat.z)];
    p.destRot = dest.rotY;
    p.arrived = false;
  }

  #applyStatus(p) {
    const m = p.member;
    const d = display(m, this.helps);
    const seat = this.seats[p.seatIndex];
    // laptop screen + lid
    if (seat) {
      const awake = STATUS[m.state]?.present;
      seat.screen.material.color.set(awake ? shade(m.color, 0.18) : '#2b2f38');
      seat.logo.material.color.set(awake ? shade(m.color, 0.25) : '#9aa1ad');
      seat.dndTarget = m.state === 'dnd' ? 1 : 0;
      if (seat.dndTarget && seat.dndName !== m.name) {           // board says whose desk it is
        seat.dndName = m.name;
        seat.dndBoard.map?.dispose();
        seat.dndBoard.map = dndTexture(m.name);
        seat.dndBoard.needsUpdate = true;
      }
      seat.lidTarget = m.state === 'afk' ? -1.3 : 0.22;
      seat.chairTarget = this.#mode(p) === 'seat' ? 0 : 0.35;
      seat.seatMat.color.copy(shade(m.color, 0.12));
      this.#updatePlant(seat, m, this.t);
    }
    p.av.setHeadphones(m.state === 'dnd' || !!m.inCall, !!m.inCall);
    const wantBadge = d.key === 'help' ? '❓' : d.key === 'call' ? '🎙️' : m.state === 'lunch' ? '🍜' : m.state === 'afk' ? '💤' : m.state === 'meeting' ? '📅' : '';
    if (wantBadge !== p.badgeText) {
      if (p.badge) this.scene.remove(p.badge);
      p.badge = wantBadge ? emojiSprite(wantBadge, 0.32) : null;
      if (p.badge) { p.badge.userData.born = this.t; p.badge.scale.setScalar(0.001); this.scene.add(p.badge); }
      p.badgeText = wantBadge;
    }
    // label
    p.label.style.setProperty('--c', d.color);
    p.label.querySelector('.nm').textContent = m.id === this.meId ? `${m.name} (you)` : m.name;
    p.label.querySelector('.st').textContent = d.label;
    p.label.classList.toggle('help', d.key === 'help');
    p.label.classList.toggle('me', m.id === this.meId);
    p.label.dataset.state = d.key;
  }

  // ---------- stand-up circle ----------
  #circle() {
    const n = this.standup?.order.length || 1;
    const r = Math.max(0.75, n * 0.3);
    return { x: this.target ? this.target.x : 0, z: this.frontZ + 0.7 + r, r };
  }
  #circleSlot(i, n) {
    const c = this.#circle();
    // spread around the circle, starting at the back (facing the camera) so faces are visible
    const a = Math.PI + (i / Math.max(n, 1)) * Math.PI * 2 + (n > 1 ? Math.PI / n : 0);
    const x = c.x + Math.sin(a) * c.r, z = c.z + Math.cos(a) * c.r;
    return { x, z, rotY: Math.atan2(c.x - x, c.z - z) };
  }
  #standupProps() {
    if (this.su3d) return this.su3d;
    const g = new THREE.Group();
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: '#7C8CF8', roughness: 0.9, transparent: true, opacity: 0.35 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = 0.006; rug.receiveShadow = true;
    g.add(rug);
    const spot = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.38, 40), new THREE.MeshBasicMaterial({ color: '#FFD166', transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    spot.rotation.x = -Math.PI / 2; spot.position.y = 0.012;
    this.scene.add(spot);
    const mic = emojiSprite('🎤', 0.34);
    this.scene.add(mic);
    g.visible = false; spot.visible = false; mic.visible = false;
    this.scene.add(g);
    return (this.su3d = { g, rug, spot, mic });
  }

  // ---------- pets & plants ----------
  #setPet(p, kind) {
    if (kind === 'none') kind = '';
    if (p.petKind === kind) return;
    if (p.pet) { this.scene.remove(p.pet.root); p.pet.dispose(); p.pet = null; }
    p.petKind = kind;
    if (!kind) return;
    p.pet = new Pet(kind);
    p.pet.root.scale.setScalar(1.5);
    p.petPos = null;   // placed on the first frame
    this.scene.add(p.pet.root);
    p.pet.hop(1.2);
  }

  #updatePlant(seat, m, t) {
    const stage = plantStage(m.plant || 0);
    if (seat.plantStage === stage && seat.plantOwner === m.id) return;
    const grew = seat.plantOwner === m.id && stage > seat.plantStage;
    if (seat.plant) { seat.group.remove(seat.plant); seat.plant.traverse(o => o.geometry?.dispose()); }
    seat.plant = buildPlant(stage);
    seat.plant.position.set(-0.42, DESK_TOP, 0.5);
    seat.plantScale = 1.7;
    seat.plant.rotation.y = 0.6;
    seat.group.add(seat.plant);
    seat.plantStage = stage;
    seat.plantOwner = m.id;
    seat.plantBorn = grew ? t : -10;
  }

  // a teammate's plant grew (they helped someone / got kudos): sparkle + a little pop
  grow(id, reason) {
    const p = this.people.get(id);
    if (!p) return;
    const seat = this.seats[p.seatIndex];
    if (seat) seat.plantBorn = this.t;
    this.react(id, reason === 'kudos' ? '👏' : '🌱');
    p.pet?.hop(1);
  }

  react(id, emoji) {
    const p = this.people.get(id);
    if (!p) return;
    const s = emojiSprite(emoji, 0.45);
    s.userData.born = this.t;
    s.userData.x = (Math.random() - 0.5) * 0.3;
    s.scale.setScalar(0.001);
    this.scene.add(s);
    p.fx.push(s);
    p.av.hop(0.8);
  }

  wave(id, seconds = 2.5) {
    const p = this.people.get(id);
    if (p) { p.waveUntil = this.t + seconds; p.av.hop(0.5); }
  }

  // ---------- frame ----------
  #frame() {
    // real elapsed time (capped) so walking keeps pace even on slow machines
    const realDt = Math.min(this.clock.getDelta(), 0.25);
    const dt = Math.min(realDt, 0.05);
    this.t += realDt;
    const t = this.t;

    // sky + lighting for my local time of day and weather
    const L = this.sky.update(t, dt);
    if (this.base) {
      this.sun.intensity = this.base.sun * L.sun + L.flash * 3;
      this.sun.color.set(L.sunColor);
      this.hemi.intensity = this.base.hemi * L.hemi + L.flash * 1.5;
    }

    // camera: gentle drift + user yaw
    const yaw = this.yaw + Math.sin(t * 0.1) * 0.03;
    const dist = this.camDist * this.zoom;
    const elev = this.elev || 0.62;
    if (this.target) {
      this.camera.position.set(
        this.target.x + Math.sin(yaw) * Math.cos(elev) * dist,
        this.target.y + Math.sin(elev) * dist,
        this.target.z + Math.cos(yaw) * Math.cos(elev) * dist,
      );
      this.camera.lookAt(this.target);
    }

    for (const s of this.seats || []) {
      if (s.dndTarget !== undefined) {           // pop the sign up / fold it away
        const was = s.dndShow;
        s.dndShow += (s.dndTarget - s.dndShow) * Math.min(1, dt * 7);
        if (s.dndTarget && was < 0.02) s.dndBorn = t;
        const k = s.dndTarget ? ease.outBack(Math.min(1, (t - (s.dndBorn ?? t)) / 0.45), 2.2) : s.dndShow;
        s.dnd.visible = s.dndShow > 0.01;
        s.dnd.scale.setScalar(Math.max(0.001, k));
      }
      if (s.plant) {
        const k = Math.min(1, (t - (s.plantBorn ?? -10)) / 0.7);
        s.plant.scale.setScalar((s.plantScale || 1) * (k < 1 ? Math.max(0.05, ease.outBack(k, 2.6)) : 1 + Math.sin(t * 1.3 + s.x) * 0.015));
      }
      if (s.lidTarget !== undefined) s.lid.rotation.x += (s.lidTarget - s.lid.rotation.x) * Math.min(1, dt * 4);
      if (s.chairTarget !== undefined) {
        s.chair.position.z += (-s.chairTarget - s.chair.position.z) * Math.min(1, dt * 3);
        s.chair.rotation.y += (s.chairTarget * 0.6 - s.chair.rotation.y) * Math.min(1, dt * 3);
      }
    }

    const tmp = new THREE.Vector3();
    for (const p of this.people.values()) {
      const av = p.av;
      const m = p.member;
      const mode = this.#mode(p);
      // BRB box: drops over the character once they reach the corner, lifts when they come back
      const box = this.#box(p);
      box.target = mode === 'brb' && !p.path.length ? 1 : 0;
      box.spring.target = box.target;
      box.spring.step(dt);
      const cover = THREE.MathUtils.clamp(box.spring.x, 0, 1.15);
      box.group.visible = cover > 0.01 || box.target > 0;
      box.group.position.set(p.pos.x, (1 - Math.min(cover, 1)) * 2.4, p.pos.z);
      box.group.rotation.y = (p.destRot ?? p.rotY);
      const squash = Math.max(0, cover - 1) * 1.5;
      box.group.scale.set(1 + squash, 1 - squash, 1 + squash);
      const hidden = cover > 0.97;
      const waitForBox = p.prevMode === 'brb' && mode !== 'brb' && box.spring.x > 0.2;

      // movement along path
      if (p.path.length && !waitForBox) {
        const next = p.path[0];
        tmp.copy(next).sub(p.pos);
        const dist = tmp.length();
        const speed = 2.2 * realDt;
        if (dist <= speed) { p.pos.copy(next); p.path.shift(); }
        else {
          tmp.normalize();
          p.pos.addScaledVector(tmp, speed);
          const want = Math.atan2(tmp.x, tmp.z);
          p.rotY = lerpAngle(p.rotY, want, dt * 10);
        }
        av.pose = 'walk';
        av.activity = 'idle';
        if (!p.path.length) p.arrived = true;
      } else {
        if (p.destRot !== undefined) p.rotY = lerpAngle(p.rotY, p.destRot, dt * 6);
        p.arrived = true;
        const d = display(m, this.helps);
        av.pose = mode === 'away' || mode === 'brb' || mode === 'standup' ? 'stand' : 'sit';
        const speaking = mode === 'standup' && this.standup.order[this.standup.turn] === m.id;
        if (p.waveUntil && t < p.waveUntil) av.activity = 'wave';
        else if (mode === 'standup') av.activity = speaking ? 'talk' : 'idle';
        else if (d.key === 'help') av.activity = 'raise';
        else if (mode === 'cafe') av.activity = 'eat';
        else if (mode === 'brb') av.activity = 'idle';
        else if (m.inCall) av.activity = 'talk';
        else if (m.state === 'meeting') av.activity = 'listen';
        else av.activity = 'type';
      }

      // Focus mode: power-up aura once they're settled at the desk (bursts on as they switch Focus on)
      const focusing = m.state === 'dnd' && mode === 'seat' && !p.path.length;
      if (focusing && !p.aura) { p.aura = new FocusAura({ size: 1.3 }); this.scene.add(p.aura.group); }
      if (p.aura) {
        if (focusing && !p.aura.target) p.av.hop?.(0.6);
        p.aura.set(focusing, t);
        p.aura.update(t, dt, p.pos, { seated: true, faceCamera: this.camera });
      }

      // away people fade out once they've "left"; returning people fade back in
      const targetOpacity = mode === 'away' ? 0 : 1;
      av.root.visible = !hidden && av.opacity > 0.02;
      av.setOpacity(av.opacity + (targetOpacity - av.opacity) * Math.min(1, dt * 2.5));
      if (hidden) av.root.visible = false;

      // seated avatars sit slightly into the chair (local -z)
      av.root.position.copy(p.pos);
      if (!p.path.length && mode === 'seat') {
        av.root.position.x += Math.sin(p.rotY) * -0.05;
        av.root.position.z += Math.cos(p.rotY) * -0.05;
      }
      av.root.rotation.y = p.rotY;
      av.update(t, dt);

      // pet: on the desk while its owner works, trotting after them otherwise
      if (p.pet) {
        const seat = this.seats[p.seatIndex];
        const onDesk = mode === 'seat' && !p.path.length && seat;
        let goal, goalRot;
        if (onDesk) {
          goal = seat.group.localToWorld(tmp.set(0.4, DESK_TOP, 0.58)).clone();
          goalRot = seat.rotY - 0.35;
        } else {
          const side = hidden ? 0.62 : 0.42;
          goal = new THREE.Vector3(p.pos.x + Math.cos(p.rotY) * side, 0, p.pos.z - Math.sin(p.rotY) * side - 0.1);
          goalRot = p.rotY;
        }
        if (!p.petPos) { p.petPos = goal.clone(); p.petRot = goalRot; }
        if (onDesk !== p.petOnDesk) { p.petOnDesk = onDesk; p.pet.hop(1.4); }
        const d = goal.clone().sub(p.petPos);
        const dist = d.length();
        const moving = dist > 0.04;
        if (moving) {
          p.petPos.addScaledVector(d.normalize(), Math.min(dist, 2.8 * realDt));
          const flat = Math.hypot(d.x, d.z);
          if (flat > 0.01) p.petRot = lerpAngle(p.petRot, Math.atan2(d.x, d.z), dt * 10);
        } else p.petRot = lerpAngle(p.petRot, goalRot, dt * 4);
        p.pet.root.position.copy(p.petPos);
        p.pet.root.rotation.y = p.petRot;
        p.pet.root.visible = mode !== 'away' || av.opacity > 0.3;
        p.pet.update(t, dt, {
          moving: moving && dist > 0.15,
          sleeping: onDesk && m.state === 'dnd',
          excited: this.helps.some(h => !h.claimedBy && h.from !== m.id),
        });
      }

      // floating badge
      const headY = hidden ? 1.6 : av.pose === 'sit' ? 1.78 : 1.95;
      if (p.badge) {
        const bob = Math.sin(t * 2 + p.av.phase) * 0.05;
        const base = mode === 'away' ? this.seats[p.seatIndex] : null;
        const bx = base ? base.x : av.root.position.x;
        const bz = base ? base.z : av.root.position.z;
        p.badge.position.set(bx + 0.28, headY - 0.05 + bob, bz);
        const k = Math.min(1, (t - (p.badge.userData.born ?? 0)) / 0.45);
        p.badge.scale.setScalar(p.badge.userData.size * Math.max(0.001, ease.outBack(k, 2.2)));
      }
      // reactions float up
      p.fx = p.fx.filter(s => {
        const age = t - s.userData.born;
        if (age > 2.2) { this.scene.remove(s); s.material.map.dispose(); s.material.dispose(); return false; }
        s.position.set(av.root.position.x + s.userData.x, headY + age * 0.6, av.root.position.z);
        s.material.opacity = 1 - Math.max(0, age - 1.4) / 0.8;
        s.scale.setScalar(s.userData.size * Math.max(0.001, ease.outBack(Math.min(1, age / 0.35), 2.4)));
        return true;
      });

      // label follows the head (or the empty chair)
      const anchor = mode === 'away' && this.seats[p.seatIndex]
        ? tmp.set(this.seats[p.seatIndex].x, 1.5, this.seats[p.seatIndex].z)
        : tmp.set(av.root.position.x, headY + 0.12, av.root.position.z);
      anchor.project(this.camera);
      const x = (anchor.x * 0.5 + 0.5) * this.width;
      const y = (-anchor.y * 0.5 + 0.5) * this.height;
      p.lx = x; p.ly = y; p.lz = anchor.z;
    }

    // stand-up: rug in the middle, a spotlight + mic over whoever's talking
    if (this.standup || this.su3d) {
      const P = this.#standupProps();
      const on = !!this.standup;
      P.g.visible = on;
      const speaker = on && this.people.get(this.standup.order[this.standup.turn]);
      const there = speaker && !speaker.path.length && speaker.mode === 'standup';
      P.spot.visible = P.mic.visible = !!there;
      if (on) {
        const c = this.#circle();
        P.g.position.set(c.x, 0, c.z);
        P.rug.scale.setScalar(c.r + 0.35);
      }
      if (there) {
        const pp = speaker.av.root.position;
        P.spot.position.set(pp.x, 0.012, pp.z);
        P.spot.material.opacity = 0.65 + Math.sin(t * 4) * 0.25;
        P.mic.position.set(pp.x + 0.3, 2.1 + Math.sin(t * 3) * 0.04, pp.z);
      }
    }

    this.#placeLabels();
    this.renderer.render(this.scene, this.camera);
  }

  // keep name tags from piling on top of each other
  #placeLabels() {
    const list = [...this.people.values()].filter(p => p.lx !== undefined);
    for (const p of list) { p.lw = p.label.offsetWidth || 90; p.ly2 = p.ly; }
    list.sort((a, b) => a.ly - b.ly);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const overlapX = Math.abs(a.lx - b.lx) < (a.lw + b.lw) / 2 + 4;
        const dy = b.ly2 - a.ly2;
        if (overlapX && Math.abs(dy) < 24) {
          const push = (24 - Math.abs(dy)) / 2;
          if (dy >= 0) { a.ly2 -= push; b.ly2 += push; } else { a.ly2 += push; b.ly2 -= push; }
        }
      }
    }
    for (const p of list) {
      p.lx = Math.max(p.lw / 2 + 6, Math.min(this.width - p.lw / 2 - 6, p.lx));
      p.ly2 = Math.max(34, p.ly2);
      p.label.style.transform = `translate(${p.lx.toFixed(1)}px, ${p.ly2.toFixed(1)}px) translate(-50%, -100%)`;
      p.label.style.zIndex = String(1000 - Math.round(p.lz * 1000));
    }
  }

  // ---------- input ----------
  #bindInput() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', e => { drag = { x: e.clientX, yaw: this.yaw, moved: false }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      this.yaw = Math.max(-0.6, Math.min(0.6, drag.yaw - dx * 0.005));
    });
    el.addEventListener('pointerup', e => {
      if (drag && !drag.moved) this.#pick(e);
      drag = null;
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoom = Math.max(0.55, Math.min(1.4, this.zoom * (1 + e.deltaY * 0.001)));
    }, { passive: false });
    el.addEventListener('dblclick', () => { this.yaw = 0; this.zoom = 1; });
  }

  #pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const roots = [...this.people.values()].filter(p => p.av.root.visible).map(p => p.av.root);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    if (!hit) return this.onSelect?.(null);
    let o = hit.object;
    while (o && !o.userData.personId) o = o.parent;
    if (o) {
      const p = this.people.get(o.userData.personId);
      this.onSelect?.(o.userData.personId, p.label.getBoundingClientRect());
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.laidOut) this.#frameCamera();
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
  }
}

function lerpAngle(a, b, k) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}
