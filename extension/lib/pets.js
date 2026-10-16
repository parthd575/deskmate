// Desk pets: small, original low-poly companions built from simple shapes (no model files).
// A pet naps or sits on its owner's desk, trots after them when they walk somewhere, perks up
// when someone needs help, and curls up asleep while its owner is in Focus.
import { THREE } from './avatar.js';

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0, ...o });

const LOOKS = {
  cat:   { body: '#F2A65A', belly: '#FFE3C2', dark: '#C9773A', ear: 'pointy', tail: 'long', nose: '#F28B9B' },
  dog:   { body: '#C98B5B', belly: '#F6E2CC', dark: '#7A4E31', ear: 'floppy', tail: 'short', nose: '#2b2b2b' },
  bunny: { body: '#F4F1EE', belly: '#FFFFFF', dark: '#D9CFC7', ear: 'long', tail: 'puff', nose: '#F28B9B' },
  chick: { body: '#FFD34E', belly: '#FFE89A', dark: '#F2B705', ear: 'none', tail: 'none', nose: '#FF9F1C', bird: true },
  fox:   { body: '#E8743B', belly: '#FFF4E8', dark: '#5B3A29', ear: 'pointy', tail: 'bushy', nose: '#2b2b2b' },
};

export const PET_KINDS = Object.keys(LOOKS);

export class Pet {
  constructor(kind) {
    const L = LOOKS[kind] || LOOKS.cat;
    this.kind = kind;
    this.root = new THREE.Group();
    this.body = new THREE.Group();       // squashes / hops
    this.root.add(this.body);
    this.phase = Math.random() * 10;
    this.hopT = -10;
    this.sleep = 0;                       // 0 awake … 1 curled up
    const M = { body: mat(L.body), belly: mat(L.belly), dark: mat(L.dark), nose: mat(L.nose), eye: mat('#1d1f27', { roughness: 0.3 }), shine: new THREE.MeshBasicMaterial({ color: '#ffffff' }) };
    const add = (geo, m, parent = this.body, [x, y, z] = [0, 0, 0]) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const S = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);

