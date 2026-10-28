// Deskmate call: our own WebRTC room (audio, camera and screen sharing), signalled over the
// Deskmate server. The room id is the help request / call id, so everyone who joins that call
// lands in the same room. Small mesh (up to ~6 people): every pair has one peer connection.
//
// Each peer connection carries exactly three tracks, set up once:
//   0 = microphone, 1 = camera, 2 = screen share
// Turning the camera or screen on/off just swaps the track (replaceTrack), so there is no
// renegotiation; a small "call:state" message tells the others what to show.
import { initials, display } from '../lib/status.js';
import { socketUrl } from '../lib/client.js';

const params = new URLSearchParams(location.search);
const callId = params.get('id');
const ringUser = params.get('ring');
const $ = (s) => document.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bridge = globalThis.deskBridge || {
  callConfig: () => chrome.runtime.sendMessage({ type: 'call:config' }),
  closeWindow: () => window.close(),
};

const peers = new Map();   // peerId -> { pc, user, state, tile, audio, cam, screen, analyser, pending }
const me = { tile: null, analyser: null, state: { muted: false, cam: false, screen: false, hand: false } };
let ws, cfg, iceServers = [], audioCtx, hadPeers = false, leaving = false;
let mic = null, camTrack = null, screenTrack = null;
globalThis.__call = { peers, me };   // debugging / tests

const T_MIC = 0, T_CAM = 1, T_SCREEN = 2;
const PC_CONFIG = () => ({ iceServers, bundlePolicy: 'max-bundle' });

// ---------------------------------------------------------------- start
async function main() {
  cfg = await bridge.callConfig();
  if (!cfg?.settings?.server) return note('Deskmate isn’t set up yet.', 0);
  audioCtx = new AudioContext();
  document.addEventListener('pointerdown', () => audioCtx.resume(), { once: true });
  // microphone + camera; carry on with whatever we're allowed
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: { width: 1280, height: 720 } });
    mic = s.getAudioTracks()[0];
    camTrack = s.getVideoTracks()[0] || null;
  } catch {
    try { mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0]; }
    catch { note('Microphone and camera are blocked. Allow them for Deskmate to talk.', 0); }
  }
  me.state.cam = !!camTrack;
  me.state.muted = !mic;
  addMyTile();
  if (ringUser) addRingingTile(ringUser);
  syncButtons();
  layout();
  connect();
  requestAnimationFrame(meter);
  clock();
  setInterval(clock, 10000);
}

function connect() {
  const s = cfg.settings;
  ws = new WebSocket(socketUrl(s.server, s.team));
  ws.onopen = () => ws.send(JSON.stringify({
    type: 'hello', team: s.team, role: 'call',
    user: { id: s.userId, name: s.name, email: s.email, color: s.color, avatar: s.avatar, tz: s.tz },
  }));
  ws.onmessage = (ev) => onSignal(JSON.parse(ev.data));
  ws.onclose = () => { if (!leaving) setTimeout(connect, 1500); };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const shareState = () => send({ type: 'call:state', state: me.state });

// ---------------------------------------------------------------- signalling
async function onSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      iceServers = msg.iceServers || [];
      cfg.members = msg.members;
      // after a reconnect our old socket is gone from the call: start the peers fresh
      for (const id of [...peers.keys()]) removePeer(id, true);
      send({ type: 'call:join', callId });
      break;
    case 'call:peers':
      iceServers = msg.iceServers || iceServers;
      shareState();
      // the newcomer makes the offers → no glare
      for (const p of msg.peers) await createPeer(p.peerId, p.user, true, p.state);
      updateTitle();
      break;
    case 'call:peer-joined':
      await createPeer(msg.peerId, msg.user, false);
      shareState();
      break;
    case 'call:peer-left':
      removePeer(msg.peerId);
      break;
    case 'call:mute': {
      const p = peers.get(msg.peerId);
      if (p) { p.state.muted = msg.muted; paint(p); }
      break;
    }
    case 'call:state': {
      const p = peers.get(msg.peerId);
      if (p) { p.state = msg.state; paint(p); layout(); }
      break;
    }
    case 'call:react': {
      const who = msg.peerId === mySocket ? 'You' : peers.get(msg.peerId)?.user.name.split(' ')[0] || '';
      floatReaction(msg.emoji, who);
      break;
    }
    case 'call:end':
      if (msg.callId === callId) { note(`${msg.byName} ended the call.`); setTimeout(leave, 1200); }
      break;
    case 'call:declined':
      if (msg.callId === callId) {
        $('#ring')?.remove();
        note(`${msg.byName} can’t talk right now.`);
        layout();
        if (!peers.size) setTimeout(leave, 2500);
      }
      break;
    case 'call:signal':
      await handleSignal(msg.from, msg.data);
      break;
    case 'error':
      if (msg.error === 'call_full') note('This call is full.', 0);
      break;
  }
  if (msg.type === 'welcome') mySocket = msg.socketId;
}
let mySocket = null;

