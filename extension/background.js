// Deskmate service worker: owns the team connection and all "ambient" behaviour
// (auto-away, Google Chat sync, badge, notifications, help pop-ups, call windows).
import { DeskClient, newId } from './lib/client.js';
import { STATUS, DEFAULT_SERVER } from './lib/status.js';

const DEFAULTS = {
  server: DEFAULT_SERVER, team: '', name: '', email: '', color: '#6C8CFF',
  avatar: { skin: '#F5D0B5', hair: '#2B2118', style: 'short' },
  idleMinutes: 5, lunchMinutes: 45, gchat: false, bubbles: true, autoBack: true, callApp: 'meet',
};

let client = null;
let settings = null;
const ports = new Set();
let callWindowId = null;
let gchat = { available: false, last: null, error: null };
let ready = null;

// ------------------------------------------------------------------ boot
function init() {
  if (ready) return ready;
  ready = (async () => {
    const stored = (await chrome.storage.sync.get('settings')).settings || {};
    settings = { ...DEFAULTS, ...stored, avatar: { ...DEFAULTS.avatar, ...(stored.avatar || {}) } };
    if (!settings.userId) {
      settings.userId = (settings.email || '').toLowerCase() || newId();
      await chrome.storage.sync.set({ settings });
    }
    const { lastStatus } = await chrome.storage.local.get('lastStatus');
    settings.lastStatus = lastStatus || null;
    const oauth = chrome.runtime.getManifest().oauth2;
    gchat.available = !!(oauth && oauth.client_id && !oauth.client_id.startsWith('YOUR_'));

    client = new DeskClient({ settings, role: 'main' });
    client.onChange(onChange);
    client.onEvent(onEvent);
    client.connect();
    chrome.idle.setDetectionInterval(Math.max(15, settings.idleMinutes * 60));
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
    chrome.alarms.create('gchat', { periodInMinutes: 1 });
  })();
  return ready;
}
init();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await init();
  if (reason === 'install') {
    // open the panel-equivalent welcome so setup is one step
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
  }
});
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener(async (a) => {
  await init();
  if (a.name === 'watchdog') client.connect();
  if (a.name === 'gchat') syncGoogleChat(false);
});

// ------------------------------------------------------------------ state fan-out
function fullState(snap = client.snapshot()) {
  const { lastStatus, ...publicSettings } = settings;
  return { ...snap, settings: publicSettings, configured: client.configured, gchat: { available: gchat.available, last: gchat.last, error: gchat.error } };
}

function onChange(snap) {
  const st = fullState(snap);
  for (const p of ports) { try { p.postMessage({ type: 'state', state: st }); } catch {} }
  updateBadge(snap);
}

function onEvent(e, snap) {
  for (const p of ports) { try { p.postMessage({ type: 'event', event: e }); } catch {} }
  const me = snap.me;
  // let the Mac companion own pop-ups when it's running, so you don't get two
  const companionOwnsPopups = !!me?.companion;
  const focused = me?.state === 'dnd';

  switch (e.type) {
    case 'my-status':
      chrome.storage.local.set({ lastStatus: { state: e.member.state, message: e.member.message, until: e.member.until, source: e.member.source } });
      break;

    case 'help:new':
      if (e.mine) break;
      if (e.help.to && me && !e.help.to.includes(me.id)) break;
      if (focused || companionOwnsPopups) break;
      showBubble({ kind: 'help', id: e.help.id, name: e.help.fromName, topic: e.help.topic, color: e.help.color, avatar: e.help.avatar, urgency: e.help.urgency })
        .then(shown => shown || notify(`help:${e.help.id}`, {   // fallback when no web page is open
          title: `${e.help.fromName} needs help`,
          message: e.help.topic || 'Tap to jump on a quick call',
          buttons: [{ title: 'Join' }, { title: 'Not now' }],
          requireInteraction: true,
          priority: 2,
        }));
      break;

    case 'help:claimed':
      chrome.notifications.clear(`help:${e.id}`);
      broadcastToBubbles({ type: 'bubble:update', id: e.id, claimedName: e.byName, byMe: e.byMe });
      // open the call on the surface that clicked "Join"; the asker's call opens in the
      // Mac app when it's running, otherwise here
      if (settings.callApp === 'meet') {
        // Google Meet: the helper's browser creates the meeting and shares the link;
        // the asker's browser opens it as soon as it arrives
        if (e.byMe) startMeet(url => client.shareMeet(e.id, url));
        else if (e.mine) meetFallback(e.id);
      } else if (e.byThisDevice || (e.mine && !companionOwnsPopups)) openCall(e.callId);
      break;

    case 'help:meet':
      clearTimeout(meetFallbacks.get(e.id));
      if ((e.mine || e.helping) && !e.byMe) openMeet(e.url);
      break;

    case 'help:closed':
      chrome.notifications.clear(`help:${e.id}`);
      broadcastToBubbles({ type: 'bubble:close', id: e.id });
      break;

    case 'wave':
      if (focused || companionOwnsPopups) break;
      showBubble({ kind: 'wave', id: newId(), from: e.from, name: e.fromName, emoji: e.emoji, color: snap.members.find(m => m.id === e.from)?.color, avatar: snap.members.find(m => m.id === e.from)?.avatar });
      break;

    case 'call:invite':
      if (companionOwnsPopups) break;
      showBubble({ kind: 'invite', id: e.callId, url: e.url, from: e.from, name: e.fromName, color: e.color, avatar: e.avatar })
        .then(shown => shown || (pendingInviteUrls.set(e.callId, e.url), notify(`invite:${e.callId}:${e.from}`, {   // fallback when no web page is open
          title: `${e.fromName} needs help`,
          message: 'Join the audio call?',
          buttons: [{ title: 'Join' }, { title: 'Not now' }],
          requireInteraction: true,
          priority: 2,
          silent: focused,
        })));
      break;
  }
}

