// The shared virtual desk: everyone on an arc-shaped bench facing you,
// with a café corner where people walk off to when they go for lunch.
import { THREE, createAvatar, emojiSprite, shade, addSoftLights, configureRenderer } from '../lib/avatar.js';
import { ease } from '../lib/toon.js';
import { makeCharacter } from '../lib/characters.js';

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

const lookKey = (m) => JSON.stringify([m.color, m.avatar || {}]);

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
      this.seats.push({ ...tr, group: g, chair: g.userData.chair, screen: g.userData.screen, lid: g.userData.lid, seatMat: g.userData.seatMat, logo: g.userData.logo });
    }
    // café sits behind the bench on the right, visible over everyone's heads
    let backZ = 0, maxX = 0;
    for (let i = 0; i < n; i++) { const t = this.seatTransform(i, n); backZ = Math.min(backZ, t.z); maxX = Math.max(maxX, t.x); }
    this.cafe.group.position.set(maxX * 0.55 + 0.7, 0, backZ - 1.9);
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
    g.userData = { chair, screen, lid, seatMat, logo };
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
    if (m.state === 'afk' || m.state === 'brb') return 'away';
    return 'seat';
  }

  #assignCafe() {
    let i = 0;
    for (const p of this.people.values()) {
      if (this.#mode(p) === 'cafe') p.cafeSlot = i++ % this.cafe.slots.length;
    }
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
    const key = mode + ':' + (mode === 'cafe' ? p.cafeSlot : p.seatIndex) + ':' + this.laidOut;
    if (p.routeKey === key) return;
    const firstTime = !p.routeKey;
    p.prevMode = p.mode;
    p.mode = mode;
    p.routeKey = key;
    const seat = this.#seatPoint(p);
    const back = { x: seat.x - Math.sin(seat.rotY) * 0.9, z: seat.z - Math.cos(seat.rotY) * 0.9 };
    let dest;
    if (mode === 'cafe') dest = this.#worldCafe(p.cafeSlot);
    else if (mode === 'away') dest = { x: seat.x - Math.sin(seat.rotY) * 1.3, z: seat.z - Math.cos(seat.rotY) * 1.3, rotY: seat.rotY + Math.PI };
    else dest = seat;
    if (firstTime || p.isNew) {
      p.pos.set(dest.x, 0, dest.z); p.rotY = dest.rotY; p.path = []; p.isNew = false;
      p.arrived = true;
      return;
    }
    // leave via the space behind the chair, then on to the destination
    p.path = [new THREE.Vector3(back.x, 0, back.z), new THREE.Vector3(dest.x, 0, dest.z)];
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
      seat.lidTarget = m.state === 'afk' ? -1.3 : 0.22;
      seat.chairTarget = this.#mode(p) === 'seat' ? 0 : 0.35;
      seat.seatMat.color.copy(shade(m.color, 0.12));
    }
    p.av.setHeadphones(m.state === 'dnd' || !!m.inCall, !!m.inCall);
    const wantBadge = d.key === 'help' ? '❓' : d.key === 'call' ? '🎙️' : m.state === 'lunch' ? '🍜' : m.state === 'afk' ? '💤' : m.state === 'brb' ? '☕' : m.state === 'dnd' ? '🔕' : m.state === 'meeting' ? '📅' : '';
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
      // movement along path
      if (p.path.length) {
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
        av.pose = mode === 'away' ? 'stand' : 'sit';
        if (p.waveUntil && t < p.waveUntil) av.activity = 'wave';
        else if (d.key === 'help') av.activity = 'raise';
        else if (mode === 'cafe') av.activity = 'eat';
        else if (m.inCall) av.activity = 'talk';
        else if (m.state === 'meeting') av.activity = 'listen';
        else av.activity = 'type';
      }

      // away people fade out once they've "left"; returning people fade back in
      const targetOpacity = mode === 'away' ? 0 : 1;
      av.setOpacity(av.opacity + (targetOpacity - av.opacity) * Math.min(1, dt * 2.5));

      // seated avatars sit slightly into the chair (local -z)
      av.root.position.copy(p.pos);
      if (!p.path.length && mode === 'seat') {
        av.root.position.x += Math.sin(p.rotY) * -0.05;
        av.root.position.z += Math.cos(p.rotY) * -0.05;
      }
      av.root.rotation.y = p.rotY;
      av.update(t, dt);

      // floating badge
      const headY = av.pose === 'sit' ? 1.78 : 1.95;
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