const localTrack = (i) => (i === T_MIC ? mic : i === T_CAM ? camTrack : screenTrack) || null;

async function createPeer(peerId, user, initiator, state) {
  if (peers.has(peerId)) {
    const existing = peers.get(peerId);
    if (!['closed', 'failed'].includes(existing.pc.connectionState)) return existing;
    removePeer(peerId, true);
  }
  const pc = new RTCPeerConnection(PC_CONFIG());
  const p = { pc, user, state: state || { muted: false, cam: false, screen: false, hand: false }, pending: [] };
  peers.set(peerId, p);
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'call:signal', to: peerId, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => onRemoteTrack(p, e);
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') { $('#ring')?.remove(); hadPeers = true; setStatus(p, ''); layout(); }
    if (st === 'failed') { setStatus(p, 'Reconnecting…'); pc.restartIce?.(); }
    if (st === 'disconnected') setStatus(p, 'Weak connection');
  };
  addPeerTile(peerId, p);
  if (initiator) {
    // mic, camera, screen: always three, in this order
    for (const kind of ['audio', 'video', 'video']) pc.addTransceiver(kind, { direction: 'sendrecv' });
    await attachLocal(p);
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'call:signal', to: peerId, data: { sdp: pc.localDescription } });
  }
  layout();
  return p;
}

// put my current tracks on a peer's three transceivers
async function attachLocal(p) {
  const tr = p.pc.getTransceivers();
  for (let i = 0; i < 3; i++) {
    if (!tr[i]) continue;
    tr[i].direction = 'sendrecv';
    await tr[i].sender.replaceTrack(localTrack(i)).catch(() => {});
  }
}
async function setTrackEverywhere(i, track) {
  for (const p of peers.values()) {
    const t = p.pc.getTransceivers()[i];
    if (t) await t.sender.replaceTrack(track).catch(() => {});
  }
}

function onRemoteTrack(p, e) {
  const i = p.pc.getTransceivers().indexOf(e.transceiver);
  const stream = new MediaStream([e.track]);
  if (i === T_MIC) {
    p.audio ||= Object.assign(document.createElement('audio'), { autoplay: true });
    document.body.appendChild(p.audio);
    p.audio.srcObject = stream;
    p.audio.play().catch(() => note('Click anywhere to hear the others'));
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      p.analyser = audioCtx.createAnalyser();
      p.analyser.fftSize = 512;
      src.connect(p.analyser);
    } catch {}
  } else if (i === T_CAM) {
    p.cam.srcObject = stream;
  } else if (i === T_SCREEN) {
    p.screenStream = stream;
    layout();
  }
}

async function handleSignal(from, data) {
  let p = peers.get(from);
  if (!p) p = await createPeer(from, { name: 'Teammate', color: '#888' }, false);
  const pc = p.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await attachLocal(p);
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'call:signal', to: from, data: { sdp: pc.localDescription } });
      }
      for (const c of p.pending) await pc.addIceCandidate(c).catch(() => {});
      p.pending = [];
    } else if (data.candidate) {
      if (!pc.remoteDescription) p.pending.push(data.candidate);
      else await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  } catch (e) { console.warn('signal error', e); }
}

function removePeer(peerId, quiet = false) {
  const p = peers.get(peerId);
  if (!p) return;
  p.pc.close();
  p.audio?.remove();
  p.tile.remove();
  peers.delete(peerId);
  layout();
  updateTitle();
  if (!quiet && !peers.size && hadPeers) {
    note(`${p.user.name} left the call.`);
    setTimeout(() => { if (!peers.size) leave(); }, 4000);
  }
}

