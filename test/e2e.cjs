// End-to-end: three Chrome profiles with the extension, statuses, a help request,
// the in-page bubble, and a real WebRTC audio call.
// Run:  node server/index.js &   then   xvfb-run node test/e2e.cjs   (or on a desktop: node test/e2e.cjs)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EXT = path.resolve(__dirname, '../extension');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots');
const SERVER = process.env.SERVER || 'ws://localhost:8787';
const WEB = SERVER.replace(/^ws/, 'http');
const TEAM = 'qa-' + Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

async function launch(name) {
  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    // new headless mode supports extensions; set HEADED=1 to watch it run
    ...(process.env.HEADED ? { headless: false } : { channel: 'chromium', headless: true }),
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--window-size=1280,860',
    ],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  return { ctx, id, name, sw };
}

async function setup(u, color, lite = false) {
  const page = await u.ctx.newPage();
  page.on('pageerror', e => console.log(`[${u.name} pageerror]`, e.message));
  page.on('console', m => { if (m.type() === 'error') console.log(`[${u.name} console]`, m.text()); });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`chrome-extension://${u.id}/sidepanel/sidepanel.html${lite ? '?lite' : ''}`);
  await page.waitForSelector('#setup:not([hidden])');
  await page.fill('input[name=name]', u.name);
  await page.fill('input[name=email]', `${u.name.toLowerCase()}@elevationservices.co.uk`);
  await page.fill('input[name=team]', TEAM);
  await page.evaluate(() => { document.querySelector('#advanced').open = true; });
  await page.fill('input[name=server]', SERVER);
  // pick a character (the first N differ per person)
  const chars = await page.$$('#charGrid button');
  if (chars.length) await chars[['#EC4899', '#14B8A6', '#F59E0B'].indexOf(color) % chars.length].click();
  await page.click('#saveBtn');
  await page.waitForSelector('#desk:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#conn')?.classList.contains('online'), null, { timeout: 10000 });
  u.page = page;
  return page;
}

