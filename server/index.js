// Deskmate presence + signalling server (Node). Use this for local development or any host that
// runs a long-lived Node process. For free hosting, deploy cloudflare/ instead: same room logic.
// One WebSocket endpoint. Teams are rooms keyed by team code; state lives in memory.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, configFromEnv, newId, teamCode, PROTOCOL } from './room.js';

const PORT = Number(process.env.PORT || 8787);
const config = configFromEnv(process.env);

/** rooms: team code -> Room */
const rooms = new Map();
/** sockets: socketId -> conn (shared by all rooms; socket ids are unique) */
const sockets = new Map();

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, new Room({ code, sockets, config }));
  return rooms.get(code);
}

// Timers (help expiry, offline grace, seat clean-up) are data inside each room: after anything
// happens, wake up exactly when the room's next timer is due.
const wakeups = new Map(); // code -> timeout
function schedule(room) {
  clearTimeout(wakeups.get(room.code));
  const at = room.nextDue();
  if (at === null) {
    wakeups.delete(room.code);
    if (room.isEmpty()) rooms.delete(room.code);
    return;
  }
  wakeups.set(room.code, setTimeout(() => { room.runDue(); schedule(room); }, Math.max(0, at - Date.now())));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, teams: rooms.size, sockets: sockets.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Deskmate server. Connect via WebSocket.');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const conn = {
    meta: { socketId: newId(), team: null, userId: null, role: 'main', callId: null },
    send: (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    room: null,
  };
  // clients also put the team in the URL (?team=); the Cloudflare server routes on it
  const urlTeam = teamCode(new URL(req.url, 'http://x').searchParams.get('team'));
  sockets.set(conn.meta.socketId, conn);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') return conn.send({ type: 'pong' });
    try {
      if (!conn.room) {
        const code = teamCode(msg.type === 'hello' ? msg.team : '') || urlTeam;
        if (!code) return conn.send({ type: 'error', error: msg.type === 'hello' ? 'team_required' : 'hello_first' });
        conn.room = roomFor(code);
      }
      conn.room.onMessage(conn, msg);
      schedule(conn.room);
    } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    sockets.delete(conn.meta.socketId);
    if (conn.room) { conn.room.onClose(conn); schedule(conn.room); }
  });
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