// ---------------------------------------------------------------- tiles
function makeTile(user, cls = '') {
  const t = document.createElement('div');
  t.className = 'tile ' + cls;
  t.innerHTML = `
    <video class="cam" autoplay playsinline muted></video>
    <div class="avatar" style="--c:${esc(user.color || '#6c8cff')}">${esc(initials(user.name))}</div>
    <div class="status"></div>
    <div class="badges">
      <span class="badge hand" title="Hand raised">✋</span>
      <span class="badge mic" title="Muted"><svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .7-.2 1.4-.4 2l1.2 1.2c.6-.9.9-2 .9-3.2Zm-4 .2V5a3 3 0 0 0-5.9-.8L15 10.1v1.1ZM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.5 2.6l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 3.1-1.2l3.6 3.6 1.3-1.3L4.3 3Z"/></svg></span>
    </div>
    <div class="name"></div>`;
  t.querySelector('.name').textContent = user.name;
  $('#grid').appendChild(t);
  return t;
}
function addMyTile() {
  me.tile = makeTile(cfg.settings, 'me');
  me.tile.querySelector('.name').textContent = `${cfg.settings.name} (You)`;
  me.cam = me.tile.querySelector('video.cam');
  if (camTrack) me.cam.srcObject = new MediaStream([camTrack]);
  if (mic) {
    const src = audioCtx.createMediaStreamSource(new MediaStream([mic]));
    me.analyser = audioCtx.createAnalyser();
    me.analyser.fftSize = 512;
    src.connect(me.analyser);
  }
  paint(me);
}
function addRingingTile(userId) {
  const m = cfg.members?.find(x => x.id === userId) || { name: 'Teammate', color: '#94a3b8' };
  const t = makeTile(m, 'ringing');
  t.id = 'ring';
  t.querySelector('.status').textContent = 'Calling…';
  $('#title').textContent = `Calling ${m.name.split(' ')[0]}`;
  setTimeout(() => {
    if ($('#ring') && !peers.size) { $('#ring .status').textContent = 'No answer'; note('No answer yet. Try a wave, or ask the team for help.'); }
  }, 45000);
}
function addPeerTile(peerId, p) {
  p.tile = makeTile(p.user);
  p.cam = p.tile.querySelector('video.cam');
  setStatus(p, 'Connecting…');
  paint(p);
}
function setStatus(p, text) { const s = p.tile?.querySelector('.status'); if (s) s.textContent = text; }
function paint(x) {
  const t = x.tile;
  if (!t) return;
  t.classList.toggle('muted', !!x.state.muted);
  t.classList.toggle('cam-on', !!x.state.cam);
  t.classList.toggle('hand', !!x.state.hand);
}

// grid size, or presenter layout when someone shares their screen
function layout() {
  const presenter = me.state.screen ? me : [...peers.values()].find(p => p.state.screen && p.screenStream);
  const room = $('#room');
  room.classList.toggle('presenting', !!presenter);
  $('#stage').hidden = !presenter;
  if (presenter) {
    const v = $('#stageVideo');
    const stream = presenter === me ? new MediaStream([screenTrack]) : presenter.screenStream;
    if (v.srcObject !== stream && (presenter !== me || v.dataset.mine !== screenTrack?.id)) { v.srcObject = stream; v.dataset.mine = presenter === me ? screenTrack?.id : ''; }
    $('#stageLabel').textContent = presenter === me ? 'You are presenting' : `${presenter.user.name} is presenting`;
  } else $('#stageVideo').srcObject = null;
  const n = $('#grid').children.length;
  $('#grid').style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : 3);
  $('#count').textContent = String(peers.size + 1);
  updateTitle();
  renderPanel();
}

function updateTitle() {
  if ($('#ring') && !peers.size) return;
  const names = [...peers.values()].map(p => p.user.name.split(' ')[0]);
  $('#title').textContent = names.length ? `Call with ${names.join(', ')}` : 'Deskmate call';
  document.title = `${$('#title').textContent} · Deskmate`;
}

// speaking indicator
function meter() {
  const level = (an) => {
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 6);
  };
  const show = (x, lv) => {
    if (!x.tile) return;
    x.tile.style.setProperty('--level', lv.toFixed(2));
    x.tile.classList.toggle('speaking', lv > 0.12);
  };
  show(me, me.state.muted ? 0 : level(me.analyser));
  for (const p of peers.values()) show(p, p.state.muted ? 0 : level(p.analyser));
  requestAnimationFrame(meter);
}

function clock() {
  $('#clock').textContent = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(new Date());
}
let noteTimer;
function note(t, ms = 4000) {
  const n = $('#note');
  n.textContent = t;
  n.hidden = false;
  clearTimeout(noteTimer);
  if (ms) noteTimer = setTimeout(() => { n.hidden = true; }, ms);
}

// ---------------------------------------------------------------- controls
function syncButtons() {
  $('#mic').classList.toggle('off', me.state.muted);
  $('#mic').title = me.state.muted ? 'Turn on microphone (⌘D)' : 'Turn off microphone (⌘D)';
  $('#cam').classList.toggle('off', !me.state.cam);
  $('#cam').title = me.state.cam ? 'Turn off camera (⌘E)' : 'Turn on camera (⌘E)';
  $('#share').classList.toggle('active', me.state.screen);
  $('#share').title = me.state.screen ? 'Stop presenting' : 'Present your screen';
  $('#hand').classList.toggle('active', me.state.hand);
  paint(me);
}

