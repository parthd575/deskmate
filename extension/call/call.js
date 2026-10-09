// Audio huddle: small mesh WebRTC call (up to ~6 people), signalled over the Deskmate server.
import { initials, display } from '../lib/status.js';

const params = new URLSearchParams(location.search);
const callId = params.get('id');
const ringUser = params.get('ring');
const $ = (s) => document.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bridge = globalThis.deskBridge || {
  callConfig: () => chrome.runtime.sendMessage({ type: 'call:config' }),
  closeWindow: () => window.close(),
};

const peers = new Map(); // peerId -> { pc, user, audio, tile, analyser, muted, makingOffer }
globalThis.__huddle = { peers }; // debugging aid
let ws, cfg, localStream, iceServers = [], startedAt = null, hadPeers = false, mutedSelf = false;
let audioCtx;
const meTile = { tile: null, analyser: null };

const PC_CONFIG = () => ({ iceServers, bundlePolicy: 'max-bundle' });

async function main() {
  cfg = await bridge.callConfig();
  if (!cfg?.settings?.server) return fail('Deskmate isn’t set up yet.');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    return fail('Microphone blocked. Allow mic access for Deskmate and try again.');
  }
  audioCtx = new AudioContext();
  document.addEventListener('pointerdown', () => audioCtx.resume(), { once: true });
  addMyTile();
  if (ringUser) addRingingTile(ringUser);
  connect();
  requestAnimationFrame(meter);
  setInterval(tick, 1000);
}

function connect() {
  const s = cfg.settings;
  ws = new WebSocket(s.server);
  ws.onopen = () => ws.send(JSON.stringify({
    type: 'hello', team: s.team, role: 'call',
    user: { id: s.userId, name: s.name, email: s.email, color: s.color, avatar: s.avatar, tz: s.tz },
  }));
  ws.onmessage = (ev) => onSignal(JSON.parse(ev.data));
  ws.onclose = () => { if (!leaving) setTimeout(connect, 1500); };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

async function onSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      iceServers = msg.iceServers || [];
      cfg.members = msg.members;
      // after a reconnect our old socket is gone from the call: start the peers fresh
      for (const [id, p] of peers) { p.pc.close(); p.audio?.remove(); p.tile?.remove(); peers.delete(id); }
      send({ type: 'call:join', callId });
      break;
    case 'call:peers':
      iceServers = msg.iceServers || iceServers;
      setSub(msg.peers.length ? 'Connecting…' : ringUser ? 'Ringing…' : 'Waiting for others…');
      // the newcomer makes the offers → no glare
      for (const p of msg.peers) await createPeer(p.peerId, p.user, true);
      break;
    case 'call:peer-joined':
      await createPeer(msg.peerId, msg.user, false);
      break;
    case 'call:peer-left':
      removePeer(msg.peerId);
      break;
    case 'call:mute': {
      const p = peers.get(msg.peerId);
      if (p) { p.muted = msg.muted; p.tile.classList.toggle('muted', msg.muted); }
      break;
    }
    case 'call:end':
      if (msg.callId === callId) { note(`${msg.byName} ended the call.`); setTimeout(leave, 900); }
      break;
    case 'call:declined':
      if (msg.callId === callId) {
        $('#ring')?.remove();
        note(`${msg.byName} can’t talk right now.`);
        if (!peers.size) setTimeout(leave, 2500);
      }
      break;
    case 'call:signal':
      await handleSignal(msg.from, msg.data);
      break;
    case 'error':
      if (msg.error === 'call_full') fail('This huddle is full.');
      break;
  }
}

async function createPeer(peerId, user, initiator) {
  if (peers.has(peerId)) {
    const existing = peers.get(peerId);
    if (!['closed', 'failed'].includes(existing.pc.connectionState)) return existing;
    removePeer(peerId);
  }
  const pc = new RTCPeerConnection(PC_CONFIG());
  const p = { pc, user, muted: false, makingOffer: false };
  peers.set(peerId, p);
  for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'call:signal', to: peerId, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (!p.audio) {
      p.audio = new Audio();
      p.audio.autoplay = true;
      document.body.appendChild(p.audio);
    }
    p.audio.srcObject = stream;
    p.audio.play().catch(() => note('Click anywhere to enable audio'));
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      p.analyser = audioCtx.createAnalyser();
      p.analyser.fftSize = 512;
      src.connect(p.analyser);
    } catch {}
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') { $('#ring')?.remove(); hadPeers = true; startedAt ??= Date.now(); tick(); setSub(subText()); p.tile.querySelector('.st').textContent = ''; }
    if (st === 'failed') { p.tile.querySelector('.st').textContent = 'Reconnecting…'; pc.restartIce?.(); }
    if (st === 'disconnected') p.tile.querySelector('.st').textContent = 'Weak connection';
  };
  addPeerTile(peerId, p);
  if (initiator) {
    p.makingOffer = true;
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'call:signal', to: peerId, data: { sdp: pc.localDescription } });
    p.makingOffer = false;
  }
  if (mutedSelf) send({ type: 'call:mute', muted: true });
  return p;
}