function updateBadge(snap) {
  const me = snap.me;
  if (snap.conn !== 'online') {
    chrome.action.setBadgeText({ text: snap.conn === 'setup' ? '' : '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#94A3B8' });
    chrome.action.setTitle({ title: snap.conn === 'setup' ? 'Deskmate — click to set up' : 'Deskmate — connecting…' });
    return;
  }
  const open = snap.helps.filter(h => !h.claimedBy && h.from !== me?.id);
  const others = snap.members.filter(m => m.id !== me?.id);
  const here = others.filter(m => STATUS[m.state]?.present).length;
  if (open.length) {
    chrome.action.setBadgeText({ text: `!${open.length > 1 ? open.length : ''}` });
    chrome.action.setBadgeBackgroundColor({ color: '#F43F5E' });
  } else {
    chrome.action.setBadgeText({ text: here ? String(here) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#22C55E' });
  }
  chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
  const lunch = others.filter(m => m.state === 'lunch').length;
  const away = others.filter(m => m.state === 'afk' || m.state === 'brb').length;
  chrome.action.setTitle({ title: `Deskmate · ${snap.team}\n${here} at desk · ${lunch} at lunch · ${away} away${open.length ? `\n${open.length} asking for help` : ''}` });
}

// ------------------------------------------------------------------ notifications + bubbles
function notify(id, opts) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', ...opts }, () => void chrome.runtime.lastError);
}

chrome.notifications.onButtonClicked.addListener(async (id, btn) => {
  await init();
  const [kind, a, b] = id.split(':');
  if (kind === 'help' && btn === 0) client.claimHelp(a);
  if (kind === 'invite') btn === 0 ? act('call:accept', { callId: a, from: b, url: pendingInviteUrls.get(a) }) : client.decline(b, a);
  chrome.notifications.clear(id);
});
chrome.notifications.onClicked.addListener(async (id) => {
  await init();
  const [kind, a] = id.split(':');
  if (kind === 'help') client.claimHelp(a);
  if (kind === 'invite') act('call:accept', { callId: a, url: pendingInviteUrls.get(a) });
  chrome.notifications.clear(id);
});

async function showBubble(data) {
  if (!settings.bubbles) return false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return false; // (no "tabs" permission needed: we just try, pages without our script throw)
    await chrome.tabs.sendMessage(tab.id, { type: 'deskmate:bubble', data });
    return true;
  } catch { return false; } // page without our content script (chrome://, web store…)
}

function broadcastToBubbles(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ------------------------------------------------------------------ call windows
// ------------------------------------------------------------------ Google Meet
// Opening meet.google.com/new creates a meeting under the person's Google account.
// We watch that tab (host permission for meet.google.com lets us read its URL) until
// it lands on the meeting code, then share the link.
const MEET_CODE = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/;
const meetFallbacks = new Map();
const pendingInviteUrls = new Map();
const meetWatch = new Map(); // tabId -> callback

async function startMeet(onUrl) {
  const tab = await chrome.tabs.create({ url: 'https://meet.google.com/new', active: true });
  meetWatch.set(tab.id, onUrl);
  setTimeout(() => meetWatch.delete(tab.id), 3 * 60 * 1000); // e.g. still on the Google sign-in page
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const cb = meetWatch.get(tabId);
  const m = info.url && info.url.match(MEET_CODE);
  if (!cb || !m) return;
  meetWatch.delete(tabId);
  cb(`https://meet.google.com/${m[1]}`);
});
chrome.tabs.onRemoved.addListener((tabId) => meetWatch.delete(tabId));

