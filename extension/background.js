// Deskmate service worker: owns the team connection and all "ambient" behaviour
// (auto-away, Google Chat sync, badge, notifications, help pop-ups, call windows).
import { DeskClient, newId } from './lib/client.js';
import { fetchWeather } from './lib/weather.js';
import { STATUS, DEFAULT_SERVER } from './lib/status.js';

const DEFAULTS = {
  server: DEFAULT_SERVER, team: '', name: '', email: '', color: '#6C8CFF',
  avatar: { skin: '#F5D0B5', hair: '#2B2118', style: 'short' },
  idleMinutes: 5, lunchMinutes: 45, chatSync: true, bubbles: true, sound: true, autoBack: true, callApp: 'meet',
};

let client = null;
let settings = null;
const ports = new Set();
let callWindowId = null;
let gchat = { available: true, last: null, error: null, seen: null };
let ready = null;

// ------------------------------------------------------------------ boot
function init() {
  if (ready) return ready;
  ready = (async () => {
    const stored = (await chrome.storage.sync.get('settings')).settings || {};
    settings = { ...DEFAULTS, ...stored, avatar: { ...DEFAULTS.avatar, ...(stored.avatar || {}) } };
    // once per install: move old installs off the local development server onto the team's
    // hosted one (choosing localhost again afterwards in Settings sticks)
    if (!stored.serverMigrated) {
      if (/^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(settings.server || '')) settings.server = DEFAULT_SERVER;
      settings.serverMigrated = true;
      await chrome.storage.sync.set({ settings: { ...stored, server: settings.server, serverMigrated: true } });
    }
    if (!settings.userId) {
      settings.userId = (settings.email || '').toLowerCase() || newId();
      await chrome.storage.sync.set({ settings });
    }
    const { lastStatus, plant } = await chrome.storage.local.get(['lastStatus', 'plant']);
    settings.lastStatus = lastStatus || null;
    settings.plant = plant || 0;

    client = new DeskClient({ settings, role: 'main' });
    client.onChange(onChange);
    client.onEvent(onEvent);
    client.connect();
    chrome.idle.setDetectionInterval(Math.max(15, settings.idleMinutes * 60));
    chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
    chrome.alarms.create('weather', { periodInMinutes: 30 });
    refreshWeather();
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
  if (a.name === 'weather') refreshWeather();
});

// ------------------------------------------------------------------ state fan-out
function fullState(snap = client.snapshot()) {
  const { lastStatus, ...publicSettings } = settings;
  return { ...snap, settings: publicSettings, configured: client.configured, gchat: { available: true, seen: gchat.seen } };
}

// ------------------------------------------------------------------ weather (sky on the desk)
async function refreshWeather() {
  try {
    const w = await fetchWeather({ place: settings.weatherPlace, tz: settings.tz || Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (w) client.setWeather(w);
  } catch (e) { console.warn('weather', e.message || e); }
}

function onChange(snap) {
  // remember how big my plant is, so it survives a server restart
  if ((snap.me?.plant || 0) > (settings.plant || 0)) {
    settings.plant = snap.me.plant;
    client.settings.plant = snap.me.plant;
    chrome.storage.local.set({ plant: snap.me.plant });
  }
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
      chime('help');
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
      clearTimeout(meetFallbacks.get(e.id));
      // "End call" (or the asker cancelling) also leaves the Google Meet on this computer
      if (e.meetUrl && ['ended', 'cancelled', 'replaced'].includes(e.reason)) closeMeet(e.meetUrl);
      break;

    case 'kudos':
      if (!e.toMe || companionOwnsPopups) break;
      showBubble({ kind: 'kudos', id: newId(), from: e.from, name: e.fromName, color: snap.members.find(m => m.id === e.from)?.color, avatar: snap.members.find(m => m.id === e.from)?.avatar });
      break;

    case 'standup':
      // stand-up just started and I'm in it: a gong and a nudge to open the desk
      if (!e.started || !e.inIt || companionOwnsPopups) break;
      chime('standup');
      showBubble({ kind: 'standup', id: 'standup-' + e.standup.id, name: '', color: me?.color, avatar: me?.avatar })
        .then(shown => shown || notify(`standup:${e.standup.id}`, { title: 'Stand-up time 🧍', message: 'The team is gathering on the desk.', priority: 2 }));
      break;

    case 'wave':
      if (focused || companionOwnsPopups) break;
      showBubble({ kind: 'wave', id: newId(), from: e.from, name: e.fromName, emoji: e.emoji, color: snap.members.find(m => m.id === e.from)?.color, avatar: snap.members.find(m => m.id === e.from)?.avatar });
      break;

    case 'call:invite':
      if (companionOwnsPopups) break;
      if (!focused) chime('invite');
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

// Notification sound, played from a hidden offscreen page (service workers have no audio).
let offscreenReady = null;
async function chime(kind) {
  if (settings.sound === false || !chrome.offscreen) return;
  try {
    offscreenReady ||= (async () => {
      const url = chrome.runtime.getURL('offscreen/offscreen.html');
      const open = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
      if (!open?.length) await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Play a short sound when a teammate needs help' });
    })();
    await offscreenReady;
    await chrome.runtime.sendMessage({ type: 'deskmate:chime', kind });
  } catch (e) {
    offscreenReady = null; // e.g. Chrome closed the page: make it again next time
    console.warn('chime failed', e);
  }
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
  const url = `https://meet.google.com/${m[1]}`;
  rememberMeetTab(url, tabId);
  cb(url);
});

// Which tab shows which meeting. Kept in chrome.storage.session, not in memory: Chrome stops this
// service worker after ~30 s of quiet, and a meeting lasts much longer than that.
const meetCodeOf = (url) => (url || '').match(MEET_CODE)?.[1] || null;
async function meetTabMap() { return (await chrome.storage.session.get('meetTabs')).meetTabs || {}; }
async function rememberMeetTab(url, tabId) {
  const map = await meetTabMap();
  map[tabId] = `https://meet.google.com/${meetCodeOf(url)}`;
  await chrome.storage.session.set({ meetTabs: map });
}
async function forgetMeetTab(tabId) {
  const map = await meetTabMap();
  const url = map[tabId] || null;
  if (url) { delete map[tabId]; await chrome.storage.session.set({ meetTabs: map }); }
  return url;
}

// Leaving the meeting (Meet's Leave call button, closing its tab, or navigating away)
// ends the help request, which in turn closes the Meet for the other person.
async function leftMeet(url) {
  await init();
  // the worker may have just been woken up by this: wait for the connection to come back
  for (let i = 0; i < 40 && client.state.conn !== 'online'; i++) await new Promise(r => setTimeout(r, 250));
  client.endHelpByMeet(`https://meet.google.com/${meetCodeOf(url)}`);
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const url = await forgetMeetTab(tabId);
  if (url) leftMeet(url);
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const map = await meetTabMap();
  const url = map[tabId];
  if (!url || meetCodeOf(info.url) === meetCodeOf(url)) return;
  await forgetMeetTab(tabId); // went somewhere else in this tab
  leftMeet(url);
});

async function closeMeet(url) {
  const code = meetCodeOf(url);
  if (!code) return;
  const map = await meetTabMap();
  const ids = new Set(Object.keys(map).filter(id => meetCodeOf(map[id]) === code).map(Number));
  // also catch the meeting if it was opened by hand from the link
  try {
    for (const t of await chrome.tabs.query({ url: 'https://meet.google.com/*' })) {
      if (meetCodeOf(t.url || t.pendingUrl) === code) ids.add(t.id);
    }
  } catch {}
  // forget first, so closing these tabs isn't treated as "left"
  for (const id of ids) delete map[id];
  await chrome.storage.session.set({ meetTabs: map });
  for (const id of ids) chrome.tabs.remove(id).catch(() => {});
}
chrome.tabs.onRemoved.addListener((tabId) => meetWatch.delete(tabId));

async function openMeet(url) {
  if (!meetCodeOf(url)) return;
  const tab = await chrome.tabs.create({ url, active: true });
  await rememberMeetTab(url, tab.id);
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
    // not during a meeting (you're listening, not typing), unless the screen gets locked
    if (me.state === 'desk' || (s === 'locked' && me.state === 'meeting' && me.source !== 'manual')) client.setStatus('afk', { source: 'idle' });
  } else if (s === 'active') {
    if (me.state === 'afk' && me.source !== 'manual') client.setStatus('desk', { source: 'activity' });
    else if ((me.state === 'lunch' || me.state === 'brb') && settings.autoBack) client.setStatus('desk', { source: 'activity' });
  }
});

