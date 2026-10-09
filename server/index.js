// Deskmate presence + signaling server
// One WebSocket endpoint. Teams are rooms keyed by team code.
// Holds no database: state lives in memory and rebuilds as clients reconnect.

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS || 20000); // survive MV3 worker restarts
const HELP_TTL_MS = Number(process.env.HELP_TTL_MS || 10 * 60 * 1000);
const MAX_CALL_SIZE = Number(process.env.MAX_CALL_SIZE || 6);
// Optional allow-list: TEAM_CODES="design-team,ops-team". Empty = any code works.
const TEAM_CODES = (process.env.TEAM_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional email domain lock, e.g. ALLOWED_DOMAIN=elevationservices.co.uk
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').toLowerCase();
// ICE servers handed to clients. Add TURN for corporate networks.
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const STATES = new Set(['desk', 'lunch', 'afk', 'dnd', 'meeting', 'brb']);

/** teams: code -> { members: Map<userId, Member>, helps: Map<id, Help>, calls: Map<callId, Set<socketId>> } */
const teams = new Map();
/** sockets: socketId -> ws */
const sockets = new Map();

const id = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);

function team(code) {
  if (!teams.has(code)) teams.set(code, { members: new Map(), helps: new Map(), calls: new Map() });
  return teams.get(code);
}