function openMeet(url) {
  if (url && MEET_CODE.test(url)) chrome.tabs.create({ url, active: true });
}

// If the helper can't create a Meet (e.g. they joined from the Mac app only), the asker makes one.
function meetFallback(helpId) {
  clearTimeout(meetFallbacks.get(helpId));
  meetFallbacks.set(helpId, setTimeout(() => {
    const h = client.state.helps[helpId];
    if (h && h.claimedBy && !h.meetUrl) startMeet(url => client.shareMeet(helpId, url));
  }, 15000));
}

async function openCall(callId, ring) {
  const url = chrome.runtime.getURL(`call/call.html?id=${encodeURIComponent(callId)}${ring ? `&ring=${encodeURIComponent(ring)}` : ''}`);
  if (callWindowId !== null) {
    try {
      const w = await chrome.windows.get(callWindowId, { populate: true });
      const tab = w.tabs?.[0];
      if (tab && !tab.url.includes(`id=${encodeURIComponent(callId)}`)) await chrome.tabs.update(tab.id, { url });
      await chrome.windows.update(callWindowId, { focused: true, drawAttention: true });
      return;
    } catch { callWindowId = null; }
  }
  let left, top;
  try {
    const ref = await chrome.windows.getLastFocused();
    left = Math.max(0, (ref.left || 0) + (ref.width || 1200) - 380);
    top = (ref.top || 0) + 70;
  } catch {}
  const opts = { url, type: 'popup', width: 360, height: 500, focused: true };
  let w;
  try { w = await chrome.windows.create({ ...opts, left, top }); }
  catch { w = await chrome.windows.create(opts); } // bounds off-screen (multi-monitor etc.)
  callWindowId = w.id;
}
chrome.windows.onRemoved.addListener((id) => { if (id === callWindowId) callWindowId = null; });

// ------------------------------------------------------------------ auto-away
chrome.idle.onStateChanged.addListener(async (s) => {
  await init();
  const me = client.state.me;
  if (!me) return;
  if (s === 'idle' || s === 'locked') {
    if (me.state === 'desk' || me.state === 'meeting' && me.source !== 'manual') client.setStatus('afk', { source: 'idle' });
  } else if (s === 'active') {
    if (me.state === 'afk' && me.source !== 'manual') client.setStatus('desk', { source: 'activity' });
    else if ((me.state === 'lunch' || me.state === 'brb') && settings.autoBack) client.setStatus('desk', { source: 'activity' });
  }
});

// ------------------------------------------------------------------ Google Chat status sync
// Uses the Chat API "users/me/availability" endpoint. Needs an OAuth client ID in manifest.json.
async function syncGoogleChat(interactive) {
  if (!gchat.available || !settings.gchat || !client?.state.me) return;
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive, scopes: ['https://www.googleapis.com/auth/chat.users.availability.readonly'] });
    if (!token) return;
    const res = await fetch('https://chat.googleapis.com/v1/users/me/availability', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { await chrome.identity.removeCachedAuthToken({ token }); return; }
    if (!res.ok) throw new Error(`Chat API ${res.status}`);
    const av = await res.json();
    gchat.error = null;
    const raw = String(av.state || '').toUpperCase();
    const mapped = raw.includes('DO_NOT_DISTURB') || raw.includes('DND') ? 'dnd'
      : raw.includes('AWAY') || raw.includes('IDLE') || raw.includes('INACTIVE') ? 'afk'
      : raw.includes('ACTIVE') || raw.includes('AVAILABLE') ? 'desk' : null;
    const msg = av.customStatus?.text ? `${av.customStatus.emoji?.unicode ? av.customStatus.emoji.unicode + ' ' : ''}${av.customStatus.text}` : undefined;
    const key = `${mapped}|${msg || ''}`;
    if (!mapped || key === gchat.last) return;
    gchat.last = key;
    const me = client.state.me;
    if (mapped === 'desk') {
      // Google says "active": only pull you back if Deskmate had you auto-away / synced DND
      if (me.source === 'gchat' || (me.state === 'afk' && me.source !== 'manual')) client.setStatus('desk', { message: msg, source: 'gchat' });
      return;
    }
    client.setStatus(mapped, { message: msg, source: 'gchat' });
  } catch (e) {
    gchat.error = String(e.message || e);
  }
}

