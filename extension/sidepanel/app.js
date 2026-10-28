import { bridge } from '../lib/bridge-ext.js';
import { STATUS, QUICK, PETS, COLORS, SKIN, HAIR, DEFAULT_SERVER, display, initials, since, untilText, localTime, nameFromEmail } from '../lib/status.js';
import { weatherEmoji, WEATHER } from '../lib/weather.js';
import { plantStage, nextStageAt, PLANT_NAMES } from '../lib/plant.js';
import { Pet } from '../lib/pets.js';
import { DeskScene } from './desk3d.js';
import { THREE, addSoftLights, configureRenderer } from '../lib/avatar.js';
import { makeCharacter, usingModels, characterList } from '../lib/characters.js';
import { playChime } from '../lib/chime.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dark = matchMedia('(prefers-color-scheme: dark)');

let state = null;
let scene = null;
let scene3dFailed = false;
// ?lite → list-only view (very old machines, automated tests)
const LITE = new URLSearchParams(location.search).has('lite');
let selected = null;
let editingSettings = false;
let helpDraft = '';

// ------------------------------------------------------------------ state
// subscribe after the whole module has run (state can arrive immediately)
queueMicrotask(() => bridge.onState((s) => {
  state = s;
  if (!s.configured || editingSettings) showSetup(!s.configured);
  else showDesk();
}));

bridge.onEvent((e) => {
  if (e.type === 'react') scene?.react(e.from, e.emoji);
  if (e.type === 'toast') toast(e.text);
  if (e.type === 'call:ended' && e.reason === 'declined' && e.byName) toast(`${e.byName} can't talk right now`);
  if (e.type === 'wave') { scene?.wave(e.from); scene?.react(e.from, e.emoji || '👋'); toast(`${e.fromName} waved at you ${e.emoji || '👋'}`); }
  if (e.type === 'help:taken') toast('Someone else already picked that up');
  if (e.type === 'help:gone') toast('That request was closed');
  if (e.type === 'call:declined') toast(`${e.byName} can't talk right now`);
  if (e.type === 'error' && e.error === 'call_full') toast('That huddle is full');
  if (e.type === 'grow') scene?.grow(e.userId, e.reason);
  if (e.type === 'grow' && e.toMe) toast(e.reason === 'kudos' ? 'Your plant grew 🌱' : 'Thanks for helping, your plant grew 🌱');
  if (e.type === 'kudos' && e.toMe) toast(`${e.fromName} sent you kudos 👏`);
  if (e.type === 'kudos' && e.from === state?.me?.id) toast(`Kudos sent to ${e.toName} 👏`);
  if (e.type === 'kudos:wait') toast('You sent them kudos a moment ago. Try again in a few minutes 🙂');
  if (e.type === 'team') toast(`${e.by} updated the team stand-up`);
  if (e.type === 'standup' && e.started) toast('Stand-up time! The team is gathering 🧍');
  if (e.type === 'standup' && !e.standup && e.reason === 'done') toast('Stand-up done. Have a great day ✨');
});

// ------------------------------------------------------------------ desk
function showDesk() {
  $('#setup').hidden = true;
  $('#desk').hidden = false;
  if (!scene && !scene3dFailed && !LITE) {
    try {
      scene = new DeskScene($('#stage'), { onSelect: openCard, dark: dark.matches });
      globalThis.__deskScene = scene; // handy for debugging / tests
      dark.addEventListener('change', () => scene.setTheme(dark.matches));
      setTimeout(() => { $('#stageHint').style.opacity = 0; }, 5000);
    } catch (e) {
      // no WebGL (very old GPU / disabled hardware acceleration): the list still works
      console.warn('3D desk unavailable', e);
      scene3dFailed = true;
      $('#stageHint').textContent = '3D view needs hardware acceleration — the team list below still works.';
      $('#stage').style.height = '64px';
    }
  }
  render();
}

