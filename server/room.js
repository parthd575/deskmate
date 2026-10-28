// Deskmate room: everything for ONE team code (presence, help requests, calls).
// Transport-agnostic, so the same logic runs in the Node server (server/index.js) and in a
// Cloudflare Durable Object (cloudflare/worker.js).
//
// The host gives the room a `sockets` Map: socketId -> conn, where conn is
//   { meta: { socketId, team, userId, role, callId }, send(obj), save?() }
// `save()` lets a host persist conn.meta (Cloudflare keeps it on the socket across hibernation).
//
// Timers are plain data ({ at, kind, a }), not setTimeout callbacks, so the whole room can be
// saved and restored. The host calls runDue() when the earliest timer (nextDue()) is reached.

export const DEFAULTS = {
  OFFLINE_GRACE_MS: 20000, // survive MV3 worker restarts and reconnects
  HELP_TTL_MS: 10 * 60 * 1000,
  MAX_CALL_SIZE: 6,
  TEAM_CODES: [],
  ALLOWED_DOMAIN: '',
  ICE_SERVERS: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

const STATES = new Set(['desk', 'lunch', 'afk', 'dnd', 'meeting', 'brb', 'leave']);
// who joins a scheduled stand-up: people at their desk or focusing (not away, at lunch, BRB,
// on leave, in another meeting, or offline)
const STANDUP_STATES = new Set(['desk', 'dnd']);
const PETS = new Set(['', 'none', 'cat', 'dog', 'chick', 'lion', 'tiger']);
const KUDOS_GAP_MS = 10 * 60 * 1000;   // one kudos per person per teammate every 10 minutes
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- stand-up schedule: "09:30 on Mon–Fri in Europe/London" → the next time that happens
function zoned(t, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, min: +parts.minute, s: +parts.second, wd: WEEKDAYS.indexOf(parts.weekday) };
}
function zonedToUtc(y, m, d, h, min, tz) {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {          // correct for the zone's offset (twice, for DST edges)
    const z = zoned(t, tz);
    t -= Date.UTC(z.y, z.m - 1, z.d, z.h, z.min) - Date.UTC(y, m - 1, d, h, min);
  }
  return t;
}
export function nextStandup(cfg, from = Date.now()) {
  if (!cfg?.enabled) return null;
  const [h, min] = cfg.time.split(':').map(Number);
  for (let k = 0; k <= 7; k++) {
    const z = zoned(from + k * 86400000, cfg.tz);
    if (!cfg.days.includes(z.wd)) continue;
    const at = zonedToUtc(z.y, z.m, z.d, h, min, cfg.tz);
    if (at > from + 1000) return at;
  }
  return null;
}
function cleanStandup(c) {
  if (!c || typeof c !== 'object') return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(c.time) ? c.time : '09:30';
  const days = Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter(d => d >= 0 && d <= 6))] : [1, 2, 3, 4, 5];
  let tz = clean(c.tz, 48) || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  const perPerson = Math.min(300, Math.max(20, Number(c.perPerson) || 60));
  return { enabled: !!c.enabled, time, days, tz, perPerson };
}
const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const CLAIM_LINGER_MS = 60 * 1000;
const MEET_TTL_MS = 3 * 60 * 60 * 1000;
const SEAT_GC_MS = 60 * 60 * 1000;

// bump when clients need a newer server (clients warn "server out of date")
export const PROTOCOL = 3;

export const newId = () => {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
};
const now = () => Date.now();
export const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
export const teamCode = (s) => clean(s, 64).toLowerCase();

export function configFromEnv(env = {}) {
  const num = (k) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : DEFAULTS[k]);
  return {
    OFFLINE_GRACE_MS: num('OFFLINE_GRACE_MS'),
    HELP_TTL_MS: num('HELP_TTL_MS'),
    MAX_CALL_SIZE: num('MAX_CALL_SIZE'),
    // Optional allow-list: TEAM_CODES="design-team,ops-team". Empty = any code works.
    TEAM_CODES: String(env.TEAM_CODES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // Optional email domain lock, e.g. ALLOWED_DOMAIN=elevationservices.co.uk
    ALLOWED_DOMAIN: String(env.ALLOWED_DOMAIN || '').toLowerCase(),
    // ICE servers for built-in audio calls. Add TURN for corporate networks.
    ICE_SERVERS: env.ICE_SERVERS ? JSON.parse(env.ICE_SERVERS) : DEFAULTS.ICE_SERVERS,
  };
}

