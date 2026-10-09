// Mixamo characters for Deskmate.
// Loads rigged characters (FBX or GLB) and Mixamo animation clips listed in
// models/manifest.json, and drives them with the same API as the built-in
// avatar: { root, pose, activity, update(), setHeadphones(), setOpacity(), hop(), dispose() }.
//
// Animations are split into a lower-body and an upper-body layer so we can,
// for example, wave or raise a hand while sitting.
import { THREE, Spring } from './toon.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { FBXLoader } from './vendor/FBXLoader.js';
import * as SkeletonUtils from './vendor/SkeletonUtils.js';

const BASE = new URL('../models/', import.meta.url).href;
const TARGET_HEIGHT = 1.62;
const SEAT_Y = 0.47;                   // chair seat height in the desk scene            // metres, matches the desk/chair scale
const FADE = 0.35;

// clip roles → files are described in models/manifest.json
//   { "characters": [{ "id": "ava", "name": "Ava", "file": "char-ava.fbx", "tint": ["Top"] }],
//     "animations": { "typing": "anim-typing.fbx", "sitIdle": "anim-sit-idle.fbx", ... } }
let manifestP = null;
export function loadManifest() {
  manifestP ??= fetch(BASE + 'manifest.json')
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  return manifestP;
}

const fileCache = new Map();
function loadFile(file, base = BASE) {
  const url = new URL(file, base).href;
  if (!fileCache.has(url)) {
    const p = file.toLowerCase().endsWith('.fbx')
      ? new FBXLoader().loadAsync(url).then(obj => ({ scene: obj, animations: obj.animations || [] }))
      : new GLTFLoader().loadAsync(url).then(g => ({ scene: g.scene, animations: g.animations || [] }));
    fileCache.set(url, p);
  }
  return fileCache.get(url);
}

const LOWER = /hips|upleg|leg|foot|toe/i;
const boneOf = (track) => track.name.split('.')[0];

// Make a clip loop in place: drop horizontal root motion on the hips.
function inPlace(clip) {
  for (const tr of clip.tracks) {
    if (/hips\.position$/i.test(tr.name)) {
      const v = tr.values;
      const x0 = v[0], z0 = v[2];
      for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
    }
  }
  return clip;
}
function split(clip, name) {
  const lower = new THREE.AnimationClip(name + ':lower', clip.duration, clip.tracks.filter(t => LOWER.test(boneOf(t))));
  const upper = new THREE.AnimationClip(name + ':upper', clip.duration, clip.tracks.filter(t => !LOWER.test(boneOf(t))));
  return { lower, upper };
}

const clipCache = new Map();
async function loadClips(manifest) {
  const key = JSON.stringify(manifest.animations || {});
  if (!clipCache.has(key)) {
    clipCache.set(key, (async () => {
      const out = {};
      for (const [role, file] of Object.entries(manifest.animations || {})) {
        try {
          const { animations } = await loadFile(file, manifest.base || BASE);
          const clip = animations[0];
          if (!clip) continue;
          out[role] = split(inPlace(clip.clone()), role);
        } catch (e) { console.warn('[deskmate] animation failed', file, e); }
      }
      return out;
    })());
  }
  return clipCache.get(key);
}

// what to play for each pose/activity (first available wins)
const ALIASES = { idle: ['idle', 'Idle'], walk: ['walk', 'Walk'], sitIdle: ['sitIdle', 'idle', 'Idle'], typing: ['typing', 'idle', 'Idle'] };
function wanted(pose, act) {
  if (pose === 'walk') return { lower: ['walk', 'idle'], upper: ['walk', 'idle'] };
  if (pose === 'sit') {
    const lower = act === 'type' ? ['typing', 'sitIdle'] : ['sitIdle', 'typing'];
    const upper = {
      type: ['typing', 'sitIdle'], talk: ['sitTalk', 'sitIdle'], eat: ['eat', 'sitIdle'],
      raise: ['raise', 'sitIdle'], wave: ['wave', 'sitIdle'], listen: ['sitIdle'],
    }[act] || ['sitIdle', 'typing'];
    return { lower, upper };
  }
  const upper = { raise: ['raise', 'idle'], wave: ['wave', 'idle'] }[act] || ['idle'];
  return { lower: ['idle'], upper };
}

function hashPick(seed, n) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

/**
 * Create a Mixamo-driven teammate. Returns immediately; the model streams in.
 * opts: { model (character id), seed (for a stable default pick), color (tint), onReady }
 */
