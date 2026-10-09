// Pop-up bubble with a live 3D teammate. Used in-page (iframe) and by the Mac app.
import { THREE, addSoftLights, configureRenderer } from '../lib/avatar.js';
import { makeCharacter, usingModels } from '../lib/characters.js';

const data = JSON.parse(decodeURIComponent(location.hash.slice(1) || '%7B%7D'));
const $ = (s) => document.querySelector(s);
const bridge = globalThis.deskBridge || {
  action: (name, args) => chrome.runtime.sendMessage({ type: 'action', name, args }),
  closeWindow: () => parent.postMessage({ type: 'deskmate:close', id: data.id }, '*'),
};
const first = (data.name || 'A teammate').split(' ')[0];

const KINDS = {
  help: {
    title: `${data.name} needs help`,
    sub: data.topic || 'Tap Join to hop on an audio call',
    acts: [['primary', 'Join', () => { bridge.action('help:claim', { id: data.id }); close(); }], ['ghost', 'Not now', () => close()]],
    pose: 'raise', ttl: 90, pulse: true,
  },
  invite: {
    title: `${data.name} needs help`,
    sub: 'Tap Join to hop on an audio call',
    acts: [['primary', 'Join', () => { bridge.action('call:accept', { callId: data.id, from: data.from, url: data.url }); close(); }], ['ghost', 'Not now', () => { bridge.action('call:decline', { callId: data.id, from: data.from }); close(); }]],
    pose: 'raise', ttl: 45, pulse: true,
  },
  wave: {
    title: `${data.name} waved ${data.emoji || '👋'}`,
    sub: 'Say hi back?',
    acts: [['primary', 'Wave back', () => { bridge.action('wave', { to: data.from || data.fromId, emoji: '👋' }); close(); }]],
    pose: 'wave', ttl: 8,
  },
};
const k = KINDS[data.kind] || KINDS.wave;
if (data.kind === 'wave') k.acts = data.from ? k.acts : [];

const el = $('#bubble');
el.classList.add('kind-' + (data.kind || 'wave'));
const ROUND = data.kind === 'help' || data.kind === 'invite';
if (ROUND) el.classList.add('round');
if (data.urgency === 'high') el.classList.add('urgent');
if (k.pulse) el.classList.add('pulse');
$('#title').textContent = k.title;
$('#sub').textContent = k.sub;
const acts = $('#acts');
for (const [cls, label, fn] of k.acts) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label; b.onclick = fn;
  acts.appendChild(b);
}
$('#close').onclick = () => close();

// countdown bar
const timer = $('#timer');
timer.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: k.ttl * 1000, easing: 'linear', fill: 'forwards' });
let ttl = setTimeout(() => close(), k.ttl * 1000);
el.addEventListener('mouseenter', () => { clearTimeout(ttl); timer.getAnimations().forEach(a => a.pause()); });
el.addEventListener('mouseleave', () => { ttl = setTimeout(() => close(), 6000); });

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  el.classList.add('out');
  setTimeout(() => bridge.closeWindow(), 260);
}

// live updates (someone else claimed it, request withdrawn)
const onMsg = (msg) => {
  if (!msg || msg.id !== data.id) return;
  if (msg.type === 'bubble:close') close();
  if (msg.type === 'bubble:update') {
    if (msg.byMe) return close();
    el.classList.add('done');
    el.classList.remove('pulse');
    $('#title').textContent = `${msg.claimedName} is on it ✓`;
    $('#sub').textContent = `${first} is getting help.`;
    acts.innerHTML = '';
    clearTimeout(ttl);
    ttl = setTimeout(() => close(), 3500);
  }
};
if (globalThis.deskBridge?.onBubble) globalThis.deskBridge.onBubble(onMsg);
else chrome.runtime.onMessage.addListener(onMsg);

// ---- 3D teammate ----
const stage = $('#stage');
try {
const W = ROUND ? 112 : 92, H = ROUND ? 112 : 120;
const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
r.setPixelRatio(Math.min(devicePixelRatio, 2));
r.setSize(W, H);
configureRenderer(r);
stage.appendChild(r.domElement);
const scene = new THREE.Scene();
addSoftLights(scene, { shadows: false });
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 20);
if (ROUND) {   // head-and-shoulders portrait with the raised hand in frame
  cam.position.set(0.1, usingModels ? 1.0 : 1.5, usingModels ? 2.1 : 2.6);
  cam.lookAt(0, usingModels ? 0.95 : 1.45, 0);
} else {
  cam.position.set(0.12, usingModels ? 1.05 : 1.6, usingModels ? 2.3 : 2.95);
  cam.lookAt(0, usingModels ? 0.82 : 1.42, 0);
}
const av = makeCharacter({ id: data.from || data.name, color: data.color || '#6C8CFF', avatar: data.avatar || {} });
av.pose = 'stand';
av.activity = k.pose;
av.root.rotation.y = ROUND ? -0.1 : -0.25;
scene.add(av.root);
const clock = new THREE.Clock();
let t = 0;
let hopped = false;
(function loop() {
  if (closing && t > 0) { r.render(scene, cam); }
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  if (!hopped && t > 0.25) { av.hop(1.3); hopped = true; } // pop in with a hop
  av.root.rotation.y = (ROUND ? -0.1 : -0.25) + Math.sin(t * 0.8) * (ROUND ? 0.1 : 0.15);
  av.update(t, dt);
  r.render(scene, cam);
  requestAnimationFrame(loop);
})();
} catch (e) {
  // no WebGL: show initials instead of the 3D teammate
  stage.innerHTML = `<div style="position:absolute;inset:22px 14px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:20px;background:${data.color || '#6C8CFF'}">${(data.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2)}</div>`;
}