function publicMember(m) {
  return {
    id: m.id, name: m.name, email: m.email, color: m.color, avatar: m.avatar, tz: m.tz,
    state: m.state, message: m.message, until: m.until, since: m.since,
    online: m.online, inCall: m.inCall || null, source: m.source, seat: m.seat,
    companion: [...(m.sockets || [])].some(sid => sockets.get(sid)?.meta.role === 'companion'),
    ext: [...(m.sockets || [])].some(sid => sockets.get(sid)?.meta.role === 'main'),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(code, msg, { exceptSocket, roles } = {}) {
  const t = teams.get(code);
  if (!t) return;
  for (const m of t.members.values()) {
    for (const sid of m.sockets) {
      if (sid === exceptSocket) continue;
      const ws = sockets.get(sid);
      if (!ws) continue;
      if (roles && !roles.includes(ws.meta.role)) continue;
      send(ws, msg);
    }
  }
}

function toUser(code, userId, msg, { includeCall = false } = {}) {
  const m = teams.get(code)?.members.get(userId);
  if (!m) return;
  for (const sid of m.sockets) {
    const ws = sockets.get(sid);
    if (ws && (includeCall || ws.meta.role !== 'call')) send(ws, msg);
  }
}

function nextSeat(t) {
  const taken = new Set([...t.members.values()].map(m => m.seat));
  let s = 0;
  while (taken.has(s)) s++;
  return s;
}

const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
function snapshotCalls(t) {
  const calls = [...t.calls.entries()].map(([callId, set]) => ({
    callId,
    participants: [...new Set([...set].map(sid => sockets.get(sid)?.meta.userId).filter(Boolean))],
  }));
  // help requests that moved to Google Meet count as calls between asker and helper
  for (const h of t.helps.values()) {
    if (h.meetUrl && h.claimedBy) calls.push({ callId: h.id, url: h.meetUrl, participants: [h.from, h.claimedBy] });
  }
  return calls;
}

function announceCalls(code) {
  const t = teams.get(code);
  if (!t) return;
  // derive inCall for each member
  const inCall = new Map();
  for (const c of snapshotCalls(t)) for (const u of c.participants) inCall.set(u, c.callId);
  for (const m of t.members.values()) {
    const v = inCall.get(m.id) || null;
    if (m.inCall !== v) {
      m.inCall = v;
      broadcast(code, { type: 'presence', member: publicMember(m) });
    }
  }
  broadcast(code, { type: 'calls', calls: snapshotCalls(t) }, { roles: ['main', 'companion'] });
}

function leaveCall(ws) {
  const { team: code, callId, socketId } = ws.meta;
  if (!callId) return;
  const t = teams.get(code);
  const set = t?.calls.get(callId);
  ws.meta.callId = null;
  if (!set) return;
  set.delete(socketId);
  for (const sid of set) send(sockets.get(sid), { type: 'call:peer-left', peerId: socketId });
  if (set.size === 0) t.calls.delete(callId);
  announceCalls(code);
}

function closeHelp(code, helpId, reason) {
  const t = teams.get(code);
  const h = t?.helps.get(helpId);
  if (!h) return;
  clearTimeout(h.timer);
  t.helps.delete(helpId);
  broadcast(code, { type: 'help:closed', id: helpId, reason }, { roles: ['main', 'companion'] });
  if (h.meetUrl) announceCalls(code);
}

function helpPublic(h) {
  const { timer, ...rest } = h;
  return rest;
}

function handle(ws, msg) {
  const meta = ws.meta;

  if (msg.type === 'hello') {
    const code = clean(msg.team, 64).toLowerCase();
    const u = msg.user || {};
    const email = clean(u.email, 120).toLowerCase();
    if (!code) return send(ws, { type: 'error', error: 'team_required' });
    if (TEAM_CODES.length && !TEAM_CODES.includes(code)) return send(ws, { type: 'error', error: 'unknown_team' });
    if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) return send(ws, { type: 'error', error: 'domain_not_allowed' });
    const userId = clean(u.id, 64) || email || id();
    meta.team = code;
    meta.userId = userId;
    meta.role = ['main', 'call', 'companion'].includes(msg.role) ? msg.role : 'main';

    const t = team(code);
    let m = t.members.get(userId);
    if (!m) {
      m = { id: userId, sockets: new Set(), seat: nextSeat(t), state: 'desk', since: now(), inCall: null };
      t.members.set(userId, m);
    }
    Object.assign(m, {
      name: clean(u.name, 40) || 'Teammate',
      email,
      color: clean(u.color, 9) || '#6C8CFF',
      avatar: u.avatar && typeof u.avatar === 'object' ? {
        skin: clean(u.avatar.skin, 9), hair: clean(u.avatar.hair, 9), style: clean(u.avatar.style, 12), glasses: clean(u.avatar.glasses, 12), model: clean(u.avatar.model, 32),
      } : m.avatar,
      tz: clean(u.tz, 48),
    });
    clearTimeout(m.offlineTimer);
    m.sockets.add(meta.socketId);
    if (meta.role !== 'call') {
      const wasOnline = m.online;
      m.online = true;
      if (msg.status && STATES.has(msg.status.state) && !wasOnline) {
        m.state = msg.status.state;
        m.message = clean(msg.status.message, 80);
        m.until = Number(msg.status.until) || null;
        m.since = now();
        m.source = clean(msg.status.source, 16) || 'manual';
      }
    }
    send(ws, {
      type: 'welcome',
      socketId: meta.socketId,
      me: publicMember(m),
      members: [...t.members.values()].filter(x => x.online).map(publicMember),
      helps: [...t.helps.values()].map(helpPublic),
      calls: snapshotCalls(t),
      iceServers: ICE_SERVERS,
    });
    if (meta.role !== 'call') broadcast(code, { type: 'presence', member: publicMember(m) }, { exceptSocket: meta.socketId });
    return;
  }

  if (!meta.team) return send(ws, { type: 'error', error: 'hello_first' });
  const t = teams.get(meta.team);
  const me = t.members.get(meta.userId);

  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong', t: msg.t });

    case 'status': {
      if (!STATES.has(msg.state)) return;
      // Don't let an automatic source (idle / Google Chat) override a manual lunch/dnd
      const source = clean(msg.source, 16) || 'manual';
      // Rules for automatic updates (idle detector, Google Chat sync):
      //  - manual DND / meeting are sticky until the person changes them
      //  - manual lunch / brb only end automatically when the person is active again
      if (source !== 'manual' && me.source === 'manual') {
        if (['dnd', 'meeting'].includes(me.state)) return;
        if (['lunch', 'brb'].includes(me.state) && !(msg.state === 'desk' && source === 'activity')) return;
      }
      const changed = me.state !== msg.state;
      me.state = msg.state;
      me.message = msg.message !== undefined ? clean(msg.message, 80) : (changed ? '' : me.message);
      me.until = Number(msg.until) || null;
      me.source = source;
      if (changed) me.since = now();
      return broadcast(meta.team, { type: 'presence', member: publicMember(me) });
    }

    case 'help': {
      // one open request per person
      for (const h of t.helps.values()) if (h.from === me.id) closeHelp(meta.team, h.id, 'replaced');
      const h = {
        id: id(), from: me.id, fromName: me.name, color: me.color, avatar: me.avatar,
        topic: clean(msg.topic, 140), urgency: ['low', 'normal', 'high'].includes(msg.urgency) ? msg.urgency : 'normal',
        to: Array.isArray(msg.to) ? msg.to.map(x => clean(x, 64)).slice(0, 20) : null,
        ts: now(), claimedBy: null,
      };
      h.timer = setTimeout(() => closeHelp(meta.team, h.id, 'expired'), HELP_TTL_MS);
      t.helps.set(h.id, h);
      return broadcast(meta.team, { type: 'help:new', help: helpPublic(h) }, { roles: ['main', 'companion'] });
    }

    case 'help:claim': {
      const h = t.helps.get(msg.id);
      if (!h) return send(ws, { type: 'help:gone', id: msg.id });
      if (h.claimedBy && h.claimedBy !== me.id) return send(ws, { type: 'help:taken', id: h.id, by: h.claimedBy });
      if (h.from === me.id) return;
      h.claimedBy = me.id;
      h.claimedName = me.name;
      clearTimeout(h.timer);
      // keep the request around briefly so late viewers see "X is on it", then close
      h.timer = setTimeout(() => closeHelp(meta.team, h.id, 'claimed'), 60 * 1000);
      broadcast(meta.team, { type: 'help:claimed', id: h.id, by: me.id, byName: me.name, bySocket: meta.socketId, callId: h.id }, { roles: ['main', 'companion'] });
      return;
    }

    case 'help:meet': {
      // the helper (or asker) created a Google Meet for this request: share it, keep the request open until "End call"
      const h = t.helps.get(msg.id);
      const url = clean(msg.url, 80);
      if (!h || !MEET_RE.test(url) || (h.from !== me.id && h.claimedBy !== me.id) || h.meetUrl) return;
      h.meetUrl = url;
      clearTimeout(h.timer);
      h.timer = setTimeout(() => closeHelp(meta.team, h.id, 'expired'), 3 * 60 * 60 * 1000);
      broadcast(meta.team, { type: 'help:meet', id: h.id, url, by: me.id }, { roles: ['main', 'companion'] });
      announceCalls(meta.team);
      return;
    }

    case 'help:end': {
      // asker or helper hangs up: close the request and end the huddle for everyone in it
      const h = t.helps.get(msg.id);
      if (!h || (h.from !== me.id && h.claimedBy !== me.id)) return;
      for (const sid of t.calls.get(h.id) || []) send(sockets.get(sid), { type: 'call:end', callId: h.id, byName: me.name });
      closeHelp(meta.team, h.id, 'ended');
      return;
    }

    case 'help:cancel': {
      const h = t.helps.get(msg.id);
      if (h && h.from === me.id) closeHelp(meta.team, h.id, 'cancelled');
      return;
    }

    case 'wave': {
      const to = clean(msg.to, 64);
      return toUser(meta.team, to, { type: 'wave', from: me.id, fromName: me.name, emoji: clean(msg.emoji, 8) || '👋' });
    }

    case 'call:invite': {
      // direct call: tell the invitee there is a call waiting for them
      const to = clean(msg.to, 64);
      const callId = clean(msg.callId, 32) || id();
      const meetUrl = MEET_RE.test(clean(msg.url, 80)) ? clean(msg.url, 80) : null;
      toUser(meta.team, to, { type: 'call:invite', callId, url: meetUrl, from: me.id, fromName: me.name, color: me.color, avatar: me.avatar });
      return send(ws, { type: 'call:invited', callId, to });
    }

    case 'call:decline': {
      return toUser(meta.team, clean(msg.to, 64), { type: 'call:declined', callId: clean(msg.callId, 32), by: me.id, byName: me.name }, { includeCall: true });
    }

    case 'call:join': {
      const callId = clean(msg.callId, 32);
      if (!callId) return;
      if (meta.callId) leaveCall(ws);
      let set = t.calls.get(callId);
      if (!set) { set = new Set(); t.calls.set(callId, set); }
      if (set.size >= MAX_CALL_SIZE) return send(ws, { type: 'error', error: 'call_full' });
      const peers = [...set].map(sid => {
        const p = sockets.get(sid);
        const pm = p && t.members.get(p.meta.userId);
        return pm && { peerId: sid, user: publicMember(pm) };
      }).filter(Boolean);
      set.add(meta.socketId);
      meta.callId = callId;
      send(ws, { type: 'call:peers', callId, peers, iceServers: ICE_SERVERS });
      for (const p of peers) send(sockets.get(p.peerId), { type: 'call:peer-joined', peerId: meta.socketId, user: publicMember(me) });
      announceCalls(meta.team);
      return;
    }

    case 'call:signal': {
      const target = sockets.get(msg.to);
      if (!target || target.meta.callId !== meta.callId || !meta.callId) return;
      return send(target, { type: 'call:signal', from: meta.socketId, data: msg.data });
    }

    case 'call:mute': {
      if (!meta.callId) return;
      for (const sid of t.calls.get(meta.callId) || []) if (sid !== meta.socketId) send(sockets.get(sid), { type: 'call:mute', peerId: meta.socketId, muted: !!msg.muted });
      return;
    }

    case 'call:leave':
      return leaveCall(ws);

    case 'react': {
      // emoji reaction floating above my avatar on everyone's desk
      return broadcast(meta.team, { type: 'react', from: me.id, emoji: clean(msg.emoji, 8) }, { roles: ['main', 'companion'] });
    }
  }
}