export function createMixamoAvatar(manifest, { model, seed = '', color = '#8EB8FF', onReady } = {}) {
  const root = new THREE.Group();     // positioned/rotated by the desk scene
  const wrap = new THREE.Group();     // squash & stretch + normalisation
  root.add(wrap);
  const chars = manifest.characters || [];
  const def = chars.find(c => c.id === model) || chars[hashPick(seed, Math.max(1, chars.length))];

  let modelRef = null, baseY = 0;
  const allBones = {};
  // canonical (Mixamo) bone names → this model's names, e.g. { "LeftArm": "UpperArm.L" }
  const boneMap = def?.bones || {};
  // loaders strip characters like '.' and ':' from names, so compare loosely
  const norm = (n) => String(n).replace(/^mixamorig:?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const bones = new Proxy({}, { get: (_, k) => allBones[norm(boneMap[k] || k)] });
  let faceMorphs = [];
  const W = { sit: new Spring(0, 120, 18), type: new Spring(0, 140, 18), wave: new Spring(0, 160, 16), raise: new Spring(0, 160, 16) };
  let mixer = null, clips = null, layers = { lower: null, upper: null }, current = { lower: '', upper: '' };
  let head = null, rightHand = null;
  const props = { phones: new THREE.Group(), mic: new THREE.Group(), bowl: new THREE.Group() };
  const squash = new Spring(0, 320, 9);
  const materials = [];
  let phonesOn = [false, false];

  const api = {
    root, pose: 'sit', activity: 'type', phase: Math.random() * 10, opacity: 1, ready: false, character: def?.id,
    setHeadphones(on, withMic = false) { phonesOn = [on, withMic]; props.phones.visible = on; props.mic.visible = on && withMic; },
    hop(strength = 1) { squash.kick(-2.2 * strength); },
    setOpacity(o) {
      if (Math.abs(o - api.opacity) < 0.001) return;
      api.opacity = o;
      for (const m of materials) {
        m.userData.baseOpacity ??= m.opacity;
        m.transparent = o < 0.999 || m.userData.baseOpacity < 1;
        m.opacity = m.userData.baseOpacity * o;
        m.depthWrite = o > 0.6;
      }
      root.visible = o > 0.02;
    },
    update(t, dt) {
      dt = Math.min(dt, 0.1);
      squash.target = 0;
      squash.step(dt);
      const sq = THREE.MathUtils.clamp(squash.x, -0.18, 0.18);
      wrap.scale.set(1 + sq * 0.35, 1 - sq, 1 + sq * 0.35);
      if (!mixer) return;
      play();
      mixer.update(dt);
      poseLayer(t, dt);
      props.bowl.visible = api.activity === 'eat' && api.pose !== 'walk';
    },
    dispose() {
      mixer?.stopAllAction();
      root.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); } });
      for (const m of materials) m.dispose();
    },
  };

  const roleMap = def?.clips || {};
  const once = new Set(def?.once || []);
  function pick(list) {
    for (const n of list) {
      if (roleMap[n] && clips[roleMap[n]]) return roleMap[n];
      for (const a of ALIASES[n] || [n]) if (clips[a]) return a;
    }
    return Object.keys(clips).find(n => !/tpose/i.test(n)) || Object.keys(clips)[0];
  }
  function play() {
    const w = wanted(api.pose, api.activity);
    for (const part of ['lower', 'upper']) {
      const name = pick(w[part]);
      if (!name || current[part] === name) continue;
      const next = mixer.clipAction(clips[name][part]);
      next.reset().setEffectiveWeight(1);
      if (once.has(name)) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
      next.fadeIn(FADE).play();
      // keep the two halves of the same clip in step
      const other = part === 'lower' ? 'upper' : 'lower';
      if (current[other] === name && layers[other]) next.time = layers[other].time;
      if (layers[part]) layers[part].fadeOut(FADE);
      layers[part] = next;
      current[part] = name;
      if (api.activity === 'raise' || api.activity === 'wave') squash.kick(2.2);
    }
  }

  (async () => {
    if (!def) return;
    try {
      const [{ scene, animations: own }, loadedClips] = await Promise.all([loadFile(def.file, manifest.base || BASE), loadClips(manifest)]);
      const model = SkeletonUtils.clone(scene);
      // per-person materials (tint the top in their colour)
      const tintRe = Array.isArray(def.tint) ? (def.tint.length ? new RegExp(def.tint.join('|'), 'i') : null) : /top|shirt|hoodie|sweater|jacket|tee|torso/i;
      const tint = new THREE.Color(def.color || color);
      model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.morphTargetDictionary) faceMorphs.push(o);
        o.frustumCulled = false;  // skinned bounds don't follow the animation
        o.material = [].concat(o.material).map(m => {
          const c = m.clone();
          if (tintRe && (tintRe.test(m.name || '') || tintRe.test(o.name || ''))) {
            // tint, keeping texture detail: blend the colour towards white so it isn't muddy
            c.color = c.map ? tint.clone().lerp(new THREE.Color('#ffffff'), 0.35) : tint.clone();
          }
          if ('roughness' in c) c.roughness = Math.max(c.roughness ?? 0.6, 0.55);
          materials.push(c);
          return c;
        });
        if (o.material.length === 1) o.material = o.material[0];
      });
      // normalise: feet on the floor, consistent height, facing +z
      // measure the skinned mesh precisely (applies bone transforms per vertex)
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model, true);
      const h = (box.max.y - box.min.y) || 1;
      const s = (def.height || TARGET_HEIGHT) / h;
      model.scale.multiplyScalar(s);
      model.position.y -= box.min.y * s;
      if (def.rotateY) model.rotation.y = def.rotateY;
      wrap.add(model);
      modelRef = model; baseY = model.position.y;

      model.traverse(o => {
        if (!o.isBone) return;
        if (!head && /head$/i.test(o.name) && o.isBone) head = o;
        if (!rightHand && /righthand$/i.test(o.name)) rightHand = o;
        allBones[norm(o.name)] ??= o;
      });
      buildProps();
      mixer = new THREE.AnimationMixer(model);
      clips = loadedClips;
      // clips baked into the character file (GLB/FBX with animations) fill any gaps
      clips = { ...clips };
      for (const c of own || []) if (!clips[c.name]) clips[c.name] = split(inPlace(c.clone()), c.name);
      api.ready = true;
      onReady?.(api);
    } catch (e) {
      console.warn('[deskmate] character failed to load', def?.file, e);
      api.failed = true;
      onReady?.(api);
    }
  })();

  // ---------------------------------------------------------------- procedural pose layer
  // The clips only cover idle / walk. Sitting, typing, waving and raising a hand are
  // posed on top by aiming bones at target directions (in the character's own frame:
  // +z forward, +y up, +x = character's left), blended in with springs.
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _rootQ = new THREE.Quaternion();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
  function aim(boneName, childName, dir, w) {
    const bone = bones[boneName], child = bones[childName];
    if (!bone || !child || w < 0.001) return;
    bone.getWorldPosition(_a); child.getWorldPosition(_b);
    const cur = _b.sub(_a).normalize();
    _d.copy(dir).normalize().applyQuaternion(_rootQ);
    _q.setFromUnitVectors(cur, _d);                 // world-space correction
    if (w < 1) _q.slerp(_q2.identity(), 1 - w);
    bone.getWorldQuaternion(_q2);
    _q2.premultiply(_q);                            // new world rotation
    bone.parent.getWorldQuaternion(_q);
    bone.quaternion.copy(_q.invert().multiply(_q2));
    bone.updateMatrixWorld(true);
  }
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const hasSitClip = () => !!(clips && (roleMap.sitIdle && clips[roleMap.sitIdle] || clips.sitIdle));
  function poseLayer(t, dt) {
    if (!modelRef) return;
    const p = t + api.phase;
    const act = api.activity, sitting = api.pose === 'sit';
    W.sit.target = sitting ? 1 : 0;
    W.type.target = sitting && (act === 'type' || act === 'listen' || act === 'talk' || act === 'eat') ? 1 : 0;
    const hasClip = (role) => !!(roleMap[role] && clips[roleMap[role]] || clips[role]);
    W.wave.target = act === 'wave' && !hasClip('wave') ? 1 : 0;
    W.raise.target = act === 'raise' && !hasClip('raise') ? 1 : 0;
    // facial expression morphs (if the model has them)
    for (const m of faceMorphs) {
      const d = m.morphTargetDictionary, inf = m.morphTargetInfluences;
      if (d.Surprised !== undefined) inf[d.Surprised] += ((act === 'raise' ? 0.6 : 0) - inf[d.Surprised]) * Math.min(1, dt * 6);
    }
    for (const k in W) W[k].step(dt);
    const ws = THREE.MathUtils.clamp(W.sit.x, 0, 1), wt = THREE.MathUtils.clamp(W.type.x, 0, 1);
    const ww = THREE.MathUtils.clamp(W.wave.x, 0, 1), wr = THREE.MathUtils.clamp(W.raise.x, 0, 1);
    root.getWorldQuaternion(_rootQ);
    modelRef.updateMatrixWorld(true);

    // sit: lower the hips onto the seat, thighs forward, shins down
    if (ws > 0.001 && bones.Hips) {
      modelRef.position.y = baseY;
      modelRef.updateMatrixWorld(true);
      const hipsY = bones.Hips.getWorldPosition(_a).y - root.getWorldPosition(_b).y;
      modelRef.position.y = baseY + (SEAT_Y - hipsY) * ws;
      modelRef.updateMatrixWorld(true);
      for (const s of (hasSitClip() ? [] : ['Left', 'Right'])) {
        const sx = s === 'Left' ? 1 : -1;
        aim(s + 'UpLeg', s + 'Leg', V(sx * 0.12, -0.08, 1), ws);
        aim(s + 'Leg', s + 'Foot', V(sx * 0.04, -1, 0.06), ws);
        aim(s + 'Foot', s + 'ToeBase', V(0, -0.35, 1), ws);
      }
      aim('Spine', 'Spine1', V(0, 1, 0.3 * wt), ws);
    } else {
      modelRef.position.y = baseY;
    }

    // typing: forearms forward onto the keyboard, little finger taps
    if (wt > 0.001) {
      const burst = Math.sin(p * 0.55) + Math.sin(p * 1.3) * 0.5 > -0.6 ? 1 : 0;
      for (const s of ['Left', 'Right']) {
        const sx = s === 'Left' ? 1 : -1;
        const tap = burst * Math.max(0, Math.sin(p * 17 + (sx > 0 ? 0 : 2.1))) ** 3 * 0.12;
        aim(s + 'Arm', s + 'ForeArm', V(sx * 0.2, -0.5, 0.85), wt);
        aim(s + 'ForeArm', s + 'Hand', V(-sx * 0.3, 0.05 + tap, 1), wt);
        aim(s + 'Hand', s + 'HandMiddle1', V(-sx * 0.15, -0.35 - tap * 2, 1), wt);
      }
      aim('Neck', 'Head', V(0, 1, 0.22), wt);
    }

    // wave (right hand): arm out and up, forearm swinging
    if (ww > 0.001) {
      const sw = Math.sin(p * 9) * 0.45;
      aim('RightArm', 'RightForeArm', V(-0.5, 0.85, 0.2), ww);
      aim('RightForeArm', 'RightHand', V(-0.15 - sw, 1, 0.25), ww);
      aim('RightHand', 'RightHandMiddle1', V(-0.1 - sw * 1.2, 1, 0.2), ww);
    }
    // raise hand: straight up, a little wiggle
    if (wr > 0.001) {
      const wig = Math.sin(p * 6) * 0.12;
      aim('RightArm', 'RightForeArm', V(-0.3 + wig, 1, 0.15), wr);
      aim('RightForeArm', 'RightHand', V(-0.05 + wig, 1, 0.05), wr);
      aim('RightHand', 'RightHandMiddle1', V(0, 1, 0.15), wr);
    }
  }

  // simple props sized in metres; parented to bones and un-scaled from bone space
  function buildProps() {
    const dark = new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
    materials.push(dark, accent);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 16, 64, Math.PI), dark);
    band.position.y = 0.11;
    props.phones.add(band);
    for (const sx of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 48), dark);
      cup.rotation.z = Math.PI / 2; cup.position.set(sx * 0.1, 0.09, 0);
      props.phones.add(cup);
    }
    const boom = new THREE.Mesh(new THREE.CapsuleGeometry(0.005, 0.11, 8, 16), dark);
    boom.rotation.x = Math.PI / 2.3; boom.position.set(0.09, 0.05, 0.06);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.013, 24, 16), accent);
    tip.position.set(0.075, 0.03, 0.12);
    props.mic.add(boom, tip);
    props.phones.add(props.mic);
    props.phones.visible = phonesOn[0];
    props.mic.visible = phonesOn[0] && phonesOn[1];
    const bowlM = new THREE.MeshStandardMaterial({ color: '#ef7d6d', roughness: 0.3 });
    const noodle = new THREE.MeshStandardMaterial({ color: '#F4C152', roughness: 0.6 });
    materials.push(bowlM, noodle);
    props.bowl.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), bowlM));
    const n = new THREE.Mesh(new THREE.CircleGeometry(0.056, 40), noodle);
    n.rotation.x = -Math.PI / 2; n.position.y = -0.008;
    props.bowl.add(n);
    props.bowl.visible = false;
    attach(props.phones, head);
    attach(props.bowl, rightHand, new THREE.Vector3(0, 0.08, 0.04));
  }
  function attach(obj, bone, offset) {
    if (!bone) return;
    wrap.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    bone.getWorldScale(ws);
    const rs = new THREE.Vector3();
    root.getWorldScale(rs);
    obj.scale.setScalar(rs.x / ws.x);
    if (offset) obj.position.copy(offset).multiplyScalar(rs.x / ws.x);
    bone.add(obj);
  }

  return api;
}