export class Room {
  constructor({ code, sockets, config = DEFAULTS, saved = null }) {
    this.code = code;
    this.sockets = sockets;
    this.cfg = { ...DEFAULTS, ...config };
    this.members = new Map(); // userId -> member (member.sockets: Set<socketId>)
    this.helps = new Map();   // helpId -> help
    this.calls = new Map();   // callId -> Set<socketId>   (built-in audio calls)
    this.timers = {};         // key -> { at, kind, a }
    this.stats = {};          // userId -> { points, helped, kudos }  (the desk plant; kept when people leave)
    this.team = { standup: null };   // team-wide settings
    this.standup = null;      // the stand-up happening right now
    this.kudosAt = {};        // "from>to" -> last time (in memory only)
    this.direct = {};         // callId -> direct call { id, from, to, host, url, at }  (Google Meet calls)
    if (saved) this.#restore(saved);
  }

  // ------------------------------------------------------------ save / restore
  serialize() {
    return JSON.stringify({
      members: [...this.members.values()].map(m => ({ ...m, sockets: [...m.sockets] })),
      helps: [...this.helps.values()],
      calls: [...this.calls.entries()].map(([id, set]) => [id, [...set]]),
      timers: this.timers,
      stats: this.stats,
      team: this.team,
      standup: this.standup,
      direct: this.direct,
    });
  }

  #restore(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    for (const m of s.members || []) this.members.set(m.id, { ...m, sockets: new Set(m.sockets) });
    for (const h of s.helps || []) this.helps.set(h.id, h);
    for (const [id, sids] of s.calls || []) this.calls.set(id, new Set(sids));
    this.timers = s.timers || {};
    this.stats = s.stats || {};
    this.team = s.team || { standup: null };
    this.standup = s.standup || null;
    this.direct = s.direct || {};
    // Sockets can be gone after a restart (e.g. a deploy): drop them, and give anyone left
    // without a connection the usual grace period to reconnect.
    for (const m of this.members.values()) {
      for (const sid of m.sockets) if (!this.sockets.has(sid)) m.sockets.delete(sid);
      if (m.online && !this.#present(m) && !this.timers[`offline:${m.id}`]) this.#timer(`offline:${m.id}`, this.cfg.OFFLINE_GRACE_MS, 'offline', m.id);
    }
    for (const [id, set] of this.calls) {
      for (const sid of set) if (!this.sockets.has(sid)) set.delete(sid);
      if (!set.size) this.calls.delete(id);
    }
  }

  // nothing worth keeping: team settings and plants keep a room alive
  isEmpty() {
    return this.members.size === 0 && this.calls.size === 0 && !this.team.standup && Object.keys(this.stats).length === 0;
  }

