// Deskmate for Mac — menu-bar companion.
// Lives in the menu bar, keeps you on the team desk even when Chrome is closed,
// and floats help/call bubbles over every app.
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, protocol, net, screen, dialog,
  powerMonitor, globalShortcut, session, systemPreferences, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { readMacFocus } from './macfocus.js';
import { DeskClient, newId } from './app/lib/client.js';
import { STATUS, DEFAULT_SERVER } from './app/lib/status.js';
import { fetchWeather } from './app/lib/weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, 'app');
const ASSETS = path.join(__dirname, 'assets');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  server: DEFAULT_SERVER, team: '', name: '', email: '', color: '#6C8CFF',
  avatar: { skin: '#F5D0B5', hair: '#2B2118', style: 'short' },
  idleMinutes: 5, lunchMinutes: 45, gchat: false, bubbles: true, sound: true, autoBack: true, callApp: 'meet', launchAtLogin: true,
};

let settings, client, tray, panel, callWin = null;
const bubbles = new Map(); // id -> BrowserWindow
let idleState = 'active';

if (process.env.DESKMATE_USER_DATA) app.setPath('userData', process.env.DESKMATE_USER_DATA);

// one instance only
if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ------------------------------------------------------------------ settings
function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch {}
  settings = { ...DEFAULTS, ...stored, avatar: { ...DEFAULTS.avatar, ...(stored.avatar || {}) } };
  if (!settings.userId) settings.userId = (settings.email || '').toLowerCase() || newId();
  settings.tz ||= Intl.DateTimeFormat().resolvedOptions().timeZone;
  // move old installs off the local development server onto the team's hosted one
  // (DESKMATE_SERVER=ws://localhost:8787 npm start still works for local development)
  if (process.env.DESKMATE_SERVER) settings.server = process.env.DESKMATE_SERVER;
  else if (!settings.serverMigrated) {   // once per install; choosing localhost again in Settings sticks
    if (/^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(settings.server || '')) settings.server = DEFAULT_SERVER;
    settings.serverMigrated = true;
    saveSettings();
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// ------------------------------------------------------------------ windows
const preload = path.join(__dirname, 'preload.cjs');
const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' };

function createPanel() {
  panel = new BrowserWindow({
    width: 400, height: 660, show: false, frame: false, resizable: false, movable: false,
    fullscreenable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    vibrancy: 'popover', visualEffectState: 'active', roundedCorners: true,
    backgroundColor: '#00000000', transparent: false, webPreferences,
  });
  panel.loadURL('app://deskmate/sidepanel/sidepanel.html');
  panel.on('blur', () => { if (!panel.webContents.isDevToolsOpened()) panel.hide(); });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function togglePanel() {
  if (panel.isVisible()) return panel.hide();
  const tb = tray.getBounds();
  const { width } = panel.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const wa = display.workArea;
  const x = Math.round(Math.min(Math.max(tb.x + tb.width / 2 - width / 2, wa.x + 8), wa.x + wa.width - width - 8));
  const y = Math.round(tb.y + tb.height + 6);
  panel.setPosition(x, process.platform === 'darwin' ? y : wa.y + 8);
  panel.show();
  panel.focus();
}

function showBubble(data) {
  if (!settings.bubbles || bubbles.has(data.id)) return;
  if (bubbles.size >= 3) bubbles.values().next().value.close();
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 380, H = 150;
  const w = new BrowserWindow({
    width: W, height: H, x: wa.x + wa.width - W - 4, y: wa.y + 8 + bubbles.size * (H - 18),
    frame: false, transparent: true, resizable: false, movable: false, show: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, fullscreenable: false, webPreferences,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const chime = settings.sound !== false && ['help', 'invite', 'standup'].includes(data.kind) ? data.kind : null;
  w.loadURL(`app://deskmate/bubble/bubble.html#${encodeURIComponent(JSON.stringify({ ...data, chime }))}`);
  w.once('ready-to-show', () => w.showInactive());
  w.on('closed', () => { bubbles.delete(data.id); restackBubbles(); });
  bubbles.set(data.id, w);
}
function restackBubbles() {
  const wa = screen.getPrimaryDisplay().workArea;
  let i = 0;
  for (const w of bubbles.values()) { if (!w.isDestroyed()) w.setPosition(wa.x + wa.width - 384, wa.y + 8 + i++ * 132); }
}
function toBubbles(msg) {
  for (const w of bubbles.values()) if (!w.isDestroyed()) w.webContents.send('bubble', msg);
}

async function openCall(callId, ring) {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  const url = `app://deskmate/call/call.html?id=${encodeURIComponent(callId)}${ring ? `&ring=${encodeURIComponent(ring)}` : ''}`;
  if (callWin && !callWin.isDestroyed()) {
    if (!callWin.webContents.getURL().includes(`id=${encodeURIComponent(callId)}`)) callWin.loadURL(url);
    callWin.show(); callWin.focus();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  callWin = new BrowserWindow({
    width: 360, height: 500, x: wa.x + wa.width - 376, y: wa.y + 40, title: 'Huddle',
    titleBarStyle: 'hiddenInset', alwaysOnTop: true, minimizable: true, resizable: true, minWidth: 300, minHeight: 380,
    webPreferences,
  });
  callWin.setAlwaysOnTop(true, 'floating');
  callWin.loadURL(url);
  callWin.on('closed', () => { callWin = null; });
}

// ------------------------------------------------------------------ state → UI
function fullState(snap = client.snapshot()) {
  const { lastStatus, ...pub } = settings;
  return { ...snap, settings: pub, configured: client.configured, gchat: { available: false } };
}

async function refreshWeather() {
  try {
    const w = await fetchWeather({ place: settings.weatherPlace, tz: settings.tz || Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (w) client.setWeather(w);
  } catch (e) { console.warn('[deskmate] weather', e.message || e); }
}

function onChange(snap) {
  // remember how big my plant is, so it survives a server restart
  if ((snap.me?.plant || 0) > (settings.plant || 0)) { settings.plant = snap.me.plant; client.settings.plant = snap.me.plant; saveSettings(); }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('state', fullState(snap));
  updateTray(snap);
}

function onEvent(e, snap) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('event', e);
  const me = snap.me;
  const focused = me?.state === 'dnd';
  switch (e.type) {
    case 'my-status':
      settings.lastStatus = { state: e.member.state, message: e.member.message, until: e.member.until, source: e.member.source };
      saveSettings();
      break;
    case 'help:new':
      if (e.mine || focused) break;
      if (e.help.to && me && !e.help.to.includes(me.id)) break;
      showBubble({ kind: 'help', id: e.help.id, name: e.help.fromName, topic: e.help.topic, color: e.help.color, avatar: e.help.avatar, urgency: e.help.urgency });
      break;
    case 'help:claimed':
      toBubbles({ type: 'bubble:update', id: e.id, claimedName: e.byName, byMe: e.byMe });
      // Google Meet calls are created and opened by the Chrome extension; the Mac app only
      // opens the link itself for people who don't have the extension running
      if (settings.callApp !== 'meet' && (e.byThisDevice || e.mine)) openCall(e.callId);
      break;
    case 'help:meet':
      if ((e.mine || e.helping) && !e.byMe && !me?.ext) openMeet(e.url);
      break;
    case 'help:closed':
      toBubbles({ type: 'bubble:close', id: e.id });
      break;
    case 'wave':
      if (focused) break;
      showBubble({ kind: 'wave', id: newId(), from: e.from, name: e.fromName, emoji: e.emoji, color: snap.members.find(m => m.id === e.from)?.color, avatar: snap.members.find(m => m.id === e.from)?.avatar });
      break;
    case 'call:invite':
      showBubble({ kind: 'invite', id: e.callId, url: e.url, from: e.from, name: e.fromName, color: e.color, avatar: e.avatar });
      break;
    case 'kudos':
      if (e.toMe) showBubble({ kind: 'kudos', id: newId(), from: e.from, name: e.fromName, color: snap.members.find(m => m.id === e.from)?.color, avatar: snap.members.find(m => m.id === e.from)?.avatar });
      break;
    case 'standup':
      if (e.started && e.inIt) showBubble({ kind: 'standup', id: 'standup-' + e.standup.id, name: '', color: me?.color, avatar: me?.avatar });
      break;
  }
}

function openMeet(url) {
  if (/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url || '')) shell.openExternal(url);
}

function trayImage(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  if (name === 'trayTemplate') img.setTemplateImage(true);
  return img;
}

function updateTray(snap) {
  if (!tray) return;
  const me = snap.me;
  const open = snap.helps.filter(h => !h.claimedBy && h.from !== me?.id);
  const others = snap.members.filter(m => m.id !== me?.id);
  const here = others.filter(m => STATUS[m.state]?.present).length;
  if (snap.conn !== 'online') {
    tray.setImage(trayImage('trayTemplate'));
    tray.setTitle(snap.conn === 'setup' ? '' : ' …');
    tray.setToolTip(snap.conn === 'setup' ? 'Deskmate — click to set up' : 'Deskmate — connecting…');
  } else if (open.length) {
    tray.setImage(trayImage('trayAlert'));
    tray.setTitle(` ${open[0].fromName.split(' ')[0]} needs help`);
    tray.setToolTip(`${open.length} teammate(s) asking for help`);
  } else {
    tray.setImage(trayImage('trayTemplate'));
    const myEmoji = me && me.state !== 'desk' ? `${STATUS[me.state]?.emoji} ` : '';
    tray.setTitle(` ${myEmoji}${here}`);
    tray.setToolTip(`Deskmate · ${snap.team}\n${here} at desk · ${others.filter(m => m.state === 'lunch').length} at lunch`);
  }
  tray.setContextMenu(null);
}

function contextMenu() {
  const me = client.state.me;
  const snap = client.snapshot();
  const status = (key) => ({
    label: `${STATUS[key].emoji}  ${STATUS[key].label}`, type: 'radio', checked: me?.state === key,
    click: () => act('status', { state: key }),
  });
  return Menu.buildFromTemplate([
    { label: 'Open team desk', click: togglePanel },
    { type: 'separator' },
    status('desk'), status('lunch'), status('brb'), status('dnd'), status('meeting'), status('leave'),
    { type: 'separator' },
    snap.myHelp
      ? { label: 'Cancel my help request', click: () => client.cancelHelp(snap.myHelp.id) }
      : { label: '🙋  Ask for help', accelerator: 'Alt+Shift+H', click: () => client.askHelp('') },
    { type: 'separator' },
    ...(macFocusLabel() ? [{ label: macFocusLabel(), enabled: false }] : []),
    { label: 'Match my Mac Focus', type: 'checkbox', checked: settings.macFocus !== false, click: (i) => { settings.macFocus = i.checked; saveSettings(); macFocus.on = false; pollMacFocus(); } },
    ...(settings.macFocus !== false && macFocus.error === 'permission' ? [{
      label: 'Allow Focus detection…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'),
    }] : []),
    { label: 'Launch at login', type: 'checkbox', checked: settings.launchAtLogin, click: (i) => { settings.launchAtLogin = i.checked; saveSettings(); applyLoginItem(); } },
    { label: 'Quit Deskmate', role: 'quit' },
  ]);
}

function applyLoginItem() {
  if (process.platform === 'darwin' || process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, openAsHidden: true });
}

// ------------------------------------------------------------------ actions (same names as the extension)
function act(name, args = {}) {
  const me = client.state.me;
  switch (name) {
    case 'status': {
      const s = args.state;
      const until = s === 'lunch' ? Date.now() + settings.lunchMinutes * 60000 : s === 'brb' ? Date.now() + 10 * 60000 : null;
      client.setStatus(s, { until, message: args.message });
      break;
    }
    case 'note': if (me) client.setStatus(me.state, { message: args.message, until: me.until }); break;
    case 'lunch:extend': if (me) client.setStatus(me.state, { until: Math.max(me.until || Date.now(), Date.now()) + (args.minutes || 15) * 60000, message: me.message }); break;
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
    case 'open-desk': if (!panel.isVisible()) togglePanel(); break;
    case 'call': { const callId = newId(); client.invite(args.to, callId); openCall(callId, args.to); break; }
    case 'call:join': {
      const url = args.url || client.state.helps[args.callId]?.meetUrl || client.snapshot().calls.find(c => c.callId === args.callId)?.url;
      if (url) openMeet(url); else openCall(args.callId);
      break;
    }
    case 'call:accept': if (args.url) openMeet(args.url); else openCall(args.callId); break;
    case 'call:decline': client.decline(args.from, args.callId); break;
  }
}

// ------------------------------------------------------------------ auto-away (system idle + screen lock)
// ------------------------------------------------------------------ macOS Focus → Deskmate Focus
let macFocus = { on: false, error: null, detail: null, name: null, checked: false };
let askedForAccess = false;
async function pollMacFocus() {
  if (process.platform !== 'darwin' || settings.macFocus === false) return;
  const f = await readMacFocus();
  const prevErr = macFocus.error;
  macFocus.checked = true;
  macFocus.error = f.error || null;
  macFocus.detail = f.detail || null;
  if (f.error !== prevErr) console.log('[deskmate] Mac Focus detection:', f.error ? `${f.error} (${f.detail})` : 'ok');
  if (f.error === 'permission' && !askedForAccess) { askedForAccess = true; askForFocusAccess(); }
  if (f.error) return;
  macFocus.name = f.name;
  const me = client.state.me;
  if (!me || f.on === macFocus.on) { macFocus.on = f.on; return; }
  macFocus.on = f.on;
  if (f.on && me.state !== 'dnd' && me.state !== 'meeting') {
    // in a meeting you stay "In a meeting" (Macs often turn on Do Not Disturb while you present)
    // the server ignores this if you set lunch / a meeting yourself
    client.setStatus('dnd', { source: 'macfocus', message: f.name && f.name !== 'Do Not Disturb' ? `${f.name} focus` : undefined });
  } else if (!f.on && me.state === 'dnd' && me.source === 'macfocus') {
    client.setStatus('desk', { source: 'macfocus' });
  }
}

// macOS only lets apps with Full Disk Access read the Focus state. Explain once, and open the right settings page.
function askForFocusAccess() {
  const appName = app.isPackaged ? 'Deskmate' : 'Electron (Deskmate runs inside it while in development)';
  dialog.showMessageBox({
    type: 'info',
    message: 'Let Deskmate see your Mac Focus',
    detail: `To switch you to Focus automatically when your Mac is in Do Not Disturb, macOS needs you to allow it:\n\nSystem Settings → Privacy & Security → Full Disk Access → turn on “${appName}”.\n\nThen quit and reopen Deskmate.`,
    buttons: ['Open System Settings', 'Not now'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  });
}

function macFocusLabel() {
  if (process.platform !== 'darwin') return null;
  if (settings.macFocus === false) return 'Mac Focus sync: off';
  if (!macFocus.checked) return 'Mac Focus: checking…';
  if (macFocus.error === 'permission') return 'Mac Focus: needs Full Disk Access';
  if (macFocus.error) return `Mac Focus: can’t read (${macFocus.detail})`;
  return macFocus.on ? `Mac Focus: on${macFocus.name ? ` (${macFocus.name})` : ''}` : 'Mac Focus: off';
}

function onIdleChange(s) {
  if (s === idleState) return;
  idleState = s;
  const me = client.state.me;
  if (!me) return;
  if (s === 'idle' || s === 'locked') {
    if (me.state === 'desk') client.setStatus('afk', { source: 'idle' });
  } else if (s === 'active') {
    if (me.state === 'afk' && me.source !== 'manual') client.setStatus('desk', { source: 'activity' });
    else if ((me.state === 'lunch' || me.state === 'brb') && settings.autoBack) client.setStatus('desk', { source: 'activity' });
  }
}

// ------------------------------------------------------------------ IPC
ipcMain.handle('get-state', () => fullState());
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (_e, next) => {
  const loginChanged = next.launchAtLogin !== undefined && next.launchAtLogin !== settings.launchAtLogin;
  settings = { ...settings, ...next };
  settings.userId = settings.email ? settings.email.toLowerCase() : settings.userId;
  saveSettings();
  client.updateSettings(settings);
  if (loginChanged) applyLoginItem();
  refreshWeather();
  onChange(client.snapshot());
  return { ok: true };
});
ipcMain.handle('profile', () => ({ email: '' }));
ipcMain.handle('call-config', () => {
  const snap = client.snapshot();
  const { server, team, userId, name, email, color, avatar, tz } = settings;
  return { settings: { server, team, userId, name, email, color, avatar, tz }, members: snap.members, me: snap.me };
});
ipcMain.on('action', (_e, name, args) => act(name, args));
ipcMain.on('close-window', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w === panel) panel.hide(); else w?.close();
});

// ------------------------------------------------------------------ boot
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();

  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write');

  loadSettings();
  applyLoginItem();
  client = new DeskClient({ settings, role: 'companion', WebSocketImpl: WebSocket });
  client.onChange(onChange);
  client.onEvent(onEvent);

  tray = new Tray(trayImage('trayTemplate'));
  tray.setToolTip('Deskmate');
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));
  createPanel();
  client.connect();
  if (!client.configured) panel.webContents.once('did-finish-load', togglePanel);

  // system idle → Away; lock screen → Away immediately
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime();
    onIdleChange(idle >= settings.idleMinutes * 60 ? 'idle' : 'active');
  }, 15000);
  powerMonitor.on('lock-screen', () => onIdleChange('locked'));
  setInterval(pollMacFocus, 5000);
  setInterval(refreshWeather, 30 * 60 * 1000);
  refreshWeather();
  setTimeout(pollMacFocus, 1500);
  powerMonitor.on('unlock-screen', () => onIdleChange('active'));
  powerMonitor.on('resume', () => client.connect());

  // global shortcuts, same keys as the Chrome extension
  const keys = {
    'Alt+Shift+D': togglePanel,
    'Alt+Shift+H': () => { const mine = client.snapshot().myHelp; mine ? client.cancelHelp(mine.id) : client.askHelp(''); },
    'Alt+Shift+L': () => act('status', { state: client.state.me?.state === 'lunch' ? 'desk' : 'lunch' }),
    'Alt+Shift+F': () => act('status', { state: client.state.me?.state === 'dnd' ? 'desk' : 'dnd' }),
  };
  for (const [k, fn] of Object.entries(keys)) { try { globalShortcut.register(k, fn); } catch {} }

  // automated smoke test hook
  globalThis.deskmate = { get client() { return client; }, get panel() { return panel; }, bubbles, togglePanel, act, get callWin() { return callWin; } };
  if (process.env.DESKMATE_SMOKE) import(pathToFileURL(process.env.DESKMATE_SMOKE).toString());
});

app.on('second-instance', () => togglePanel());
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault()); // keep living in the menu bar
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});
