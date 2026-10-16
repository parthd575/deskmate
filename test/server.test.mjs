// Protocol tests for the presence server.  Run:  node --test test/server.test.mjs
// Starts its own server on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(path.join(root, 'server/package.json'))('ws');
const PORT = 18000 + Math.floor(Math.random() * 1000);
// SERVER=ws://localhost:8787 runs the same tests against an already-running server
// (e.g. the Cloudflare one under `wrangler dev --var OFFLINE_GRACE_MS:300`)
const URL = process.env.SERVER || `ws://localhost:${PORT}`;
let srv;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  if (process.env.SERVER) return;
  srv = spawn(process.execPath, ['index.js'], { cwd: path.join(root, 'server'), env: { ...process.env, PORT: String(PORT), OFFLINE_GRACE_MS: '300' } });
  await new Promise(r => srv.stdout.on('data', r));
});
after(() => srv?.kill());

const RUN = Date.now().toString(36); // fresh rooms on every run (servers may keep state)
function client(team, id, role = 'main') {
  team = `${team}-${RUN}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(`${URL}/?team=${encodeURIComponent(team)}`);
    ws.log = [];
    ws.on('message', d => ws.log.push(JSON.parse(d)));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', team, role, user: { id, name: id.split('@')[0], email: id } }));
      setTimeout(() => resolve(ws), 120);
    });
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const last = (ws, type, pred = () => true) => [...ws.log].reverse().find(m => m.type === type && pred(m));
const stateOf = (ws, id) => last(ws, 'presence', m => m.member.id === id)?.member.state;

test('presence is shared across a team and isolated between teams', async () => {
  const a = await client('t1', 'a@x.com');
  const b = await client('t1', 'b@x.com');
  const c = await client('t2', 'c@x.com');
  send(a, { type: 'status', state: 'lunch' });
  await wait(100);
  assert.equal(stateOf(b, 'a@x.com'), 'lunch');
  assert.equal(stateOf(c, 'a@x.com'), undefined);
  [a, b, c].forEach(w => w.close());
});

test('auto-away never overrides manual lunch / focus, activity ends lunch', async () => {
  const a = await client('t3', 'a@x.com');
  const b = await client('t3', 'b@x.com');
  send(a, { type: 'status', state: 'lunch', source: 'manual' });
  await wait(60);
  send(a, { type: 'status', state: 'afk', source: 'idle' });
  await wait(60);
  assert.equal(stateOf(b, 'a@x.com'), 'lunch');
  send(a, { type: 'status', state: 'desk', source: 'activity' });
  await wait(60);
  assert.equal(stateOf(b, 'a@x.com'), 'desk');
  send(a, { type: 'status', state: 'dnd', source: 'manual' });
  await wait(60);
  send(a, { type: 'status', state: 'desk', source: 'activity' });
  send(a, { type: 'status', state: 'afk', source: 'idle' });
  await wait(60);
  assert.equal(stateOf(b, 'a@x.com'), 'dnd');
  [a, b].forEach(w => w.close());
});

test('only one person can pick up a help request', async () => {
  const asker = await client('t4', 'ask@x.com');
  const h1 = await client('t4', 'h1@x.com');
  const h2 = await client('t4', 'h2@x.com');
  send(asker, { type: 'help', topic: 'stuck' });
  await wait(80);
  const id = last(h1, 'help:new').help.id;
  send(h1, { type: 'help:claim', id });
  await wait(40);
  send(h2, { type: 'help:claim', id });
  await wait(80);
  assert.equal(last(asker, 'help:claimed').by, 'h1@x.com');
  assert.ok(last(h2, 'help:taken'));
  [asker, h1, h2].forEach(w => w.close());
});

test('call signalling is relayed only inside the call', async () => {
  const a = await client('t5', 'a@x.com', 'call');
  const b = await client('t5', 'b@x.com', 'call');
  const outsider = await client('t5', 'c@x.com', 'call');
  send(a, { type: 'call:join', callId: 'room1' });
  await wait(60);
  send(b, { type: 'call:join', callId: 'room1' });
  await wait(60);
  const peerA = last(b, 'call:peers').peers[0].peerId;
  send(b, { type: 'call:signal', to: peerA, data: { sdp: 'offer' } });
  send(outsider, { type: 'call:signal', to: peerA, data: { sdp: 'evil' } });
  await wait(80);
  const got = a.log.filter(m => m.type === 'call:signal');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.sdp, 'offer');
  [a, b, outsider].forEach(w => w.close());
});

test('companion flag and grace period on disconnect', async () => {
  const ext = await client('t6', 'p@x.com', 'main');
  const mac = await client('t6', 'p@x.com', 'companion');
  const other = await client('t6', 'o@x.com');
  await wait(60);
  assert.equal(last(other, 'welcome').members.find(m => m.id === 'p@x.com').companion, true);
  mac.close();
  await wait(100);
  assert.equal(last(other, 'presence', m => m.member.id === 'p@x.com').member.companion, false);
  ext.close();
  await wait(100);
  assert.equal(last(other, 'leave'), undefined, 'still online during grace');
  await wait(400);
  assert.equal(last(other, 'leave').userId, 'p@x.com');
  other.close();
});

test('Google Meet link is shared only by the asker or helper, and only a real Meet URL', async () => {
  const asker = await client('t9', 'ask@x.com');
  const helper = await client('t9', 'help@x.com');
  const other = await client('t9', 'other@x.com');
  send(asker, { type: 'help', topic: 'stuck' });
  await wait(80);
  const id = last(helper, 'help:new').help.id;
  send(helper, { type: 'help:claim', id });
  await wait(60);
  send(other, { type: 'help:meet', id, url: 'https://meet.google.com/zzz-zzzz-zzz' });
  send(helper, { type: 'help:meet', id, url: 'https://evil.example/abc-defg-hij' });
  await wait(60);
  assert.equal(last(asker, 'help:meet'), undefined);
  send(helper, { type: 'help:meet', id, url: 'https://meet.google.com/abc-defg-hij' });
  await wait(80);
  const m = last(asker, 'help:meet');
  assert.equal(m.url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(m.by, 'help@x.com');
  [asker, helper, other].forEach(w => w.close());
});

test('help:end by Meet URL closes only a request I am part of', async () => {
  const asker = await client('t10', 'ask@x.com');
  const helper = await client('t10', 'help@x.com');
  const other = await client('t10', 'other@x.com');
  send(asker, { type: 'help', topic: 'stuck' });
  await wait(80);
  const id = last(helper, 'help:new').help.id;
  send(helper, { type: 'help:claim', id });
  await wait(60);
  const url = 'https://meet.google.com/abc-defg-hij';
  send(helper, { type: 'help:meet', id, url });
  await wait(60);
  send(other, { type: 'help:end', url });
  await wait(80);
  assert.equal(last(asker, 'help:closed'), undefined);
  send(helper, { type: 'help:end', url });
  await wait(80);
  assert.equal(last(asker, 'help:closed').reason, 'ended');
  [asker, helper, other].forEach(w => w.close());
});

test('helping and kudos grow your plant; kudos are rate-limited', async () => {
  const a = await client('t11', 'a@x.com');
  const b = await client('t11', 'b@x.com');
  send(a, { type: 'help', topic: 'x' });
  await wait(80);
  send(b, { type: 'help:claim', id: last(b, 'help:new').help.id });
  await wait(80);
  assert.equal(last(a, 'presence', m => m.member.id === 'b@x.com').member.plant, 1);
  assert.equal(last(a, 'grow').reason, 'help');
  send(a, { type: 'kudos', to: 'b@x.com' });
  await wait(80);
  assert.equal(last(b, 'kudos').from, 'a@x.com');
  assert.equal(last(a, 'presence', m => m.member.id === 'b@x.com').member.plant, 2);
  send(a, { type: 'kudos', to: 'b@x.com' });   // too soon
  await wait(80);
  assert.ok(last(a, 'kudos:wait'));
  send(a, { type: 'kudos', to: 'a@x.com' });   // not yourself
  await wait(80);
  assert.equal(last(a, 'presence', m => m.member.id === 'a@x.com')?.member.plant ?? 0, 0);
  [a, b].forEach(w => w.close());
});

test('stand-up: schedule, skips people away / at lunch / on leave, turns, end', async () => {
  const a = await client('t12', 'ann@x.com');
  const b = await client('t12', 'bob@x.com');
  const c = await client('t12', 'cat@x.com');
  const d = await client('t12', 'dan@x.com');
  send(c, { type: 'status', state: 'lunch' });
  send(d, { type: 'status', state: 'leave' });
  send(a, { type: 'standup:config', standup: { enabled: true, time: '09:30', days: [1, 2, 3, 4, 5], tz: 'Europe/London', perPerson: 60 } });
  await wait(100);
  assert.equal(last(b, 'team').teamCfg.standup.time, '09:30');
  send(b, { type: 'standup:start' });
  await wait(100);
  const su = last(a, 'standup').standup;
  assert.deepEqual(su.order, ['ann@x.com', 'bob@x.com']);
  assert.equal(su.turn, 0);
  send(c, { type: 'status', state: 'desk' });          // back from lunch: joins the end of the line
  await wait(100);
  assert.deepEqual(last(a, 'standup').standup.order, ['ann@x.com', 'bob@x.com', 'cat@x.com']);
  send(a, { type: 'standup:next' });
  await wait(80);
  assert.equal(last(a, 'standup').standup.turn, 1);
  send(b, { type: 'standup:end' });
  await wait(80);
  assert.equal(last(c, 'standup').standup, null);
  [a, b, c, d].forEach(w => w.close());
});

test('next stand-up time respects the team time zone and days', async () => {
  const { nextStandup } = await import('../server/room.js');
  const cfg = { enabled: true, time: '09:30', days: [1, 2, 3, 4, 5], tz: 'Europe/London' };
  // Friday 16 Oct 2026 13:00 UTC → Monday 19 Oct 09:30 BST (08:30 UTC)
  assert.equal(new Date(nextStandup(cfg, Date.UTC(2026, 9, 16, 13))).toISOString(), '2026-10-19T08:30:00.000Z');
  // after the clocks change: Monday 26 Oct 09:30 GMT (09:30 UTC)
  assert.equal(new Date(nextStandup(cfg, Date.UTC(2026, 9, 23, 13))).toISOString(), '2026-10-26T09:30:00.000Z');
  assert.equal(nextStandup({ ...cfg, enabled: false }), null);
});