function toggleMic() {
  if (!mic) return note('Allow microphone access for Deskmate to talk.');
  me.state.muted = !me.state.muted;
  mic.enabled = !me.state.muted;
  syncButtons();
  shareState();
}

async function toggleCam() {
  if (me.state.cam) {
    camTrack?.stop();            // camera light off
    camTrack = null;
    me.state.cam = false;
    await setTrackEverywhere(T_CAM, null);
  } else {
    try {
      camTrack = (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })).getVideoTracks()[0];
    } catch { return note('Camera is blocked or in use by another app.'); }
    me.cam.srcObject = new MediaStream([camTrack]);
    me.state.cam = true;
    await setTrackEverywhere(T_CAM, camTrack);
  }
  syncButtons();
  shareState();
}

async function toggleShare() {
  if (me.state.screen) return stopShare();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    screenTrack = s.getVideoTracks()[0];
  } catch { return; }            // picker cancelled
  screenTrack.contentHint = 'detail';
  screenTrack.onended = stopShare;   // "Stop sharing" in the browser's own bar
  me.state.screen = true;
  await setTrackEverywhere(T_SCREEN, screenTrack);
  syncButtons();
  shareState();
  layout();
}
async function stopShare() {
  if (!me.state.screen) return;
  screenTrack?.stop();
  screenTrack = null;
  me.state.screen = false;
  await setTrackEverywhere(T_SCREEN, null);
  syncButtons();
  shareState();
  layout();
}

function toggleHand() {
  me.state.hand = !me.state.hand;
  syncButtons();
  shareState();
}

// reactions
const EMOJI = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎'];
$('#tray').innerHTML = EMOJI.map(e => `<button data-e="${e}">${e}</button>`).join('');
$('#tray').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) send({ type: 'call:react', emoji: b.dataset.e });
};
$('#react').onclick = () => { $('#tray').hidden = !$('#tray').hidden; $('#react').classList.toggle('active', !$('#tray').hidden); };
function floatReaction(emoji, who) {
  const r = document.createElement('div');
  r.className = 'r';
  r.style.left = `${Math.random() * 120}px`;
  r.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n">${esc(who)}</span>`;
  $('#reactLayer').appendChild(r);
  setTimeout(() => r.remove(), 3300);
}

// people panel: who's here + invite a teammate
$('#people').onclick = () => { $('#panel').hidden = !$('#panel').hidden; renderPanel(true); };
$('#closePanel').onclick = () => { $('#panel').hidden = true; };
async function renderPanel(refresh = false) {
  if ($('#panel').hidden) return;
  if (refresh) cfg = { ...cfg, ...(await bridge.callConfig().catch(() => ({}))) };
  const row = (u, right = '') => `<li><span class="av" style="--c:${esc(u.color || '#6c8cff')}">${esc(initials(u.name))}</span><span class="who">${esc(u.name)}</span>${right}</li>`;
  $('#inCall').innerHTML = [row({ ...cfg.settings, name: `${cfg.settings.name} (You)` }), ...[...peers.values()].map(p => row(p.user))].join('');
  const inCall = new Set([...peers.values()].map(p => p.user.id).concat(cfg.settings.userId));
  const list = (cfg.members || []).filter(m => !inCall.has(m.id));
  $('#addList').innerHTML = list.length
    ? list.map(m => { const d = display(m, []); return row(m, `<button data-id="${esc(m.id)}">Call</button>`).replace('</span><button', `<small>${d.emoji} ${esc(d.label)}</small></span><button`); }).join('')
    : '<div class="empty">Everyone online is already here.</div>';
  $('#addList').querySelectorAll('button').forEach(b => b.onclick = () => {
    send({ type: 'call:invite', to: b.dataset.id, callId });
    b.textContent = 'Ringing…';
    b.disabled = true;
  });
}

$('#mic').onclick = toggleMic;
$('#cam').onclick = toggleCam;
$('#share').onclick = toggleShare;
$('#hand').onclick = toggleHand;
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'd') { e.preventDefault(); toggleMic(); }
  if ((e.metaKey || e.ctrlKey) && k === 'e') { e.preventDefault(); toggleCam(); }
});

function leave() {
  if (leaving) return;
  leaving = true;
  send({ type: 'call:leave' });
  for (const p of peers.values()) p.pc.close();
  [mic, camTrack, screenTrack].forEach(t => t?.stop());
  try { ws?.close(); } catch {}
  setTimeout(() => bridge.closeWindow(), 120);
}
$('#leave').onclick = leave;
window.addEventListener('beforeunload', () => { send({ type: 'call:leave' }); });

main();