async function handleSignal(from, data) {
  let p = peers.get(from);
  if (!p) p = await createPeer(from, { name: 'Teammate', color: '#888' }, false);
  const pc = p.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'call:signal', to: from, data: { sdp: pc.localDescription } });
      }
      for (const c of p.pending || []) await pc.addIceCandidate(c).catch(() => {});
      p.pending = [];
    } else if (data.candidate) {
      if (!pc.remoteDescription) (p.pending ||= []).push(data.candidate);
      else await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  } catch (e) { console.warn('signal error', e); }
}

function removePeer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  p.pc.close();
  p.audio?.remove();
  p.tile.remove();
  peers.delete(peerId);
  setSub(subText());
  if (!peers.size && hadPeers) {
    note(`${p.user.name} left the call.`);
    setTimeout(() => { if (!peers.size) leave(); }, 4000);
  }
}

// ---------------------------------------------------------------- UI
function tileHTML(user, extra = '', label = user.name) {
  return `<div class="face" style="--c:${esc(user.color || '#6c8cff')}">${esc(initials(user.name))}
    <span class="mic"><svg viewBox="0 0 24 24"><path d="m2 2 20 20M9 9v2a3 3 0 0 0 5 2M15 9V5a3 3 0 0 0-6 0"/></svg></span></div>
    <div class="nm">${esc(label)}</div><div class="st">${extra}</div>`;
}
function addMyTile() {
  const t = document.createElement('div');
  t.className = 'tile me';
  t.innerHTML = tileHTML(cfg.settings, '', `${cfg.settings.name} (you)`);
  $('#tiles').appendChild(t);
  meTile.tile = t;
  const src = audioCtx.createMediaStreamSource(localStream);
  meTile.analyser = audioCtx.createAnalyser();
  meTile.analyser.fftSize = 512;
  src.connect(meTile.analyser);
}
function addRingingTile(userId) {
  const m = cfg.members?.find(x => x.id === userId) || { name: 'Teammate', color: '#94a3b8' };
  const t = document.createElement('div');
  t.className = 'tile ringing';
  t.id = 'ring';
  t.innerHTML = tileHTML(m, 'Ringing…');
  $('#tiles').appendChild(t);
  $('#title').textContent = `Calling ${m.name.split(' ')[0]}`;
  setTimeout(() => { if ($('#ring') && !peers.size) { $('#ring .st').textContent = 'No answer'; note('No answer yet. Try a wave, or ask the team for help instead.'); } }, 45000);
}
function addPeerTile(peerId, p) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = tileHTML(p.user, 'Connecting…');
  $('#tiles').appendChild(t);
  p.tile = t;
  $('#title').textContent = 'Huddle';
}

function meter() {
  const level = (an) => {
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 6);
  };
  if (meTile.tile) meTile.tile.querySelector('.face').style.setProperty('--level', mutedSelf ? 0 : level(meTile.analyser).toFixed(2));
  for (const p of peers.values()) p.tile?.querySelector('.face').style.setProperty('--level', level(p.analyser).toFixed(2));
  requestAnimationFrame(meter);
}

function tick() {
  if (!startedAt) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('#clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  document.title = `Huddle · ${peers.size + 1} · ${$('#clock').textContent}`;
}
function subText() {
  const n = peers.size;
  return n ? `${n + 1} people · audio` : 'Waiting for others…';
}
function setSub(t) { $('#sub').textContent = t; }
function note(t) { const n = $('#note'); n.textContent = t; n.hidden = false; }
function fail(t) { $('#title').textContent = 'Can’t start the call'; setSub(''); note(t); }

// ---------------------------------------------------------------- controls
function toggleMute() {
  mutedSelf = !mutedSelf;
  localStream?.getAudioTracks().forEach(t => { t.enabled = !mutedSelf; });
  $('#mute').classList.toggle('active', mutedSelf);
  meTile.tile?.classList.toggle('muted', mutedSelf);
  send({ type: 'call:mute', muted: mutedSelf });
}
$('#mute').onclick = toggleMute;
document.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey) toggleMute(); });

let leaving = false;
function leave() {
  if (leaving) return;
  leaving = true;
  send({ type: 'call:leave' });
  for (const p of peers.values()) p.pc.close();
  localStream?.getTracks().forEach(t => t.stop());
  try { ws?.close(); } catch {}
  setTimeout(() => bridge.closeWindow(), 120);
}
$('#leave').onclick = leave;
window.addEventListener('beforeunload', () => { send({ type: 'call:leave' }); });

$('#invite').onclick = async () => {
  const menu = $('#inviteMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const fresh = await bridge.callConfig();
  const inCall = new Set([...peers.values()].map(p => p.user.id).concat(cfg.settings.userId));
  const list = (fresh.members || []).filter(m => !inCall.has(m.id));
  menu.innerHTML = list.length ? list.map(m => {
    const d = display(m, []);
    return `<button data-id="${esc(m.id)}"><div class="av" style="--c:${esc(m.color)}">${esc(initials(m.name))}<span class="ring" style="--s:${d.color}"></span></div><div><b>${esc(m.name)}</b><div class="muted small">${d.emoji} ${esc(d.label)}</div></div></button>`;
  }).join('') : '<div class="empty">Everyone online is already here.</div>';
  menu.hidden = false;
  menu.querySelectorAll('button').forEach(b => b.onclick = () => {
    send({ type: 'call:invite', to: b.dataset.id, callId });
    menu.hidden = true;
    note(`Invited ${list.find(m => m.id === b.dataset.id)?.name}.`);
  });
};

main();