    if (L.bird) {
      // round little chick
      const b = add(S(0.1, 24, 18), M.body, this.body, [0, 0.1, 0]); b.scale.set(1, 0.95, 1.05);
      add(S(0.07, 20, 14), M.belly, this.body, [0, 0.08, 0.05]).scale.set(1, 0.9, 0.6);
      this.head = new THREE.Group(); this.head.position.set(0, 0.17, 0.02); this.body.add(this.head);
      add(S(0.075, 22, 16), M.body, this.head);
      const beak = add(new THREE.ConeGeometry(0.022, 0.05, 12), M.nose, this.head, [0, -0.005, 0.08]); beak.rotation.x = Math.PI / 2;
      for (const sx of [-1, 1]) {
        const w = add(S(0.05, 14, 10), M.dark, this.body, [sx * 0.095, 0.11, -0.005]); w.scale.set(0.4, 0.8, 1);
        add(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6), M.nose, this.body, [sx * 0.035, 0.02, 0.01]);
      }
      add(S(0.02, 10, 8), M.dark, this.head, [0, 0.075, 0]).scale.set(0.6, 1.3, 0.6); // tuft
    } else {
      // four-legged pet: body, legs, head, ears, tail
      const b = add(S(0.1, 24, 18), M.body, this.body, [0, 0.11, -0.01]); b.scale.set(0.9, 0.85, 1.25);
      add(S(0.07, 20, 14), M.belly, this.body, [0, 0.085, 0.04]).scale.set(0.9, 0.8, 1.1);
      this.legs = [];
      for (const [x, z] of [[-0.05, 0.07], [0.05, 0.07], [-0.05, -0.08], [0.05, -0.08]]) {
        this.legs.push(add(new THREE.CylinderGeometry(0.022, 0.02, 0.07, 10), M.body, this.body, [x, 0.035, z]));
        add(S(0.024, 10, 8), M.belly, this.body, [x, 0.008, z + 0.006]).scale.set(1, 0.6, 1.2);
      }
      this.head = new THREE.Group(); this.head.position.set(0, 0.2, 0.1); this.body.add(this.head);
      add(S(0.085, 24, 18), M.body, this.head).scale.set(1.05, 0.95, 0.95);
      const snout = add(S(0.042, 16, 12), M.belly, this.head, [0, -0.025, 0.065]); snout.scale.set(1.1, 0.8, 0.9);
      add(S(0.014, 10, 8), M.nose, this.head, [0, -0.012, 0.102]);
      if (L.ear === 'pointy') for (const sx of [-1, 1]) {
        const e = add(new THREE.ConeGeometry(0.035, 0.07, 4), M.body, this.head, [sx * 0.05, 0.08, -0.005]); e.rotation.z = -sx * 0.25;
        const i = add(new THREE.ConeGeometry(0.02, 0.045, 4), M.belly, this.head, [sx * 0.05, 0.075, 0.008]); i.rotation.z = -sx * 0.25;
      }
      if (L.ear === 'floppy') for (const sx of [-1, 1]) {
        const e = add(S(0.038, 14, 10), M.dark, this.head, [sx * 0.08, 0.005, -0.005]); e.scale.set(0.45, 1.25, 0.8); e.rotation.z = sx * 0.3;
      }
      if (L.ear === 'long') for (const sx of [-1, 1]) {
        const e = add(S(0.03, 14, 10), M.body, this.head, [sx * 0.035, 0.12, -0.01]); e.scale.set(0.7, 2.6, 0.5); e.rotation.z = -sx * 0.15;
        add(S(0.018, 10, 8), M.nose, this.head, [sx * 0.035, 0.12, 0.004]).scale.set(0.6, 2.3, 0.3);
      }
      // tail
      this.tail = new THREE.Group(); this.tail.position.set(0, 0.13, -0.13); this.body.add(this.tail);
      if (L.tail === 'long') { const t = add(new THREE.CylinderGeometry(0.014, 0.02, 0.16, 8), M.body, this.tail, [0, 0.07, -0.02]); t.rotation.x = -0.5; }
      if (L.tail === 'short') { const t = add(new THREE.CylinderGeometry(0.016, 0.022, 0.07, 8), M.body, this.tail, [0, 0.03, -0.01]); t.rotation.x = -0.7; }
      if (L.tail === 'puff') add(S(0.035, 14, 10), M.belly, this.tail, [0, 0, -0.01]);
      if (L.tail === 'bushy') {
        const t = add(S(0.05, 16, 12), M.body, this.tail, [0, 0.04, -0.05]); t.scale.set(0.8, 0.8, 1.9); t.rotation.x = 0.5;
        add(S(0.03, 12, 10), M.belly, this.tail, [0, 0.07, -0.13]);
      }
    }
    // eyes (closed = squashed flat)
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const e = add(S(0.016, 12, 10), M.eye, this.head, [sx * 0.035, 0.018, L.bird ? 0.062 : 0.072]);
      add(S(0.005, 8, 6), M.shine, e, [0.005, 0.006, 0.013]);
      this.eyes.push(e);
    }
    // little "z" for naps
    this.zzz = null;
  }

  hop(strength = 1) { this.hopT = performance.now() / 1000; this.hopK = strength; }

  // moving: walking somewhere · sleeping: owner is focusing · excited: someone needs help
  update(t, dt, { moving = false, sleeping = false, excited = false } = {}) {
    this.sleep += ((sleeping && !moving ? 1 : 0) - this.sleep) * Math.min(1, dt * 2.5);
    const s = this.sleep;
    const breathe = 1 + Math.sin(t * (2.2 - s) + this.phase) * (0.025 + s * 0.02);
    // hop: walking bounces, a perk-up hop when excited
    let hop = 0;
    if (moving) hop = Math.abs(Math.sin(t * 11 + this.phase)) * 0.05;
    const since = performance.now() / 1000 - this.hopT;
    if (since < 0.5) hop += Math.sin((since / 0.5) * Math.PI) * 0.09 * (this.hopK || 1);
    if (excited && !moving && s < 0.5 && Math.sin(t * 3 + this.phase) > 0.97) this.hop(0.7);
    this.body.position.y = hop;
    this.body.scale.set(1 + s * 0.12, breathe * (1 - s * 0.35), 1 + s * 0.05);
    // head: looks around, tilts curiously, droops when asleep
    if (this.head) {
      this.head.rotation.y = (1 - s) * Math.sin(t * 0.7 + this.phase) * 0.45;
      this.head.rotation.z = (1 - s) * Math.sin(t * 0.43 + this.phase * 2) * 0.18 + (excited ? Math.sin(t * 6) * 0.1 : 0);
      this.head.rotation.x = s * 0.45 + (excited ? -0.25 : 0);
    }
    // blink, or eyes shut while asleep
    const blink = s > 0.5 ? 0.12 : ((t + this.phase) % 3.6 < 0.13 ? 0.15 : 1);
    for (const e of this.eyes) e.scale.y = blink;
    if (this.tail) this.tail.rotation.y = Math.sin(t * (excited ? 14 : moving ? 10 : 4) + this.phase) * (0.5 - s * 0.4);
    if (this.legs) this.legs.forEach((l, i) => { l.rotation.x = moving ? Math.sin(t * 11 + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI : 0)) * 0.6 : 0; l.visible = s < 0.6; });
  }

  dispose() {
    this.root.traverse(o => { o.geometry?.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose(); });
  }
}