function render() {
  const s = state;
  const me = s.me;
  // header
  $('#teamName').textContent = s.team || 'Team';
  const conn = $('#conn');
  conn.className = 'conn ' + s.conn;
  const here = s.members.filter(m => STATUS[m.state]?.present).length;
  $('#teamSub').textContent = {
    online: `${here} of ${s.members.length} at their desks`,
    connecting: 'Connecting…',
    offline: 'Reconnecting…',
    error: errorText(s.error),
    setup: 'Set up needed',
  }[s.conn] || 'Connecting…';

  $('#serverWarn').hidden = !s.serverOutdated;
  scene?.update(s);
  renderQuick(me);
  renderHelp(s);
  renderFeed(s);
  renderPeople(s);
  renderStandup(s);
  if (selected) openCard(selected);
}

// ------------------------------------------------------------------ stand-up bar
function renderStandup(s) {
  const bar = $('#standupBar');
  const su = s?.standup;
  bar.hidden = !su;
  if (!su) { bar.dataset.k = ''; return; }
  const name = (id) => s.members.find(m => m.id === id)?.name || 'Someone';
  const left = Math.max(0, Math.round((su.turnEndsAt - Date.now()) / 1000));
  const key = `${su.id}:${su.turn}:${su.order.join(',')}`;
  if (bar.dataset.k !== key) {
    bar.dataset.k = key;
    const speaker = su.order[su.turn];
    bar.innerHTML = `
      <div class="row"><span>🧍</span><b>Stand-up · ${speaker === s.me?.id ? 'your turn' : esc(name(speaker).split(' ')[0]) + '’s turn'}</b><span class="timer" id="suTimer"></span></div>
      <div class="line">${su.order.map((id, i) => `<span class="chip ${i < su.turn ? 'done' : i === su.turn ? 'now' : ''}">${esc(name(id).split(' ')[0])}</span>`).join('')}</div>
      <div class="btns"><button class="btn" id="suNext">${su.turn >= su.order.length - 1 ? 'Finish' : 'Next ▶'}</button><button class="btn ghost" id="suEnd">End stand-up</button></div>`;
    $('#suNext').onclick = () => bridge.action('standup:next');
    $('#suEnd').onclick = () => bridge.action('standup:end');
  }
  $('#suTimer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
setInterval(() => { if (state?.standup && !$('#desk').hidden) renderStandup(state); }, 1000);

function errorText(e) {
  return ({ unknown_team: 'Unknown team code', domain_not_allowed: 'Email domain not allowed', bad_server_url: 'Check the server URL' })[e] || 'Can’t reach the server';
}

function renderQuick(me) {
  const wrap = $('#quick');
  if (!wrap.childElementCount) {
    for (const key of QUICK) {
      const b = document.createElement('button');
      b.setAttribute('role', 'radio');
      b.dataset.state = key;
      b.style.setProperty('--c', STATUS[key].color);
      b.innerHTML = `<span class="e">${STATUS[key].emoji}</span><span>${STATUS[key].short}</span>`;
      b.title = STATUS[key].label;
      b.onclick = () => {
        const cur = state.me?.state;
        // clicking the active one (other than "Here") toggles back to desk
        const next = cur === key && key !== 'desk' ? 'desk' : key;
        bridge.action('status', { state: next });
      };
      wrap.appendChild(b);
    }
  }
  // in a meeting you're still at your desk: "Here" stays selected
  const shown = me?.state === 'meeting' ? 'desk' : me?.state;
  for (const b of wrap.children) b.setAttribute('aria-checked', String(shown === b.dataset.state));

  const meta = $('#meMeta');
  if (!me) { meta.innerHTML = ''; return; }
  const st = STATUS[me.state] || STATUS.desk;
  let left = `${st.label}${me.source && me.source !== 'manual' ? ' <span class="chip">auto</span>' : ''} · ${since(me.since)}`;
  if (me.until) left = `${st.label} · ${untilText(me.until)}`;
  const right = me.state === 'lunch' || me.state === 'brb'
    ? `<button class="chip" data-extend="15">+15m</button>`
    : `<button class="chip" id="msgBtn">${me.message ? esc(me.message) : 'Set a note'}</button>`;
  if (meta.dataset.k !== left + right && !meta.querySelector('input')) {
    meta.dataset.k = left + right;
    meta.innerHTML = `<span>${left}</span>${right}`;
    meta.querySelector('[data-extend]')?.addEventListener('click', () => bridge.action('lunch:extend', { minutes: 15 }));
    meta.querySelector('#msgBtn')?.addEventListener('click', editNote);
  }
}

function editNote() {
  const meta = $('#meMeta');
  meta.innerHTML = `<input maxlength="80" placeholder="What are you working on? (Enter to save)" value="${esc(state.me?.message || '')}">`;
  const input = meta.querySelector('input');
  input.focus();
  const done = (save) => {
    if (save) bridge.action('note', { message: input.value.trim() });
    meta.dataset.k = '';
    meta.innerHTML = '';
    renderQuick(state.me);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

function renderHelp(s) {
  const box = $('#helpBox');
  const mine = s.myHelp;
  const key = mine ? `w:${mine.id}:${mine.claimedBy || ''}:${mine.meetUrl || ''}` : 'ask';
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  if (!mine) {
    box.innerHTML = `
      <form class="ask" id="askForm">
        <span>🙋</span>
        <input id="askInput" placeholder="Need a hand? Say what with (optional)" maxlength="140" value="${esc(helpDraft)}">
        <button class="btn help" type="submit">Ask for help</button>
      </form>`;
    const input = $('#askInput');
    input.addEventListener('input', () => { helpDraft = input.value; });
    $('#askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      bridge.action('help', { topic: input.value.trim() });
      helpDraft = '';
    });
  } else if (!mine.claimedBy) {
    box.innerHTML = `
      <div class="waiting">
        <div class="spin"></div>
        <div class="txt"><b>Asking the team…</b><span class="muted small">${esc(mine.topic || 'You’ll be connected as soon as someone taps Join')}</span></div>
        <button class="btn ghost" id="cancelHelp">Cancel</button>
      </div>`;
    $('#cancelHelp').onclick = () => bridge.action('help:cancel', { id: mine.id });
  } else {
    box.innerHTML = `
      <div class="waiting claimed">
        <div class="spin"></div>
        <div class="txt"><b>${esc(mine.claimedName || 'A teammate')} is joining you</b><span class="muted small">Your call window is open</span></div>
        <div class="acts-row"><button class="btn" id="openCall">Open call</button><button class="btn end" id="endCall">End call</button></div>
      </div>`;
    $('#openCall').onclick = () => bridge.action('call:join', { callId: mine.id });
    $('#endCall').onclick = () => { bridge.action('help:end', { id: mine.id }); toast('Call ended'); };
  }
}

function renderFeed(s) {
  const feed = $('#feed');
  const me = s.me;
  const items = [];
  for (const h of s.helps) {
    if (me && h.from === me.id) continue;
    const who = s.members.find(m => m.id === h.from);
    const age = since(h.ts);
    if (h.claimedBy && me && h.claimedBy === me.id) {
      items.push(`<div class="req"><div class="av" style="--c:${h.color}">${initials(h.fromName)}</div>
        <div class="txt"><b>You’re helping ${esc(h.fromName.split(' ')[0])}</b><span>${esc(h.topic || 'Video call')}</span></div>
        <div class="acts-row"><button class="btn" data-join="${h.id}">Open call</button><button class="btn end" data-end="${h.id}">End call</button></div></div>`);
    } else if (h.claimedBy) {
      items.push(`<div class="req"><div class="av" style="--c:${h.color}">${initials(h.fromName)}</div>
        <div class="txt"><b>${esc(h.fromName)} is getting help</b><span>${esc(h.claimedName || 'Someone')} is on it${h.topic ? ' · ' + esc(h.topic) : ''}</span></div>
        <button class="btn" data-join="${h.id}" title="Join the huddle">Join</button></div>`);
    } else {
      items.push(`<div class="req hot"><div class="av" style="--c:${h.color}">${initials(h.fromName)}</div>
        <div class="txt"><b>${esc(h.fromName)} needs help</b><span>${esc(h.topic || 'No details — hop on a quick call')} · ${age}</span></div>
        <button class="btn help" data-claim="${h.id}">Join call</button></div>`);
    }
    void who;
  }
  const helpCalls = new Set(s.helps.map(h => h.id));
  for (const c of s.calls) {
    if (helpCalls.has(c.callId) || !c.participants.length) continue;
    if (me && c.participants.includes(me.id)) continue;
    const names = c.participants.map(id => s.members.find(m => m.id === id)?.name || '…');
    items.push(`<div class="req"><div class="av" style="--c:#14b8a6">🎙️</div>
      <div class="txt"><b>Huddle in progress</b><span>${esc(names.join(', '))}</span></div>
      <button class="btn" data-join="${c.callId}">Join</button></div>`);
  }
  const html = items.join('');
  if (feed.dataset.k === html) return;
  feed.dataset.k = html;
  feed.innerHTML = html;
  feed.querySelectorAll('[data-claim]').forEach(b => b.onclick = () => bridge.action('help:claim', { id: b.dataset.claim }));
  feed.querySelectorAll('[data-join]').forEach(b => b.onclick = () => bridge.action('call:join', { callId: b.dataset.join }));
  feed.querySelectorAll('[data-end]').forEach(b => b.onclick = () => { bridge.action('help:end', { id: b.dataset.end }); toast('Call ended'); });
}

function renderPeople(s) {
  const ul = $('#people');
  const counts = {};
  for (const m of s.members) counts[m.state] = (counts[m.state] || 0) + 1;
  $('#counts').textContent = [counts.desk && `${counts.desk} here`, counts.lunch && `${counts.lunch} lunch`, counts.afk && `${counts.afk} away`].filter(Boolean).join(' · ');
  const order = { help: 0, call: 1, desk: 2, dnd: 3, meeting: 4, brb: 5, lunch: 6, afk: 7, leave: 8 };
  const rows = s.members.map(m => ({ m, d: display(m, s.helps) }))
    .sort((a, b) => (a.m.id === s.me?.id ? -1 : b.m.id === s.me?.id ? 1 : 0) || (order[a.d.key] - order[b.d.key]) || a.m.name.localeCompare(b.m.name));
  const html = rows.map(({ m, d }) => {
    const isMe = m.id === s.me?.id;
    const sub = [d.label, m.until ? untilText(m.until) : since(m.since), m.message].filter(Boolean).map(esc).join(' · ');
    return `<li data-id="${esc(m.id)}" class="${STATUS[m.state]?.present ? '' : 'away'}">
      <div class="av" style="--c:${m.color}">${initials(m.name)}<span class="ring" style="--s:${d.color}"></span></div>
      <div class="txt"><b>${esc(m.name)}${isMe ? ' <span class="muted">(you)</span>' : ''}</b><span>${d.emoji} ${sub}</span></div>
      <span class="time">${m.weather ? weatherEmoji(m.weather) + ' ' : ''}${localTime(m.tz)}</span>
      ${isMe ? '' : `<span class="q"><button data-wave title="Wave">👋</button><button data-call title="Call">📞</button></span>`}
    </li>`;
  }).join('');
  if (ul.dataset.k === html) return;
  ul.dataset.k = html;
  ul.innerHTML = html;
  ul.querySelectorAll('li').forEach(li => {
    const id = li.dataset.id;
    li.querySelector('[data-wave]')?.addEventListener('click', e => { e.stopPropagation(); wave(id); });
    li.querySelector('[data-call]')?.addEventListener('click', e => { e.stopPropagation(); call(id); });
    li.addEventListener('click', () => openCard(id));
  });
}

// ------------------------------------------------------------------ person card
function openCard(id) {
  const card = $('#personCard');
  if (!id) { selected = null; card.hidden = true; return; }
  const m = state.members.find(x => x.id === id);
  if (!m) { selected = null; card.hidden = true; return; }
  selected = id;
  const d = display(m, state.helps);
  const isMe = m.id === state.me?.id;
  const help = state.helps.find(h => h.from === m.id && !h.claimedBy);
  card.innerHTML = `
    <div class="who"><div class="av" style="--c:${m.color}">${initials(m.name)}<span class="ring" style="--s:${d.color}"></span></div>
      <div><b>${esc(m.name)}</b><span class="muted small">${d.emoji} ${esc(d.label)} · ${m.until ? untilText(m.until) : since(m.since)}</span></div></div>
    <p class="meta">${[m.message && '“' + esc(m.message) + '”', localTime(m.tz) && `${localTime(m.tz)} local`, m.weather && `${weatherEmoji(m.weather)} ${m.weather.temp ?? ''}°${m.weather.place ? ' in ' + esc(m.weather.place) : ''}`, m.source === 'gchat' && 'via Google Chat'].filter(Boolean).join(' · ') || '&nbsp;'}</p>
    <p class="plant-line">🌱 ${PLANT_NAMES[plantStage(m.plant)]} · helped ${m.helped || 0} · ${m.kudos || 0} kudos${nextStageAt(m.plant) ? ` · ${nextStageAt(m.plant) - (m.plant || 0)} to grow` : ''}</p>
    ${isMe ? '' : `<div class="acts">
      ${help ? `<button class="btn help" data-a="claim" style="grid-column:1/-1">Help ${esc(m.name.split(' ')[0])}</button>` : ''}
      ${m.inCall ? `<button class="btn" data-a="join" style="grid-column:1/-1">Join their huddle</button>` : ''}
      <button class="btn" data-a="wave">👋 Wave</button>
      <button class="btn primary" data-a="call">📞 Call</button>
      <button class="btn" data-a="kudos" style="grid-column:1/-1">👏 Send kudos</button>
    </div>`}`;
  card.hidden = false;
  card.style.left = '50%';
  card.style.top = '50%';
  card.style.transform = 'translate(-50%, -50%)';
  card.querySelector('[data-a=wave]')?.addEventListener('click', () => { wave(id); openCard(null); });
  card.querySelector('[data-a=call]')?.addEventListener('click', () => { call(id); openCard(null); });
  card.querySelector('[data-a=kudos]')?.addEventListener('click', () => { bridge.action('kudos', { to: id }); openCard(null); });
  card.querySelector('[data-a=claim]')?.addEventListener('click', () => { bridge.action('help:claim', { id: help.id }); openCard(null); });
  card.querySelector('[data-a=join]')?.addEventListener('click', () => { bridge.action('call:join', { callId: m.inCall }); openCard(null); });
}
document.addEventListener('pointerdown', e => {
  const card = $('#personCard');
  if (!card.hidden && !card.contains(e.target) && !e.target.closest('.label') && !e.target.closest('#people') && e.target.tagName !== 'CANVAS') openCard(null);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') openCard(null); });

function wave(id) {
  bridge.action('wave', { to: id });
  scene?.wave(state.me?.id);
  const m = state.members.find(x => x.id === id);
  toast(`Waved at ${m?.name || 'them'} 👋`);
}
function call(id) { bridge.action('call', { to: id }); }

$('#reactions').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  bridge.action('react', { emoji: b.dataset.emoji });
  if (b.dataset.emoji === '👋') scene?.wave(state.me?.id);
});

$('#copyCode').onclick = async () => {
  const text = `Join our Deskmate team desk 👋\nTeam code: ${state.team}\nServer: ${state.settings?.server}`;
  try { await navigator.clipboard.writeText(text); toast('Invite copied — paste it to a teammate'); }
  catch { toast(`Team code: ${state.team}`); }
};
$('#openSettings').onclick = () => { editingSettings = true; showSetup(false); };
$('#closeSettings').onclick = () => { editingSettings = false; showDesk(); };

// refresh relative times
setInterval(() => { if (state && !$('#desk').hidden) { renderQuick(state.me); renderPeople(state); } }, 30000);

// ------------------------------------------------------------------ setup / settings
let draft = null;
let preview = null;

async function showSetup(firstRun) {
  $('#desk').hidden = true;
  $('#setup').hidden = false;
  $('#closeSettings').hidden = firstRun;
  $('#setupTitle').textContent = firstRun ? 'Join your team desk' : 'Settings';
  $('#saveBtn').textContent = firstRun ? 'Join desk' : 'Save';
  if (draft) return;
  const cur = state?.settings || (await bridge.getSettings()) || {};
  const prof = firstRun ? (await bridge.profile().catch(() => null)) || {} : {};
  draft = {
    name: cur.name || nameFromEmail(prof.email || ''),
    email: cur.email || prof.email || '',
    team: cur.team || '',
    server: cur.server || DEFAULT_SERVER,
    color: cur.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    avatar: { skin: SKIN[0], hair: HAIR[0], style: 'short', glasses: 'none', ...(cur.avatar || {}) },
    idleMinutes: cur.idleMinutes || 5,
    lunchMinutes: cur.lunchMinutes || 45,
    gchat: cur.chatSync !== false,
    bubbles: cur.bubbles !== false,
    sound: cur.sound !== false,
    autoBack: cur.autoBack !== false,
    weatherPlace: cur.weatherPlace || '',
  };
  const f = $('#setupForm');
  for (const k of ['name', 'email', 'team', 'server', 'idleMinutes', 'lunchMinutes']) f.elements[k].value = draft[k];
  for (const k of ['gchat', 'bubbles', 'sound', 'autoBack']) f.elements[k].checked = draft[k];
  f.elements.weatherPlace.value = draft.weatherPlace;
  // desk pet
  const petRow = $('#petRow');
  petRow.innerHTML = PETS.map(p => `<button type="button" role="radio" data-id="${p.id}" title="${p.label}">${p.emoji}</button>`).join('');
  const pickPet = (id) => { draft.avatar.pet = id; petRow.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.id === id))); };
  petRow.onclick = e => { const b = e.target.closest('button'); if (!b) return; pickPet(b.dataset.id); rebuildPreview(); };
  pickPet(draft.avatar.pet || '');
  // team stand-up (team-wide; needs a connection, so not on first run)
  const su = state?.teamCfg?.standup || { enabled: false, time: '09:30', days: [1, 2, 3, 4, 5], perPerson: 60 };
  $('#standupBox').hidden = firstRun;
  f.elements.suEnabled.checked = !!su.enabled;
  f.elements.suTime.value = su.time;
  f.elements.suPer.value = String(su.perPerson);
  const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  $('#suDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" value="${d}" ${su.days.includes(d) ? 'checked' : ''}>${DAY[d]}</label>`).join('');
  $('#suNote').textContent = `Applies to everyone on this team${su.tz ? `, at ${su.time} ${su.tz.split('/').pop().replace(/_/g, ' ')} time` : ''}. People who are away, at lunch, BRB, on leave or in another meeting are skipped.`;
  const seen = state?.gchat?.seen;
  $('#gchatNote').textContent = seen ? `(now: ${[seen.availability, seen.detail].filter(Boolean).join(', ')})` : '(keep a Google Chat or Gmail tab open)';
  // the server is pre-filled, so Advanced stays closed on first run
  // character picker (each character carries its own colour)
  const list = characterList();
  if (!list.some(c => c.id === draft.avatar.model)) draft.avatar.model = list[0]?.id;
  const grid = $('#charGrid');
  grid.innerHTML = list.map(c => `<button type="button" role="radio" data-id="${c.id}"><span class="dot" style="background:${c.color}"></span>${c.name}</button>`).join('');
  const pickChar = (id) => {
    draft.avatar.model = id;
    const c = list.find(x => x.id === id);
    if (c?.color) draft.color = c.color;   // name tags / list dots match the character
    grid.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.id === id)));
  };
  grid.onclick = e => { const b = e.target.closest('button'); if (!b) return; pickChar(b.dataset.id); rebuildPreview(); };
  pickChar(draft.avatar.model);
  startPreview();
  setTimeout(() => (draft.name ? f.elements.team : f.elements.name).focus(), 50);
}

