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

const STATES = new Set(['desk', 'lunch', 'afk', 'dnd', 'meeting', 'brb']);
const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const CLAIM_LINGER_MS = 60 * 1000;
const MEET_TTL_MS = 3 * 60 * 60 * 1000;
const SEAT_GC_MS = 60 * 60 * 1000;

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
    if (saved) this.#restore(saved);
  }

  // ------------------------------------------------------------ save / restore
  serialize() {
    return JSON.stringify({
      members: [...this.members.values()].map(m => ({ ...m, sockets: [...m.sockets] })),
      helps: [...this.helps.values()],
      calls: [...this.calls.entries()].map(([id, set]) => [id, [...set]]),
      timers: this.timers,
    });
  }

  #restore(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    for (const m of s.members || []) this.members.set(m.id, { ...m, sockets: new Set(m.sockets) });
    for (const h of s.helps || []) this.helps.set(h.id, h);
    for (const [id, sids] of s.calls || []) this.calls.set(id, new Set(sids));
    this.timers = s.timers || {};
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

  isEmpty() { return this.members.size === 0 && this.calls.size === 0; }

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
        } : m.avatar,
        tz: clean(u.tz, 48),
      });
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
      });
      if (meta.role !== 'call') this.#broadcast({ type: 'presence', member: this.#public(m) }, { exceptSocket: meta.socketId });
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
        return this.#broadcast({ type: 'presence', member: this.#public(me) });
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
        h.claimedBy = me.id;
        h.claimedName = me.name;
        // keep the request around briefly so late viewers see "X is on it", then close
        this.#timer(`help:${h.id}`, CLAIM_LINGER_MS, 'help', { id: h.id, reason: 'claimed' });
        this.#broadcast({ type: 'help:claimed', id: h.id, by: me.id, byName: me.name, bySocket: meta.socketId, callId: h.id }, { roles: ['main', 'companion'] });
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

      case 'help:end': {
        // asker or helper hangs up (by request id, or by its Meet link): close it for everyone in it
        const mineOrHelping = (h) => h && (h.from === me.id || h.claimedBy === me.id);
        const h = msg.id ? this.helps.get(msg.id)
          : typeof msg.url === 'string' ? [...this.helps.values()].find(x => x.meetUrl === msg.url && mineOrHelping(x)) : null;
        if (!mineOrHelping(h)) return;
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
        this.#toUser(to, { type: 'call:invite', callId, url: meetUrl, from: me.id, fromName: me.name, color: me.color, avatar: me.avatar });
        return this.#send(conn, { type: 'call:invited', callId, to });
      }

      case 'call:decline':
        return this.#toUser(clean(msg.to, 64), { type: 'call:declined', callId: clean(msg.callId, 32), by: me.id, byName: me.name }, { includeCall: true });

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
          return pm && { peerId: sid, user: this.#public(pm) };
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

      case 'call:leave':
        return this.#leaveCall(conn);

      case 'react':
        // emoji reaction floating above my avatar on everyone's desk
        return this.#broadcast({ type: 'react', from: me.id, emoji: clean(msg.emoji, 8) }, { roles: ['main', 'companion'] });
    }
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
