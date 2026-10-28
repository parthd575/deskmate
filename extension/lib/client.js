// DeskClient: the team connection, independent of where it runs.
// Used by the extension's service worker and by the Mac menu-bar app.

const PING_MS = 20000; // also keeps the MV3 service worker alive (Chrome 116+)

// The team goes in the URL too: the Cloudflare server picks the team's room before the socket opens.
// Accepts ws(s):// or http(s):// (e.g. the https://….workers.dev address Cloudflare prints).
// the server protocol this client needs (see server/room.js PROTOCOL)
export const NEEDS_PROTOCOL = 3;

export function socketUrl(server, team) {
  const u = new URL(String(server).trim().replace(/^http(s?):\/\//i, 'ws$1://'));
  u.searchParams.set('team', String(team || '').trim().toLowerCase());
  return u.toString();
}

export class DeskClient {
  constructor({ settings, role = 'main', WebSocketImpl = globalThis.WebSocket }) {
    this.settings = settings;
    this.role = role;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.listeners = new Set();
    this.eventListeners = new Set();
    this.backoff = 1000;
    this.closedByUser = false;
    this.state = this.#empty();
    this.pendingStatus = settings.lastStatus || null;
  }

  #empty() {
    return { conn: 'idle', error: null, socketId: null, me: null, members: {}, helps: {}, calls: [], iceServers: [], teamCfg: { standup: null }, standup: null };
  }

  // ---- subscription ----
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  #emit() { const s = this.snapshot(); for (const fn of this.listeners) try { fn(s); } catch (e) { console.error(e); } }
  #event(e) { for (const fn of this.eventListeners) try { fn(e, this.snapshot()); } catch (err) { console.error(err); } }

  snapshot() {
    const st = this.state;
    const helps = Object.values(st.helps).sort((a, b) => a.ts - b.ts);
    return {
      conn: st.conn,
      error: st.error,
      me: st.me,
      members: Object.values(st.members).sort((a, b) => a.seat - b.seat),
      helps,
      myHelp: st.me ? helps.find(h => h.from === st.me.id) || null : null,
      calls: st.calls,
      iceServers: st.iceServers,
      team: this.settings.team,
      teamCfg: st.teamCfg,        // team-wide settings (stand-up schedule)
      serverOutdated: st.conn === 'online' && (st.protocol || 0) < NEEDS_PROTOCOL,
      standup: st.standup,        // the stand-up happening right now, if any
    };
  }

  get configured() {
    const s = this.settings;
    return !!(s && s.team && s.name && s.server);
  }

  // ---- connection ----
  connect() {
    if (!this.configured) { this.state.conn = 'setup'; this.#emit(); return; }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUser = false;
    this.state.conn = 'connecting';
    this.#emit();
    let ws;
    try { ws = new this.WS(socketUrl(this.settings.server, this.settings.team)); } catch (e) {
      this.state.conn = 'error'; this.state.error = 'bad_server_url'; this.#emit(); return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      const s = this.settings;
      this.#send({
        type: 'hello', team: s.team, role: this.role,
        user: { id: s.userId, name: s.name, email: s.email, color: s.color, avatar: s.avatar, tz: s.tz, plant: s.plant || 0 },
        status: this.pendingStatus || undefined,
        weather: this.weather || undefined,
      });
      clearInterval(this.pingTimer);
      // exactly '{"type":"ping"}': the Cloudflare server answers it without waking up
      this.pingTimer = setInterval(() => this.#send({ type: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      this.#handle(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) return;
      this.state.conn = 'offline';
      this.#emit();
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.state = this.#empty();
    this.state.conn = 'idle';
    this.#emit();
  }

  updateSettings(settings) {
    const reconnect = ['server', 'team', 'name', 'email', 'color', 'userId', 'tz'].some(k => settings[k] !== this.settings[k])
      || JSON.stringify(settings.avatar) !== JSON.stringify(this.settings.avatar);
    this.settings = settings;
    if (reconnect) { this.disconnect(); this.connect(); }
  }

  get isOpen() { return this.ws && this.ws.readyState === 1; }

  #send(msg) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  #handle(msg) {
    const st = this.state;
    switch (msg.type) {
      case 'welcome':
        st.conn = 'online';
        st.error = null;
        st.socketId = msg.socketId;
        st.me = msg.me;
        st.members = Object.fromEntries(msg.members.map(m => [m.id, m]));
        st.helps = Object.fromEntries(msg.helps.map(h => [h.id, h]));
        st.calls = msg.calls;
        st.iceServers = msg.iceServers;
        st.teamCfg = msg.teamCfg || { standup: null };
        st.protocol = msg.protocol || 0;   // older servers don't say
        st.standup = msg.standup || null;
        // re-assert the status we had before a reconnect
        if (this.pendingStatus && msg.me.state !== this.pendingStatus.state) {
          this.#send({ type: 'status', ...this.pendingStatus });
        }
        this.#emit();
        return;
      case 'presence':
        st.members[msg.member.id] = msg.member;
        if (st.me && msg.member.id === st.me.id) {
          const prev = st.me.state;
          st.me = msg.member;
          this.pendingStatus = { state: msg.member.state, message: msg.member.message, until: msg.member.until, source: msg.member.source };
          if (prev !== msg.member.state) this.#event({ type: 'my-status', state: msg.member.state, prev, member: msg.member });
        } else {
          this.#event({ type: 'presence', member: msg.member });
        }
        this.#emit();
        return;
      case 'leave':
        delete st.members[msg.userId];
        this.#emit();
        return;
      case 'help:new':
        st.helps[msg.help.id] = msg.help;
        this.#emit();
        this.#event({ type: 'help:new', help: msg.help, mine: st.me && msg.help.from === st.me.id });
        return;
      case 'help:claimed': {
        const h = st.helps[msg.id];
        if (h) { h.claimedBy = msg.by; h.claimedName = msg.byName; }
        this.#emit();
        if (h) h.host = msg.host || msg.by;   // older servers don't pick: the helper makes the Meet
        this.#event({ type: 'help:claimed', ...msg, help: h, mine: h && st.me && h.from === st.me.id, byMe: st.me && msg.by === st.me.id, byThisDevice: msg.bySocket === st.socketId, iHost: !!(st.me && (msg.host || msg.by) === st.me.id) });
        return;
      }
      case 'help:nudge':
        this.#event({ ...msg, toMe: !!(st.me && msg.host === st.me.id) });
        return;
      case 'help:host': {
        const h = st.helps[msg.id];
        if (h) h.host = msg.host;
        this.#emit();
        this.#event({ ...msg, iHost: !!(st.me && msg.host === st.me.id) });
        return;
      }
      case 'help:meet': {
        const h = st.helps[msg.id];
        if (h) h.meetUrl = msg.url;
        this.#emit();
        this.#event({ type: 'help:meet', id: msg.id, url: msg.url, help: h, mine: h && st.me && h.from === st.me.id, helping: h && st.me && h.claimedBy === st.me.id, byMe: st.me && msg.by === st.me.id });
        return;
      }
      case 'help:closed': {
        const h = st.helps[msg.id];
        delete st.helps[msg.id];
        this.#emit();
        this.#event({ type: 'help:closed', id: msg.id, reason: msg.reason, meetUrl: h?.meetUrl || null });
        return;
      }
      case 'help:taken':
      case 'help:gone':
        this.#event(msg);
        return;
      case 'calls':
        st.calls = msg.calls;
        this.#emit();
        return;
      case 'team':
        st.teamCfg = msg.teamCfg;
        this.#emit();
        this.#event(msg);
        return;
      case 'standup': {
        const prev = st.standup;
        st.standup = msg.standup;
        this.#emit();
        this.#event({ ...msg, prev, inIt: !!(msg.standup && st.me && msg.standup.order.includes(st.me.id)) });
        return;
      }
      case 'kudos':
      case 'grow':
        this.#event({ ...msg, toMe: st.me && (msg.to === st.me.id || msg.userId === st.me.id) });
        return;
      case 'kudos:wait':
        this.#event(msg);
        return;
      case 'wave':
      case 'react':
      case 'call:declined':
      case 'call:url':
      case 'call:accepted':
      case 'call:ended':
        this.#event(msg);
        return;
      case 'call:invite':
      case 'call:invited':
        this.#event({ ...msg, iHost: !!(st.me && msg.host === st.me.id) });
        return;
      case 'error':
        st.error = msg.error;
        if (['unknown_team', 'domain_not_allowed', 'team_required'].includes(msg.error)) {
          st.conn = 'error';
          this.closedByUser = true;
          try { this.ws?.close(); } catch {}
        }
        this.#emit();
        this.#event(msg);
        return;
    }
  }

  // ---- actions ----
  setStatus(state, { message, until, source = 'manual' } = {}) {
    const me = this.state.me;
    const status = { state, message, until: until || null, source };
    if (source === 'manual') this.pendingStatus = status;
    if (me) {
      // optimistic update for snappy UI
      if (source === 'manual') {
        const changed = me.state !== state;
        this.state.me = { ...me, state, message: message ?? (changed ? '' : me.message), until: until || null, source, since: changed ? Date.now() : me.since };
        this.state.members[me.id] = this.state.me;
        this.#emit();
      }
    }
    this.#send({ type: 'status', ...status });
  }
  askHelp(topic = '', urgency = 'normal', to = null) { this.#send({ type: 'help', topic, urgency, to }); }
  cancelHelp(id) { this.#send({ type: 'help:cancel', id }); }
  endHelp(id) { this.#send({ type: 'help:end', id }); }
  // end whichever of my help requests uses this Google Meet (asker or helper)
  endHelpByMeet(url) { this.#send({ type: 'help:end', url }); }
  claimHelp(id) { this.#send({ type: 'help:claim', id }); }
  wave(to, emoji) { this.#send({ type: 'wave', to, emoji }); }
  react(emoji) { this.#send({ type: 'react', emoji }); }
  kudos(to) { this.#send({ type: 'kudos', to }); }
  setWeather(w) { this.weather = w; this.#send({ type: 'weather', weather: w }); }
  setStandup(standup) { this.#send({ type: 'standup:config', standup }); }
  standupStart() { this.#send({ type: 'standup:start' }); }
  standupNext() { this.#send({ type: 'standup:next' }); }
  standupEnd() { this.#send({ type: 'standup:end' }); }
  invite(to, callId, url, meet = false) { this.#send({ type: 'call:invite', to, callId, url, meet }); }
  acceptCall(callId) { this.#send({ type: 'call:accept', callId }); }
  callUrl(callId, url) { this.#send({ type: 'call:url', callId, url }); }
  shareMeet(id, url) { this.#send({ type: 'help:meet', id, url }); }
  rehost(id) { this.#send({ type: 'help:rehost', id }); }
  nudge(id) { this.#send({ type: 'help:nudge', id }); }
  decline(to, callId) { this.#send({ type: 'call:decline', to, callId }); }
}

export function newId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