function swatches(sel, list, get, set) {
  const el = $(sel);
  el.innerHTML = list.map(c => `<button type="button" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('');
  const sync = () => el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === get())));
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; set(b.dataset.c); sync(); rebuildPreview(); };
  sync();
}

function startPreview() {
  if (preview) return rebuildPreview();
  const host = $('#avatarPreview');
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(140, 180);
  configureRenderer(r);
  host.appendChild(r.domElement);
  const sc = new THREE.Scene();
  addSoftLights(sc, { shadows: false });
  const cam = new THREE.PerspectiveCamera(30, 140 / 180, 0.1, 20);
  if (usingModels) { cam.position.set(0, 0.85, 3.9); cam.lookAt(0, 0.62, 0); } else { cam.position.set(0, 1.25, 3.55); cam.lookAt(0, 1.0, 0); }
  preview = { r, sc, cam, av: null, t: 0 };
  rebuildPreview();
  const clock = new THREE.Clock();
  const loop = () => {
    if ($('#setup').hidden) { preview.raf = requestAnimationFrame(loop); return; }
    const dt = clock.getDelta(); preview.t += dt;
    if (preview.av) {
      preview.av.root.rotation.y = Math.sin(preview.t * 0.6) * 0.5;
      preview.av.activity = (preview.t % 7) < 2.2 ? 'wave' : 'idle';
      preview.av.update(preview.t, dt);
    }
    preview.pet?.update(preview.t, dt, {});
    r.render(sc, cam);
    preview.raf = requestAnimationFrame(loop);
  };
  loop();
}
function rebuildPreview() {
  if (!preview || !draft) return;
  if (preview.av) { preview.sc.remove(preview.av.root); preview.av.dispose(); }
  preview.av = makeCharacter({ id: draft.email || draft.name, color: draft.color, avatar: draft.avatar });
  preview.av.pose = 'stand';
  preview.av.hop(1);
  preview.sc.add(preview.av.root);
  if (preview.pet) { preview.sc.remove(preview.pet.root); preview.pet.dispose(); preview.pet = null; }
  if (draft.avatar.pet) {
    preview.pet = new Pet(draft.avatar.pet);
    preview.pet.root.position.set(0.42, 0, 0.35);
    preview.pet.root.scale.setScalar(1.6);
    preview.pet.root.rotation.y = -0.4;
    preview.pet.hop(1.4);
    preview.sc.add(preview.pet.root);
  }
}

$('#suStartNow').addEventListener('click', () => {
  bridge.action('standup:start');
  editingSettings = false;
  showDesk();
});

// preview the sound when it's switched on
$('#setupForm').elements.sound.addEventListener('change', (e) => { if (e.target.checked) playChime('help').catch(() => {}); });

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  // the https://….workers.dev address Cloudflare prints works too
  const server = f.elements.server.value.trim().replace(/^http(s?):\/\//i, 'ws$1://').replace(/\/+$/, '');
  if (!/^wss?:\/\/[^/]/.test(server)) { $('#setupErr').textContent = 'Server URL must start with wss://, ws:// or https://'; $('#advanced').open = true; return; }
  const settings = {
    ...(state?.settings || {}),
    ...draft,
    name: f.elements.name.value.trim(),
    email: f.elements.email.value.trim(),
    team: f.elements.team.value.trim().toLowerCase().replace(/\s+/g, '-'),
    server,
    idleMinutes: Number(f.elements.idleMinutes.value) || 5,
    lunchMinutes: Number(f.elements.lunchMinutes.value) || 45,
    chatSync: f.elements.gchat.checked,
    bubbles: f.elements.bubbles.checked,
    sound: f.elements.sound.checked,
    autoBack: f.elements.autoBack.checked,
    weatherPlace: f.elements.weatherPlace.value.trim(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  $('#setupErr').textContent = '';
  await bridge.saveSettings(settings);
  // team stand-up: only send when it changed
  if (!$('#standupBox').hidden) {
    const days = [...$('#suDays').querySelectorAll('input:checked')].map(i => Number(i.value));
    const next = { enabled: f.elements.suEnabled.checked, time: f.elements.suTime.value || '09:30', days, perPerson: Number(f.elements.suPer.value), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const cur = state?.teamCfg?.standup;
    const same = cur && ['enabled', 'time', 'perPerson'].every(k => cur[k] === next[k]) && cur.days.join() === days.join();
    if (!same && (next.enabled || cur)) bridge.action('standup:config', { standup: next });
  }
  editingSettings = false;
  draft = null;
  if (state) state.configured = true;
  showDesk();
});

// ------------------------------------------------------------------ misc
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// keyboard: 1-4 quick status, / focuses help
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || $('#desk').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const i = ['1', '2', '3', '4'].indexOf(e.key);
  if (i >= 0) bridge.action('status', { state: QUICK[i] });
  if (e.key === '/') { e.preventDefault(); $('#askInput')?.focus(); }
});