// ------------------------------------------------------------------ commands (keyboard shortcuts)
chrome.commands.onCommand.addListener(async (cmd) => {
  await init();
  const me = client.state.me;
  if (cmd === 'ask-help') {
    const mine = client.snapshot().myHelp;
    if (mine) client.cancelHelp(mine.id); else client.askHelp('');
  }
  if (cmd === 'toggle-lunch') act('status', { state: me?.state === 'lunch' ? 'desk' : 'lunch' });
  if (cmd === 'toggle-focus') act('status', { state: me?.state === 'dnd' ? 'desk' : 'dnd' });
});

// ------------------------------------------------------------------ actions from UI surfaces
function act(name, args = {}) {
  const me = client.state.me;
  switch (name) {
    case 'status': {
      const s = args.state;
      const until = s === 'lunch' ? Date.now() + settings.lunchMinutes * 60000 : s === 'brb' ? Date.now() + 10 * 60000 : null;
      client.setStatus(s, { until, message: args.message });
      if (s === 'dnd') chrome.notifications.getAll(n => Object.keys(n).filter(k => k.startsWith('help:')).forEach(k => chrome.notifications.clear(k)));
      break;
    }
    case 'note':
      if (me) client.setStatus(me.state, { message: args.message, until: me.until });
      break;
    case 'lunch:extend':
      if (me) client.setStatus(me.state, { until: Math.max(me.until || Date.now(), Date.now()) + (args.minutes || 15) * 60000, message: me.message });
      break;
    case 'help': client.askHelp(args.topic || '', args.urgency || 'normal'); break;
    case 'help:cancel': client.cancelHelp(args.id); break;
    case 'help:end': client.endHelp(args.id); break;
    case 'help:claim': client.claimHelp(args.id); break;
    case 'wave': client.wave(args.to, args.emoji); break;
    case 'react': client.react(args.emoji); break;
    case 'call': {
      const callId = newId();
      if (settings.callApp === 'meet') startMeet(url => client.invite(args.to, callId, url));
      else { client.invite(args.to, callId); openCall(callId, args.to); }
      break;
    }
    case 'call:join': {
      // help call or huddle: use its Meet link when there is one
      const url = args.url || client.state.helps[args.callId]?.meetUrl || client.snapshot().calls.find(c => c.callId === args.callId)?.url;
      if (url) openMeet(url);
      else if (settings.callApp === 'meet' && client.state.helps[args.callId]) { /* link is on its way */ }
      else openCall(args.callId);
      break;
    }
    case 'call:accept':
      chrome.notifications.clear(`invite:${args.callId}:${args.from}`);
      if (args.url) openMeet(args.url); else openCall(args.callId);
      break;
    case 'call:decline':
      chrome.notifications.clear(`invite:${args.callId}:${args.from}`);
      client.decline(args.from, args.callId);
      break;
    case 'call:invite': client.invite(args.to, args.callId); break;
  }
}

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'ui') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => { await init(); if (msg.type === 'action') act(msg.name, msg.args); });
  await init();
  port.postMessage({ type: 'state', state: fullState() });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await init();
    if (msg.type === 'action') { act(msg.name, msg.args); reply({ ok: true }); }
    else if (msg.type === 'settings:save') {
      const next = { ...settings, ...msg.settings };
      // identity = work email, so the Chrome extension and the Mac app merge into one person
      next.userId = next.email ? next.email.toLowerCase() : (settings.userId || newId());
      const { lastStatus, ...persist } = next;
      await chrome.storage.sync.set({ settings: persist });
      const gchatTurnedOn = next.gchat && !settings.gchat;
      settings = next;
      chrome.idle.setDetectionInterval(Math.max(15, settings.idleMinutes * 60));
      client.updateSettings(settings);
      if (gchatTurnedOn) { gchat.last = null; syncGoogleChat(true); }
      onChange(client.snapshot());
      reply({ ok: true });
    }
    else if (msg.type === 'profile') {
      try {
        const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
        reply({ email: info.email || '' });
      } catch { reply({}); }
    }
    else if (msg.type === 'call:config') {
      const snap = client.snapshot();
      reply({ settings: { server: settings.server, team: settings.team, userId: settings.userId, name: settings.name, email: settings.email, color: settings.color, avatar: settings.avatar, tz: settings.tz }, members: snap.members, me: snap.me });
    }
    else reply(null);
  })();
  return true;
});

// handy for debugging from the service worker console / automated tests
globalThis.deskmate = { get client() { return client; }, get settings() { return settings; }, openCall, act };
