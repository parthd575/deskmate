// Desk plant: grows a stage each time you help someone or get kudos.
// Stages: seed sprout → seedling → little plant → leafy → bushy with a bud → first flowers →
// in full bloom → a small potted tree.
import { THREE } from './avatar.js';

export const PLANT_STAGES = [0, 1, 3, 6, 10, 16, 25, 40];   // points needed for each stage
export const PLANT_NAMES = ['Sprout', 'Seedling', 'Little plant', 'Leafy', 'Bushy', 'First flowers', 'Full bloom', 'Little tree'];

export function plantStage(points = 0) {
  let s = 0;
  for (let i = 0; i < PLANT_STAGES.length; i++) if (points >= PLANT_STAGES[i]) s = i;
  return s;
}
export function nextStageAt(points = 0) {
  const s = plantStage(points);
  return s < PLANT_STAGES.length - 1 ? PLANT_STAGES[s + 1] : null;
}

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
let M = null;
const mats = () => (M ||= {
  pot: mat('#E07A5F'), rim: mat('#C8664D'), soil: mat('#5B4334'), stem: mat('#4F9D52'),
  leaf: mat('#5CBF6A'), leaf2: mat('#3E9C55'), petal: mat('#FF8FB1'), petal2: mat('#FFD166'), core: mat('#FFE08A'), trunk: mat('#8A5A3B'),
});

function leaf(group, m, x, y, z, ry, size = 1, tilt = 0.9) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.03 * size, 14, 10), m);
  l.scale.set(0.55, 0.18, 1.25);
  l.position.z = 0.032 * size;
  l.rotation.x = -tilt * 0.4;
  l.castShadow = true;
  g.add(l);
  group.add(g);
  return g;
}

function flower(group, x, y, z, petalMat, size = 1) {
  const M = mats();
  const f = new THREE.Group();
  f.position.set(x, y, z);
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.014 * size, 10, 8), petalMat);
    const a = (i / 5) * Math.PI * 2;
    p.position.set(Math.cos(a) * 0.016 * size, 0, Math.sin(a) * 0.016 * size);
    p.scale.set(1, 0.45, 1);
    f.add(p);
  }
  f.add(new THREE.Mesh(new THREE.SphereGeometry(0.009 * size, 10, 8), M.core));
  group.add(f);
  return f;
}

export function buildPlant(stage) {
  const M = mats();
  const g = new THREE.Group();
  const big = stage >= 7;
  const potR = big ? 0.075 : 0.055, potH = big ? 0.09 : 0.07;
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(potR, potR * 0.78, potH, 20), M.pot);
  pot.position.y = potH / 2; pot.castShadow = true;
  g.add(pot);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(potR * 1.08, potR * 1.08, 0.014, 20), M.rim);
  rim.position.y = potH; g.add(rim);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(potR * 0.95, potR * 0.95, 0.008, 20), M.soil);
  soil.position.y = potH + 0.004; g.add(soil);
  const top = potH + 0.008;

  if (big) {
    // a small potted tree: trunk + round canopy dotted with blossoms
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.16, 8), M.trunk);
    trunk.position.y = top + 0.08; g.add(trunk);
    for (const [x, y, z, r, m] of [[0, 0.24, 0, 0.075, M.leaf], [-0.05, 0.21, 0.02, 0.055, M.leaf2], [0.05, 0.22, -0.02, 0.055, M.leaf2], [0.01, 0.29, 0.01, 0.05, M.leaf]]) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m);
      c.position.set(x, top + y - 0.02, z); c.castShadow = true; g.add(c);
    }
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4;
      flower(g, Math.cos(a) * 0.07, top + 0.22 + (i % 3) * 0.03, Math.sin(a) * 0.07, i % 2 ? M.petal : M.petal2, 0.8);
    }
    g.userData.height = top + 0.33;
    return g;
  }

  const stemH = [0.03, 0.06, 0.09, 0.12, 0.15, 0.17, 0.2][stage];
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.004 + stage * 0.0008, 0.006 + stage * 0.001, stemH, 8), M.stem);
  stem.position.y = top + stemH / 2; g.add(stem);
  const leaves = [2, 2, 4, 6, 8, 9, 11][stage];
  for (let i = 0; i < leaves; i++) {
    const k = leaves > 1 ? i / (leaves - 1) : 0;
    const y = top + stemH * (0.35 + k * 0.6);
    const size = (0.8 + stage * 0.12) * (1.1 - k * 0.35);
    leaf(g, i % 2 ? M.leaf : M.leaf2, 0, y, 0, i * 2.39, size, 0.9 + k * 0.4);
  }
  if (stage === 4) {
    const bud = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), M.petal);
    bud.scale.set(0.8, 1.3, 0.8); bud.position.y = top + stemH + 0.012; g.add(bud);
  }
  if (stage >= 5) {
    flower(g, 0, top + stemH + 0.01, 0, M.petal, 1.1);
    flower(g, 0.04, top + stemH * 0.75, 0.015, M.petal2, 0.85);
    if (stage >= 6) {
      flower(g, -0.04, top + stemH * 0.8, -0.01, M.petal2, 0.9);
      flower(g, 0.01, top + stemH * 0.6, -0.04, M.petal, 0.8);
    }
  }
  g.userData.height = top + stemH + 0.03;
  return g;
}
