// Deskmate server on Cloudflare Workers.
// The Worker routes each WebSocket to its team's Durable Object (one per team code). The Durable
// Object runs the same Room logic as the Node server (../server/room.js).
//
// It uses the WebSocket Hibernation API: between messages the object can be evicted from memory,
// and idle connections stay open without being billed. So nothing may live only in memory:
//   - each socket's metadata is stored on the socket (serializeAttachment)
//   - the room is saved to the object's storage after every change
//   - room timers become a Durable Object alarm
//   - keep-alive pings get an automatic reply without waking the object
import { DurableObject } from 'cloudflare:workers';
import { Room, configFromEnv, newId, teamCode, PROTOCOL } from '../server/room.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, protocol: PROTOCOL });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Deskmate server. Connect via WebSocket.', { headers: { 'content-type': 'text/plain' } });
    }
    const code = teamCode(url.searchParams.get('team'));
    if (!code) return new Response('Add ?team=<team code> to the URL (update the Deskmate extension / Mac app).', { status: 400 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(code));
    return room.fetch(req);
  },
};

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

export class TeamRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.config = configFromEnv(env);
    this.sockets = new Map(); // socketId -> conn
    this.room = null;
    this.saved = null;
    // sockets that stayed open while the object slept
    for (const ws of ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (meta?.socketId) this.#wrap(ws, meta);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      const [code, saved] = await Promise.all([ctx.storage.get('code'), ctx.storage.get('room')]);
      if (code) {
        this.room = new Room({ code, sockets: this.sockets, config: this.config, saved });
        this.saved = saved || null;
      }
    });
  }

  #wrap(ws, meta) {
    const conn = {
      meta,
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      save: () => ws.serializeAttachment(conn.meta),
    };
    this.sockets.set(meta.socketId, conn);
    return conn;
  }

  #connOf(ws) {
    const meta = ws.deserializeAttachment();
    return meta && this.sockets.get(meta.socketId);
  }

  async fetch(req) {
    const code = teamCode(new URL(req.url).searchParams.get('team'));
    if (!this.room) {
      this.room = new Room({ code, sockets: this.sockets, config: this.config });
      await this.ctx.storage.put('code', code);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const meta = { socketId: newId(), team: null, userId: null, role: 'main', callId: null };
    server.serializeAttachment(meta);
    this.#wrap(server, meta);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const conn = this.#connOf(ws);
    if (!conn || typeof data !== 'string' || data.length > 64 * 1024) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') return ws.send(PONG); // older clients send {"type":"ping","t":…}
    try { this.room.onMessage(conn, msg); } catch (e) { console.error('handler error', e); }
    await this.#persist();
  }

  async webSocketClose(ws, code) {
    await this.#gone(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    await this.#gone(ws);
  }

  async #gone(ws) {
    const conn = this.#connOf(ws);
    if (!conn) return;
    this.sockets.delete(conn.meta.socketId);
    this.room?.onClose(conn);
    await this.#persist();
  }

  async alarm() {
    if (!this.room) return;
    this.room.runDue();
    await this.#persist();
  }

  // Save the room if it changed, and set the alarm for its next timer.
  async #persist() {
    const room = this.room;
    if (!room) return;
    const at = room.nextDue();
    if (room.isEmpty() && at === null && this.sockets.size === 0) {
      // nobody left: forget this team entirely (a new room starts fresh next time)
      await this.ctx.storage.deleteAll();
      this.saved = null;
      this.room = null;
      return;
    }
    const json = room.serialize();
    if (json !== this.saved) {
      await this.ctx.storage.put('room', json);
      this.saved = json;
    }
    if (at === null) await this.ctx.storage.deleteAlarm();
    else if ((await this.ctx.storage.getAlarm()) !== at) await this.ctx.storage.setAlarm(at);
  }
}