  // ------------------------------------------------------------ timers
  #timer(key, ms, kind, a = null) { this.timers[key] = { at: now() + ms, kind, a }; }
  #clear(key) { delete this.timers[key]; }
  nextDue() {
    let at = Infinity;
    for (const t of Object.values(this.timers)) at = Math.min(at, t.at);
    return at === Infinity ? null : at;
  }
  runDue(t = now()) {
    for (const [key, timer] of Object.entries(this.timers)) {
      if (timer.at > t) continue;
      delete this.timers[key];
      try { this.#fire(timer); } catch (e) { console.error('timer error', e); }
    }
  }
  #fire({ kind, a }) {
    if (kind === 'help') return this.#closeHelp(a.id, a.reason);
    if (kind === 'offline') {
      const m = this.members.get(a);
      if (!m || this.#present(m)) return;
      m.online = false;
      this.#broadcast({ type: 'leave', userId: m.id });
      for (const h of [...this.helps.values()]) if (h.from === m.id) this.#closeHelp(h.id, 'offline');
      // free the seat if nobody is using it after a while
      this.#timer(`gc:${m.id}`, SEAT_GC_MS, 'gc', m.id);
      return;
    }
    if (kind === 'standup') {
      this.#scheduleStandup();
      return this.#startStandup('schedule');
    }
    if (kind === 'standupTurn') return this.#nextTurn(a);
    if (kind === 'direct') return this.#endDirect(a, 'expired');
    if (kind === 'gc') {
      const m = this.members.get(a);
      if (m && !m.online && m.sockets.size === 0) this.members.delete(a);
    }
  }

  // ------------------------------------------------------------ helpers
  #present(m) { return [...m.sockets].some(sid => this.sockets.get(sid) && this.sockets.get(sid).meta.role !== 'call'); }

  #public(m) {
    const roles = [...m.sockets].map(sid => this.sockets.get(sid)?.meta.role);
    return {
      id: m.id, name: m.name, email: m.email, color: m.color, avatar: m.avatar, tz: m.tz,
      state: m.state, message: m.message, until: m.until, since: m.since,
      online: m.online, inCall: m.inCall || null, source: m.source, seat: m.seat,
      weather: m.weather || null,
      plant: this.stats[m.id]?.points || 0,
      helped: this.stats[m.id]?.helped || 0,
      kudos: this.stats[m.id]?.kudos || 0,
      companion: roles.includes('companion'),
      ext: roles.includes('main'),
    };
  }

  #send(conn, msg) { if (conn) try { conn.send(msg); } catch {} }