(async () => {
  const fails = [];
  const check = (cond, msg) => { log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };

  const alice = await launch('Alice');
  const bob = await launch('Bob');
  const cara = await launch('Cara');
  // only Bob renders the 3D desk: three software-rendered scenes starve small CI machines
  await setup(alice, '#EC4899', true);
  await setup(bob, '#14B8A6');
  await setup(cara, '#F59E0B', true);
  await wait(1500);

  const count = await bob.page.$$eval('#people li', li => li.length);
  check(count === 3, `Bob sees 3 teammates (got ${count})`);
  await bob.page.screenshot({ path: `${OUT}/01-desk-all-here.png` });

  // Alice goes to lunch, Cara goes BRB
  await alice.page.click('#quick button[data-state=lunch]');
  await cara.page.click('#quick button[data-state=brb]');
  await wait(3500);
  const aliceRow = await bob.page.textContent('#people li[data-id="alice@elevationservices.co.uk"]');
  check(/lunch/i.test(aliceRow), `Bob sees Alice at lunch ("${aliceRow.trim().replace(/\s+/g, ' ')}")`);
  await bob.page.screenshot({ path: `${OUT}/02-desk-lunch-brb.png` });

  // Alice back; Cara focuses; Bob opens a normal web page; Alice asks for help
  await alice.page.click('#quick button[data-state=desk]');
  await cara.page.click('#quick button[data-state=dnd]');
  const web = await bob.ctx.newPage();
  await web.setViewportSize({ width: 1100, height: 700 });
  await web.goto(WEB + '/');
  await web.bringToFront();
  await wait(800);
  await alice.page.fill('#askInput', 'Deploy pipeline failing on step 3');
  await alice.page.click('#askForm button[type=submit]');
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 })
    .then(() => check(true, 'Help bubble appeared on Bob’s open web page'), () => check(false, 'Help bubble appeared on Bob’s open web page'));
  await wait(1500);
  const sound = await bob.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).map(c => c.documentUrl));
  check(sound.some(u => u.endsWith('/offscreen/offscreen.html')), `Help sound played on Bob’s computer (${sound.join(', ') || 'no sound page'})`);
  await web.screenshot({ path: `${OUT}/03-help-bubble.png` });
  await bob.page.screenshot({ path: `${OUT}/04-desk-help-request.png` });

  // Cara is in Focus mode: no bubble for her
  const caraWeb = await cara.ctx.newPage();
  await caraWeb.goto(WEB + '/');
  await wait(300);

  // Bob clicks Join call inside the bubble → both get call windows
  const newCall = (u) => u.ctx.waitForEvent('page', { predicate: p => p.url().includes('/call/call.html'), timeout: 40000 });
  const aCallP = newCall(alice), bCallP = newCall(bob);
  const frame = web.frames().find(f => f.url().includes('/bubble/bubble.html'));
  await frame.click('.acts .primary');
  const [aCall, bCall] = await Promise.all([aCallP, bCallP]);
  check(!!aCall && !!bCall, 'Call windows opened for both Alice (asker) and Bob (helper)');
  for (const p of [aCall, bCall]) p.on('pageerror', e => console.log('[call pageerror]', e.message));
  const connected = () => !!globalThis.__call && [...globalThis.__call.peers.values()].some(p => p.pc.connectionState === 'connected');
  await bCall.waitForFunction(connected, null, { timeout: 45000 })
    .then(() => check(true, 'WebRTC call connected (same room for asker and helper)'), () => check(false, 'WebRTC call connected'));
  check(await bCall.textContent('#count') === '2', 'Bob’s call shows 2 people');
  // camera video from Alice reaches Bob
  await bCall.waitForFunction(() => [...globalThis.__call.peers.values()].some(p => p.cam?.videoWidth > 0 && p.state.cam), null, { timeout: 20000 })
    .then(() => check(true, 'Alice’s camera video plays in Bob’s call'), () => check(false, 'Alice’s camera video plays in Bob’s call'));
  // Alice shares her screen (a stand-in canvas instead of the system picker)
  await aCall.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      const g = c.getContext('2d');
      setInterval(() => { g.fillStyle = `hsl(${Date.now() / 20 % 360} 70% 50%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('Alice’s screen', 380, 380); }, 100);
      return c.captureStream(10);
    };
  });
  await aCall.click('#share');
  await bCall.waitForFunction(() => !document.querySelector('#stage').hidden && document.querySelector('#stageVideo').videoWidth > 0, null, { timeout: 20000 })
    .then(() => check(true, 'Bob sees Alice presenting her screen'), async () => check(false, `Bob sees Alice presenting (${await bCall.textContent('#stageLabel')})`));
  await bCall.setViewportSize({ width: 1000, height: 640 });
  await wait(1500);
  await bCall.screenshot({ path: `${OUT}/05-call-window.png` });
  await aCall.click('#share');   // stop presenting
  await bCall.waitForFunction(() => document.querySelector('#stage').hidden, null, { timeout: 10000 })
    .then(() => check(true, 'Presenting stops for Bob too'), () => check(false, 'Presenting stops for Bob too'));
  await bCall.screenshot({ path: `${OUT}/05b-call-grid.png` });

  // Everyone else sees Alice & Bob on a call
  await wait(800);
  const caraView = await cara.page.textContent('#people');
  check(/On a call/.test(caraView), 'Cara sees Alice and Bob “On a call”');
  const caraBubbles = await caraWeb.$$('iframe[title=Deskmate]');
  check(caraBubbles.length === 0, 'Cara (Focus mode) was not interrupted by a pop-up');
  await bob.page.screenshot({ path: `${OUT}/06-desk-on-call.png` });

  // Bob waves at Cara via the person card
  await bob.page.click('#people li[data-id="cara@elevationservices.co.uk"]');
  await wait(300);
  await bob.page.screenshot({ path: `${OUT}/07-person-card.png` });
  await bob.page.click('#personCard [data-a=wave]');

  // Bob leaves → Alice is told
  // Bob ends the call from the side panel
  await bob.page.bringToFront();
  await bob.page.click('#feed [data-end]');
  await wait(1500);
  const aNote = await aCall.textContent('#note').catch(() => 'call window closed');
  check(/ended|closed/.test(aNote), `Alice's call ends when Bob taps End call ("${aNote}")`);
  const askBack = await alice.page.$('#askForm');
  check(!!askBack, 'Alice can ask for help again (request closed)');

  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  await Promise.all([alice.ctx.close(), bob.ctx.close(), cara.ctx.close()]);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
