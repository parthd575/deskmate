// Direct calls: Bob calls Alice → she's rung straight away (pop-up + sound) → she taps Join →
// both are in the same call room with audio + video. "Open call" on a help request goes back to
// the same call window instead of starting another one.
// Run:  node server/index.js &   then   node test/calls.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
const EXT = path.resolve(__dirname, '../extension');
const SERVER = process.env.SERVER || 'ws://localhost:8787';
const WEB = SERVER.replace(/^ws/, 'http');
const TEAM = 'calls-' + Date.now().toString(36);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function person(name) {
  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-'));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${sw.url().split('/')[2]}/sidepanel/sidepanel.html?lite`);
  await page.waitForSelector('#setup:not([hidden])');
  await page.fill('input[name=name]', name);
  await page.fill('input[name=email]', `${name.toLowerCase()}@x.com`);
  await page.fill('input[name=team]', TEAM);
  await page.evaluate(() => { document.querySelector('#advanced').open = true; });
  await page.fill('input[name=server]', SERVER);
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.querySelector('#conn')?.classList.contains('online'));
  return { ctx, page, name };
}
const callPages = (u) => u.ctx.pages().filter(p => p.url().includes('/call/call.html'));
const roomOf = (p) => new URL(p.url()).searchParams.get('id');
const connected = (p) => p.waitForFunction(() => !!globalThis.__call && [...globalThis.__call.peers.values()].some(x => x.pc.connectionState === 'connected'), null, { timeout: 30000 }).then(() => true, () => false);

(async () => {
  const fails = []; const check = (c, m) => { console.log((c ? '• PASS ' : '• FAIL ') + m); if (!c) fails.push(m); };
  const alice = await person('Alice'), bob = await person('Bob');

  // 1) direct call
  const aliceWeb = await alice.ctx.newPage(); await aliceWeb.goto(WEB + '/'); await aliceWeb.bringToFront();
  const bobWin = bob.ctx.waitForEvent('page', { predicate: p => p.url().includes('/call/call.html'), timeout: 10000 });
  await bob.page.evaluate(() => document.querySelector('#people li[data-id="alice@x.com"] [data-call]').click());
  const bCall = await bobWin;
  await aliceWeb.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 }).catch(() => {});
  const ring = aliceWeb.frames().find(f => f.url().includes('/bubble/bubble.html'));
  await ring?.waitForFunction(() => document.querySelector('#title')?.textContent, null, { timeout: 8000 }).catch(() => {});
  check(/Bob is calling you/.test(ring ? await ring.textContent('#title') : ''), 'Alice is rung straight away ("Bob is calling you")');
  const sound = await alice.page.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  check(sound > 0, 'A ring sound played for Alice');
  check(await bCall.waitForFunction(() => /Calling Alice/.test(document.querySelector('#title')?.textContent || ''), null, { timeout: 8000 }).then(() => true, () => false), 'Bob’s call window says "Calling Alice"');
  const aliceWin = alice.ctx.waitForEvent('page', { predicate: p => p.url().includes('/call/call.html'), timeout: 10000 });
  await ring?.click('.acts .primary');
  const aCall = await aliceWin;
  check(roomOf(aCall) === roomOf(bCall), `Same room for both (${roomOf(aCall)})`);
  check(await connected(aCall) && await connected(bCall), 'Call connects (audio + video)');
  check(await bCall.waitForFunction(() => [...globalThis.__call.peers.values()].some(p => p.cam?.videoWidth > 0), null, { timeout: 15000 }).then(() => true, () => false), 'Bob sees Alice’s camera');
  await aCall.click('#leave');
  await wait(5500);
  check(callPages(bob).length === 0, 'When Alice leaves, Bob’s call ends too');
  await aliceWeb.close();

  // 2) help request: Open call goes back to the same window/room
  const web = await bob.ctx.newPage(); await web.goto(WEB + '/'); await web.bringToFront();
  await alice.page.bringToFront();
  await alice.page.fill('#askInput', 'Need a hand'); await alice.page.click('#askForm button[type=submit]');
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 });
  await wait(800);
  await web.frames().find(f => f.url().includes('/bubble/bubble.html')).click('.acts .primary');
  await wait(3000);
  const a2 = callPages(alice), b2 = callPages(bob);
  check(a2.length === 1 && b2.length === 1 && roomOf(a2[0]) === roomOf(b2[0]), 'Asker and helper are in the same help room');
  await alice.page.bringToFront();
  await alice.page.click('#openCall');
  await wait(1000);
  await alice.page.click('#openCall');
  await wait(1500);
  const a3 = callPages(alice);
  check(a3.length === 1 && roomOf(a3[0]) === roomOf(b2[0]), 'Open call (twice) reuses the same call window and room');
  check(await connected(a3[0]), 'Still connected');

  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  await Promise.all([alice.ctx.close(), bob.ctx.close()]);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