  #broadcast(msg, { exceptSocket, roles } = {}) {
    for (const m of this.members.values()) {
      for (const sid of m.sockets) {
        if (sid === exceptSocket) continue;
        const conn = this.sockets.get(sid);
        if (!conn || (roles && !roles.includes(conn.meta.role))) continue;
        this.#send(conn, msg);
      }
    }
  }

  #toUser(userId, msg, { includeCall = false } = {}) {
    const m = this.members.get(userId);
    if (!m) return;
    for (const sid of m.sockets) {
      const conn = this.sockets.get(sid);
      if (conn && (includeCall || conn.meta.role !== 'call')) this.#send(conn, msg);
    }
  }

  #nextSeat() {
    const taken = new Set([...this.members.values()].map(m => m.seat));
    let s = 0;
    while (taken.has(s)) s++;
    return s;
  }

  #snapshotCalls() {
    const calls = [...this.calls.entries()].map(([callId, set]) => ({
      callId,
      participants: [...new Set([...set].map(sid => this.sockets.get(sid)?.meta.userId).filter(Boolean))],
    }));
    // help requests that moved to Google Meet count as calls between asker and helper
    for (const h of this.helps.values()) {
      if (h.meetUrl && h.claimedBy) calls.push({ callId: h.id, url: h.meetUrl, participants: [h.from, h.claimedBy] });
    }
    // direct calls once someone has accepted and the Meet link exists
    for (const c of Object.values(this.direct)) {
      if (c.url && c.accepted) calls.push({ callId: c.id, url: c.url, participants: [c.from, c.to] });
    }
    return calls;
  }

  #announceCalls() {
    const inCall = new Map();
    for (const c of this.#snapshotCalls()) for (const u of c.participants) inCall.set(u, c.callId);
    for (const m of this.members.values()) {
      const v = inCall.get(m.id) || null;
      if (m.inCall !== v) {
        m.inCall = v;
        this.#broadcast({ type: 'presence', member: this.#public(m) });
      }
    }
    this.#broadcast({ type: 'calls', calls: this.#snapshotCalls() }, { roles: ['main', 'companion'] });
  }

  #leaveCall(conn) {
    const { callId, socketId } = conn.meta;
    if (!callId) return;
    conn.meta.callId = null;
    conn.save?.();
    const set = this.calls.get(callId);
    if (!set) return;
    set.delete(socketId);
    for (const sid of set) this.#send(this.sockets.get(sid), { type: 'call:peer-left', peerId: socketId });
    if (set.size === 0) this.calls.delete(callId);
    this.#announceCalls();
  }

  #closeHelp(helpId, reason) {
    const h = this.helps.get(helpId);
    if (!h) return;
    this.#clear(`help:${helpId}`);
    this.helps.delete(helpId);
    this.#broadcast({ type: 'help:closed', id: helpId, reason }, { roles: ['main', 'companion'] });
    if (h.meetUrl) this.#announceCalls();
  }

  // ------------------------------------------------------------ Google Meet calls
  // Exactly one person creates the Meet (opens meet.google.com/new in Chrome): the first of
  // `prefer` who has the Chrome extension connected. Everyone else opens that same link.
  #host(...prefer) {
    for (const id of prefer) {
      const m = this.members.get(id);
      if (m && [...m.sockets].some(sid => this.sockets.get(sid)?.meta.role === 'main')) return id;
    }
    return prefer[0];
  }
  #endDirect(id, reason, byName) {
    const c = this.direct[id];
    if (!c) return;
    delete this.direct[id];
    this.#clear(`direct:${id}`);
    const msg = { type: 'call:ended', callId: id, url: c.url || null, reason, byName: byName || null };
    this.#toUser(c.from, msg);
    this.#toUser(c.to, msg);
    if (c.url && c.accepted) this.#announceCalls();
  }

  // ------------------------------------------------------------ plants
  #grow(userId, field, reason, from) {
    const st = this.stats[userId] ||= { points: 0, helped: 0, kudos: 0 };
    st[field]++;
    st.points++;
    const m = this.members.get(userId);
    if (m) this.#broadcast({ type: 'presence', member: this.#public(m) });
    this.#broadcast({ type: 'grow', userId, points: st.points, reason, from: from || null }, { roles: ['main', 'companion'] });
  }

  // ------------------------------------------------------------ stand-up
  #scheduleStandup() {
    this.#clear('standup');
    const at = nextStandup(this.team.standup);
    if (at) this.timers.standup = { at, kind: 'standup', a: null };
  }
  #eligible(m) { return m && m.online && STANDUP_STATES.has(m.state); }
  #startStandup(reason) {
    if (this.standup) return;
    const order = [...this.members.values()].filter(m => this.#eligible(m))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(m => m.id);
    if (!order.length) return;
    const perPerson = this.team.standup?.perPerson || 60;
    this.standup = { id: newId(), startedAt: now(), reason, order, turn: 0, turnEndsAt: now() + perPerson * 1000, perPerson };
    this.#timer('standupTurn', perPerson * 1000, 'standupTurn', this.standup.id);
    this.#broadcast({ type: 'standup', standup: this.standup, started: true }, { roles: ['main', 'companion'] });
  }
  #nextTurn(id) {
    const su = this.standup;
    if (!su || (id && su.id !== id)) return;
    // skip anyone who has since gone to lunch, on leave, offline…
    let turn = su.turn + 1;
    while (turn < su.order.length && !this.#eligible(this.members.get(su.order[turn]))) turn++;
    if (turn >= su.order.length) return this.#endStandup('done');
    su.turn = turn;
    su.turnEndsAt = now() + su.perPerson * 1000;
    this.#timer('standupTurn', su.perPerson * 1000, 'standupTurn', su.id);
    this.#broadcast({ type: 'standup', standup: su }, { roles: ['main', 'companion'] });
  }
  #endStandup(reason) {
    if (!this.standup) return;
    this.standup = null;
    this.#clear('standupTurn');
    this.#broadcast({ type: 'standup', standup: null, reason }, { roles: ['main', 'companion'] });
  }
  // people who arrive (or come back to their desk) during the stand-up join the end of the line
  #joinStandup(m) {
    const su = this.standup;
    if (!su || !this.#eligible(m) || su.order.includes(m.id)) return;
    su.order.push(m.id);
    this.#broadcast({ type: 'standup', standup: su }, { roles: ['main', 'companion'] });
  }

  // ------------------------------------------------------------ messages
  onMessage(conn, msg) {
    const meta = conn.meta;

    if (msg.type === 'hello') {
      const code = teamCode(msg.team);
      const u = msg.user || {};
      const email = clean(u.email, 120).toLowerCase();
      if (!code) return this.#send(conn, { type: 'error', error: 'team_required' });
      if (code !== this.code) return this.#send(conn, { type: 'error', error: 'wrong_team' });
      if (this.cfg.TEAM_CODES.length && !this.cfg.TEAM_CODES.includes(code)) return this.#send(conn, { type: 'error', error: 'unknown_team' });
      if (this.cfg.ALLOWED_DOMAIN && !email.endsWith('@' + this.cfg.ALLOWED_DOMAIN)) return this.#send(conn, { type: 'error', error: 'domain_not_allowed' });
      const userId = clean(u.id, 64) || email || newId();
      meta.team = code;
      meta.userId = userId;
      meta.role = ['main', 'call', 'companion'].includes(msg.role) ? msg.role : 'main';
      conn.save?.();

      let m = this.members.get(userId);
      if (!m) {
        m = { id: userId, sockets: new Set(), seat: this.#nextSeat(), state: 'desk', since: now(), inCall: null };
        this.members.set(userId, m);
      }
      Object.assign(m, {
        name: clean(u.name, 40) || 'Teammate',
        email,
        color: clean(u.color, 9) || '#6C8CFF',
        avatar: u.avatar && typeof u.avatar === 'object' ? {
          skin: clean(u.avatar.skin, 9), hair: clean(u.avatar.hair, 9), style: clean(u.avatar.style, 12), glasses: clean(u.avatar.glasses, 12), model: clean(u.avatar.model, 32),
          pet: PETS.has(clean(u.avatar.pet, 12)) ? clean(u.avatar.pet, 12) : '',
        } : m.avatar,
        tz: clean(u.tz, 48),
      });
      // the plant survives server restarts: the client remembers how big it was
      const hint = Math.min(500, Math.max(0, Math.floor(Number(u.plant) || 0)));
      const st = this.stats[userId] ||= { points: 0, helped: 0, kudos: 0 };
      if (hint > st.points) st.points = hint;
      if (msg.weather) m.weather = this.#weather(msg.weather);
      this.#clear(`offline:${userId}`);
      this.#clear(`gc:${userId}`);
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
      this.#send(conn, {
        type: 'welcome',
        socketId: meta.socketId,
        me: this.#public(m),
        members: [...this.members.values()].filter(x => x.online).map(x => this.#public(x)),
        helps: [...this.helps.values()],
        calls: this.#snapshotCalls(),
        iceServers: this.cfg.ICE_SERVERS,
        teamCfg: this.team,
        standup: this.standup,
        protocol: PROTOCOL,
      });
      if (meta.role !== 'call') {
        this.#broadcast({ type: 'presence', member: this.#public(m) }, { exceptSocket: meta.socketId });
        this.#joinStandup(m);
      }
      return;
    }

    if (!meta.team) return this.#send(conn, { type: 'error', error: 'hello_first' });
    const me = this.members.get(meta.userId);
    if (!me) return this.#send(conn, { type: 'error', error: 'hello_first' });

    switch (msg.type) {
      case 'ping':
        return this.#send(conn, { type: 'pong' });

      case 'status': {
        if (!STATES.has(msg.state)) return;
        // Rules for automatic updates (idle detector, Google Chat sync):
        //  - manual DND / meeting are sticky until the person changes them
        //  - manual lunch / brb only end automatically when the person is active again
        const source = clean(msg.source, 16) || 'manual';
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
        this.#broadcast({ type: 'presence', member: this.#public(me) });
        this.#joinStandup(me);
        return;
      }

      case 'help': {
        // one open request per person
        for (const h of [...this.helps.values()]) if (h.from === me.id) this.#closeHelp(h.id, 'replaced');
        const h = {
          id: newId(), from: me.id, fromName: me.name, color: me.color, avatar: me.avatar,
          topic: clean(msg.topic, 140), urgency: ['low', 'normal', 'high'].includes(msg.urgency) ? msg.urgency : 'normal',
          to: Array.isArray(msg.to) ? msg.to.map(x => clean(x, 64)).slice(0, 20) : null,
          ts: now(), claimedBy: null,
        };
        this.#timer(`help:${h.id}`, this.cfg.HELP_TTL_MS, 'help', { id: h.id, reason: 'expired' });
        this.helps.set(h.id, h);
        return this.#broadcast({ type: 'help:new', help: h }, { roles: ['main', 'companion'] });
      }

      case 'help:claim': {
        const h = this.helps.get(msg.id);
        if (!h) return this.#send(conn, { type: 'help:gone', id: msg.id });
        if (h.claimedBy && h.claimedBy !== me.id) return this.#send(conn, { type: 'help:taken', id: h.id, by: h.claimedBy });
        if (h.from === me.id) return;
        if (h.claimedBy === me.id) {
          // tapped Join again: don't start a second meeting, just point them at the one there is
          if (h.meetUrl) this.#send(conn, { type: 'help:meet', id: h.id, url: h.meetUrl, by: h.host, again: true });
          return;
        }
        h.claimedBy = me.id;
        h.claimedName = me.name;
        h.host = this.#host(me.id, h.from);   // the helper makes the Meet (or the asker, if the helper has no Chrome extension)
        // keep the request around while the Meet is being made, then close it if no link ever arrives
        this.#timer(`help:${h.id}`, 5 * 60 * 1000, 'help', { id: h.id, reason: 'claimed' });
        this.#broadcast({ type: 'help:claimed', id: h.id, by: me.id, byName: me.name, bySocket: meta.socketId, callId: h.id, host: h.host }, { roles: ['main', 'companion'] });
        this.#grow(me.id, 'helped', 'help', h.from);   // helping someone grows your plant
        return;
      }

      case 'help:meet': {
        // the helper (or asker) created a Google Meet for this request: share it, keep the request open until "End call"
        const h = this.helps.get(msg.id);
        const url = clean(msg.url, 80);
        if (!h || !MEET_RE.test(url) || (h.from !== me.id && h.claimedBy !== me.id) || h.meetUrl) return;
        h.meetUrl = url;
        this.#timer(`help:${h.id}`, MEET_TTL_MS, 'help', { id: h.id, reason: 'expired' });
        this.#broadcast({ type: 'help:meet', id: h.id, url, by: me.id }, { roles: ['main', 'companion'] });
        this.#announceCalls();
        return;
      }

      case 'help:nudge': {
        // "where's the link?": ask whoever is making the Meet to send it again
        const h = this.helps.get(msg.id);
        if (!h || (h.from !== me.id && h.claimedBy !== me.id)) return;
        if (h.meetUrl) return this.#send(conn, { type: 'help:meet', id: h.id, url: h.meetUrl, by: h.host, again: true });
        return this.#toUser(h.host, { type: 'help:nudge', id: h.id, host: h.host });
      }

      case 'help:rehost': {
        // the meeting maker never shared a link (e.g. stuck on Google's sign-in): the other person makes it
        const h = this.helps.get(msg.id);
        if (!h || h.meetUrl || !h.claimedBy || (h.from !== me.id && h.claimedBy !== me.id) || h.host === me.id) return;
        h.host = me.id;
        return this.#broadcast({ type: 'help:host', id: h.id, host: me.id }, { roles: ['main', 'companion'] });
      }

      case 'help:end': {
        // asker or helper hangs up (by request id, or by its Meet link): close it for everyone in it
        const mineOrHelping = (h) => h && (h.from === me.id || h.claimedBy === me.id);
        const h = msg.id ? this.helps.get(msg.id)
          : typeof msg.url === 'string' ? [...this.helps.values()].find(x => x.meetUrl === msg.url && mineOrHelping(x)) : null;
        if (!mineOrHelping(h)) {
          // not a help request: maybe a direct call (by id or Meet link)
          const c = Object.values(this.direct).find(x => (x.id === msg.id || (x.url && x.url === msg.url)) && (x.from === me.id || x.to === me.id));
          if (c) this.#endDirect(c.id, 'ended', me.name);
          return;
        }
        for (const sid of this.calls.get(h.id) || []) this.#send(this.sockets.get(sid), { type: 'call:end', callId: h.id, byName: me.name });
        this.#closeHelp(h.id, 'ended');
        return;
      }

      case 'help:cancel': {
        const h = this.helps.get(msg.id);
        if (h && h.from === me.id) this.#closeHelp(h.id, 'cancelled');
        return;
      }

      case 'wave':
        return this.#toUser(clean(msg.to, 64), { type: 'wave', from: me.id, fromName: me.name, emoji: clean(msg.emoji, 8) || '👋' });

      case 'call:invite': {
        // direct call: tell the invitee there is a call waiting for them
        const to = clean(msg.to, 64);
        const callId = clean(msg.callId, 32) || newId();
        const meetUrl = MEET_RE.test(clean(msg.url, 80)) ? clean(msg.url, 80) : null;
        if (!this.members.get(to)) return;
        // Google Meet calls are remembered so both people end up in the same meeting; the
        // invite goes out straight away (ringing) and the link follows as soon as it exists
        let host = null;
        if (msg.meet) {
          host = this.#host(me.id, to);
          this.direct[callId] = { id: callId, from: me.id, to, host, url: meetUrl, at: now(), accepted: false };
          this.#timer(`direct:${callId}`, 3 * 60 * 60 * 1000, 'direct', callId);
        }
        this.#toUser(to, { type: 'call:invite', callId, url: meetUrl, meet: !!msg.meet, host, from: me.id, fromName: me.name, color: me.color, avatar: me.avatar });
        // all my devices hear about it (the Chrome extension makes the Meet even if I called from the Mac app)
        return this.#toUser(me.id, { type: 'call:invited', callId, to, host });
      }

      case 'call:url': {
        // the host made the Meet: share the link with both people (only once)
        const c = this.direct[clean(msg.callId, 32)];
        const url = clean(msg.url, 80);
        if (!c || c.url || !MEET_RE.test(url) || (c.from !== me.id && c.to !== me.id)) return;
        c.url = url;
        const out = { type: 'call:url', callId: c.id, url, by: me.id, host: c.host, accepted: c.accepted };
        this.#toUser(c.from, out);
        this.#toUser(c.to, out);
        if (c.accepted) this.#announceCalls();
        return;
      }

      case 'call:accept': {
        const c = this.direct[clean(msg.callId, 32)];
        if (!c || c.to !== me.id) return;
        if (!c.accepted) {
          c.accepted = true;
          this.#toUser(c.from, { type: 'call:accepted', callId: c.id, by: me.id, byName: me.name });
          if (c.url) this.#announceCalls();
        }
        // tell all their devices which link to open (or that it's on its way / that they make it)
        return this.#toUser(me.id, { type: 'call:url', callId: c.id, url: c.url || null, host: c.host, by: null, accepted: true });
      }

      case 'call:decline': {
        const id = clean(msg.callId, 32);
        if (this.direct[id]?.to === me.id) this.#endDirect(id, 'declined', me.name);
        return this.#toUser(clean(msg.to, 64), { type: 'call:declined', callId: id, by: me.id, byName: me.name }, { includeCall: true });
      }

      case 'call:join': {
        const callId = clean(msg.callId, 32);
        if (!callId) return;
        if (meta.callId) this.#leaveCall(conn);
        let set = this.calls.get(callId);
        if (!set) { set = new Set(); this.calls.set(callId, set); }
        if (set.size >= this.cfg.MAX_CALL_SIZE) return this.#send(conn, { type: 'error', error: 'call_full' });
        const peers = [...set].map(sid => {
          const p = this.sockets.get(sid);
          const pm = p && this.members.get(p.meta.userId);
          return pm && { peerId: sid, user: this.#public(pm), state: p.meta.callState || null };
        }).filter(Boolean);
        set.add(meta.socketId);
        meta.callId = callId;
        conn.save?.();
        this.#send(conn, { type: 'call:peers', callId, peers, iceServers: this.cfg.ICE_SERVERS });
        for (const p of peers) this.#send(this.sockets.get(p.peerId), { type: 'call:peer-joined', peerId: meta.socketId, user: this.#public(me) });
        this.#announceCalls();
        return;
      }

      case 'call:signal': {
        const target = this.sockets.get(msg.to);
        if (!target || !meta.callId || target.meta.callId !== meta.callId) return;
        return this.#send(target, { type: 'call:signal', from: meta.socketId, data: msg.data });
      }

      case 'call:mute':
        if (!meta.callId) return;
        for (const sid of this.calls.get(meta.callId) || []) if (sid !== meta.socketId) this.#send(this.sockets.get(sid), { type: 'call:mute', peerId: meta.socketId, muted: !!msg.muted });
        return;

      case 'call:state': {
        // mic / camera / screen share / raised hand, so the others can show it on my tile
        if (!meta.callId) return;
        const st = msg.state || {};
        const state = { muted: !!st.muted, cam: !!st.cam, screen: !!st.screen, hand: !!st.hand };
        meta.callState = state;
        conn.save?.();
        for (const sid of this.calls.get(meta.callId) || []) if (sid !== meta.socketId) this.#send(this.sockets.get(sid), { type: 'call:state', peerId: meta.socketId, state });
        return;
      }

      case 'call:react': {
        if (!meta.callId) return;
        const emoji = clean(msg.emoji, 8);
        for (const sid of this.calls.get(meta.callId) || []) this.#send(this.sockets.get(sid), { type: 'call:react', peerId: meta.socketId, emoji });
        return;
      }

      case 'call:leave':
        return this.#leaveCall(conn);

      case 'kudos': {
        const to = clean(msg.to, 64);
        const target = this.members.get(to);
        if (!target || to === me.id) return;
        const key = `${me.id}>${to}`;
        if (now() - (this.kudosAt[key] || 0) < KUDOS_GAP_MS) return this.#send(conn, { type: 'kudos:wait', to });
        this.kudosAt[key] = now();
        this.#broadcast({ type: 'kudos', from: me.id, fromName: me.name, to, toName: target.name }, { roles: ['main', 'companion'] });
        this.#grow(to, 'kudos', 'kudos', me.id);
        return;
      }

      case 'weather':
        me.weather = this.#weather(msg.weather);
        return this.#broadcast({ type: 'presence', member: this.#public(me) });

      case 'standup:config': {
        this.team.standup = cleanStandup(msg.standup);
        this.#scheduleStandup();
        return this.#broadcast({ type: 'team', teamCfg: this.team, by: me.name }, { roles: ['main', 'companion'] });
      }
      case 'standup:start':
        return this.#startStandup('manual');
      case 'standup:next':
        return this.#nextTurn(this.standup?.id);
      case 'standup:end':
        return this.#endStandup('ended');

      case 'react':
        // emoji reaction floating above my avatar on everyone's desk
        return this.#broadcast({ type: 'react', from: me.id, emoji: clean(msg.emoji, 8) }, { roles: ['main', 'companion'] });
    }
  }

  #weather(w) {
    if (!w || typeof w !== 'object') return null;
    return {
      code: Math.max(0, Math.min(99, Math.floor(Number(w.code) || 0))),
      isDay: !!w.isDay,
      temp: Number.isFinite(Number(w.temp)) ? Math.round(Number(w.temp)) : null,
      place: clean(w.place, 40),
      at: now(),
    };
  }

  // The host has already removed conn from `sockets`.
  onClose(conn) {
    const { userId, socketId } = conn.meta;
    if (!conn.meta.team) return;
    this.#leaveCall(conn);
    const m = this.members.get(userId);
    if (!m) return;
    m.sockets.delete(socketId);
    if (this.#present(m)) {
      this.#broadcast({ type: 'presence', member: this.#public(m) });
      return;
    }
    this.#timer(`offline:${userId}`, this.cfg.OFFLINE_GRACE_MS, 'offline', userId);
  }
}