function onClose(ws) {
  const { team: code, userId, socketId } = ws.meta;
  sockets.delete(socketId);
  if (!code) return;
  leaveCall(ws);
  const t = teams.get(code);
  const m = t?.members.get(userId);
  if (!m) return;
  m.sockets.delete(socketId);
  const stillPresent = [...m.sockets].some(sid => sockets.get(sid)?.meta.role !== 'call');
  if (stillPresent) {
    broadcast(code, { type: 'presence', member: publicMember(m) });
    return;
  }
  clearTimeout(m.offlineTimer);
  m.offlineTimer = setTimeout(() => {
    if ([...m.sockets].some(sid => sockets.get(sid)?.meta.role !== 'call')) return;
    m.online = false;
    broadcast(code, { type: 'leave', userId });
    for (const h of t.helps.values()) if (h.from === userId) closeHelp(code, h.id, 'offline');
    // free the seat if nobody is using it after a while
    setTimeout(() => {
      if (!m.online && m.sockets.size === 0) t.members.delete(userId);
      if (t.members.size === 0 && t.calls.size === 0) teams.delete(code);
    }, 60 * 60 * 1000).unref?.();
  }, OFFLINE_GRACE_MS);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, teams: teams.size, sockets: sockets.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Deskmate server. Connect via WebSocket.');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.meta = { socketId: id(), team: null, userId: null, role: 'main', callId: null };
  ws.isAlive = true;
  sockets.set(ws.meta.socketId, ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

server.listen(PORT, () => console.log(`Deskmate server on :${PORT}`));