// ------------------------------------------------------------------ Google Chat status sync
// No Google API: content/gchat.js reads the status chip on an open Google Chat or Gmail tab
// ("Status: Active, In a meeting") and sends it here.
function mapChatStatus(availability = '', detail = '') {
  const a = availability.toLowerCase(), d = detail.toLowerCase();
  // a meeting wins over everything else: Google often switches you to Do not disturb during
  // meetings, but you're still at your desk, so show "In a meeting", not Focus
  if (/meeting|in a call|on a call|presenting|réunion|besprechung|reunión/.test(d)) return { state: 'meeting' };
  if (/do not disturb|dnd|ne pas déranger|nicht stören|no molestar/.test(a)) return { state: 'dnd', message: detail || undefined };
  if (/away|absent|abwesend|ausente/.test(a)) return { state: 'afk', message: detail || undefined };
  if (/focus/.test(d)) return { state: 'dnd', message: detail };
  if (/out of office|ooo/.test(d)) return { state: 'afk', message: detail };
  if (/active|available|actif|aktiv|activo|disponible/.test(a)) return { state: 'desk', message: detail || undefined };
  return null;
}

function applyChatStatus({ availability, detail }) {
  // (setting renamed from `gchat`, which older versions stored as off by default)
  if (settings.chatSync === false || !client?.state.me) return;
  const mapped = mapChatStatus(availability, detail);
  gchat.seen = { availability, detail, at: Date.now() };
  const key = mapped && `${mapped.state}|${mapped.message || ''}`;
  if (!mapped || key === gchat.last) return;
  gchat.last = key;
  const me = client.state.me;
  if (mapped.state === 'desk') {
    // Chat says "active": only pull you back if Deskmate had you away automatically or synced from Chat
    if (me.source === 'gchat' || (me.state === 'afk' && me.source !== 'manual')) client.setStatus('desk', { message: mapped.message, source: 'gchat' });
    return;
  }
  // the server keeps a Lunch / Focus / meeting you set yourself; Chat can't override it
  client.setStatus(mapped.state, { message: mapped.message, source: 'gchat' });
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
    case 'kudos': client.kudos(args.to); break;
    case 'standup:config': client.setStandup(args.standup); break;
    case 'standup:start': client.standupStart(); break;
    case 'standup:next': client.standupNext(); break;
    case 'standup:end': client.standupEnd(); break;
    case 'open-desk':
      chrome.windows.getLastFocused().then(w => chrome.sidePanel.open({ windowId: w.id })).catch(() => {});
      break;
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
    else if (msg.type === 'gchat:status') { applyChatStatus(msg); reply({ ok: true }); }
    else if (msg.type === 'meet:open') { if (sender.tab) await rememberMeetTab(msg.url, sender.tab.id); reply({ ok: true }); }
    else if (msg.type === 'meet:left') { if (sender.tab) await forgetMeetTab(sender.tab.id); await leftMeet(msg.url); reply({ ok: true }); }
    else if (msg.type === 'settings:save') {
      const next = { ...settings, ...msg.settings };
      // identity = work email, so the Chrome extension and the Mac app merge into one person
      next.userId = next.email ? next.email.toLowerCase() : (settings.userId || newId());
      const { lastStatus, ...persist } = next;
      await chrome.storage.sync.set({ settings: persist });
      const gchatTurnedOn = next.chatSync !== false && settings.chatSync === false;
      settings = next;
      chrome.idle.setDetectionInterval(Math.max(15, settings.idleMinutes * 60));
      client.updateSettings(settings);
      if (gchatTurnedOn) gchat.last = null;
      refreshWeather();
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
