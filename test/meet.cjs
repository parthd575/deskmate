// Google Meet flow: Alice asks for help, Bob joins from the bubble → Bob's browser creates a
// Meet (meet.google.com/new is stubbed to redirect to a fixed code) → the same link opens for Alice.
// Run:  node server/index.js &   then   node test/meet.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
const EXT = path.resolve(__dirname, '../extension');
const SERVER = process.env.SERVER || 'ws://localhost:8787';
const WEB = SERVER.replace(/^ws/, 'http');
const TEAM = 'meet-' + Date.now().toString(36);
const CODE = 'abc-defg-hij';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function person(name) {
  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-'));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://meet.google.com/**', route => {
    const u = route.request().url();
    if (u.endsWith('/new')) return route.fulfill({ status: 302, headers: { location: `https://meet.google.com/${CODE}?authuser=0` } });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Meet</title>Meet stub' });
  });
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
  return { ctx, page, sw };
}

(async () => {
  const fails = []; const check = (c, m) => { console.log((c ? '• PASS ' : '• FAIL ') + m); if (!c) fails.push(m); };
  const alice = await person('Alice'), bob = await person('Bob');
  const web = await bob.ctx.newPage(); await web.goto(WEB + '/'); await web.bringToFront();
  await alice.page.fill('#askInput', 'Need a hand'); await alice.page.click('#askForm button[type=submit]');
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 });
  await wait(800);
  const isMeet = p => p.url().startsWith(`https://meet.google.com/${CODE}`);
    await web.frames().find(f => f.url().includes('/bubble/bubble.html')).click('.acts .primary');
  // Bob's tab opens meet.google.com/new; Google then redirects it to the new meeting's code.
  // (Here: wait for that tab, then send it to the stubbed meeting URL.)
  const t0 = Date.now(); let bobTab;
  while (!(bobTab = bob.ctx.pages().find(p => /meet\.google\.com\/new|chrome-error/.test(p.url()))) && Date.now() - t0 < 10000) await wait(200);
  check(!!bobTab, 'Bob’s browser opened meet.google.com/new');
  if (bobTab) await bobTab.goto(`https://meet.google.com/${CODE}?authuser=0`).catch(() => {});
  await wait(2500);
  check(bob.ctx.pages().some(isMeet), 'Bob is in the Google Meet');
  const meetTabs = (u) => u.sw.evaluate(async () => (await chrome.tabs.query({})).map(t => t.pendingUrl || t.url).filter(x => /meet\.google\.com/.test(x || '')));
  const aTabs = await meetTabs(alice);
  check(aTabs.some(u => u.startsWith(`https://meet.google.com/${CODE}`)), `The same Meet link opened for Alice (${aTabs.join(', ') || 'none'})`);
  check(!bob.ctx.pages().concat(alice.ctx.pages()).some(p => p.url().includes('/call/call.html')), 'No WebRTC call window opened');
  const box = await alice.page.textContent('#helpBox');
  check(/Google Meet/.test(box), `Alice’s panel says Google Meet ("${box.trim().replace(/\s+/g, ' ').slice(0, 80)}")`);
  await alice.page.screenshot({ path: path.join(process.env.OUT || os.tmpdir(), 'meet-asker.png') });
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  await Promise.all([alice.ctx.close(), bob.ctx.close()]);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

