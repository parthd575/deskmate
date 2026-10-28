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
// a stand-in for the Meet call screen: a Leave call button that swaps to "You left the meeting"
// (the button only has Meet's "call_end" icon, no English label, like Meet in another language)
const STUB = `<title>Meet</title><main>In the call <button id="hangup" onclick="document.body.textContent='You left the meeting'"><i class="google-material-icons">call_end</i></button></main>`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function person(name) {
  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-'));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://meet.google.com/**', route => {
    const u = route.request().url();
    if (u.endsWith('/new')) return route.fulfill({ status: 302, headers: { location: `https://meet.google.com/${CODE}?authuser=0` } });
    return route.fulfill({ status: 200, contentType: 'text/html', body: STUB });
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
  const web = await bob.ctx.newPage(); await web.goto(WEB + '/');
  const meetTabs = (u) => u.page.evaluate(async () => (await chrome.tabs.query({})).map(t => t.pendingUrl || t.url).filter(x => /meet\.google\.com/.test(x || '')));
  const isMeet = (code) => (p) => p.url().startsWith(`https://meet.google.com/${code}`);

  // Alice asks, Bob taps Join on the bubble, Bob's browser makes the Meet, Alice's opens it
  async function round(code, label) {
    await web.bringToFront();
    await alice.page.fill('#askInput', label); await alice.page.click('#askForm button[type=submit]');
    await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 });
    await wait(800);
    await web.frames().find(f => f.url().includes('/bubble/bubble.html')).click('.acts .primary');
    // Bob's tab opens meet.google.com/new; Google then redirects it to the new meeting's code.
    // (Here: wait for that tab, then send it to the stubbed meeting URL.)
    const t0 = Date.now(); let bobTab;
    while (!(bobTab = bob.ctx.pages().find(p => /meet\.google\.com\/new|chrome-error/.test(p.url()))) && Date.now() - t0 < 10000) await wait(200);
    if (bobTab) await bobTab.goto(`https://meet.google.com/${code}?authuser=0`).catch(() => {});
    await wait(2500);
    const aTabs = await meetTabs(alice);
    check(bob.ctx.pages().some(isMeet(code)) && aTabs.some(u => u.startsWith(`https://meet.google.com/${code}`)),
      `[${label}] Bob made the Meet and the same link opened for Alice (${aTabs.join(', ') || 'none'})`);
    return bob.ctx.pages().find(isMeet(code));
  }
  async function endedForBoth(label) {
    await wait(2500);
    const left = [...(await meetTabs(alice)), ...(await meetTabs(bob))];
    check(left.length === 0, `[${label}] Meet closed for both (${left.join(', ') || 'no Meet tabs left'})`);
    check(!!(await alice.page.$('#askForm')), `[${label}] request closed — Alice can ask again`);
  }

  // 1) End call in the Deskmate panel
  await round('abc-defg-hia', 'End call');
  check(!bob.ctx.pages().concat(alice.ctx.pages()).some(p => p.url().includes('/call/call.html')), 'No WebRTC call window opened');
  const box = await alice.page.textContent('#helpBox');
  check(/Google Meet/.test(box), `Alice’s panel says Google Meet ("${box.trim().replace(/\s+/g, ' ').slice(0, 60)}")`);
  // "Open call" (twice) goes back to the same meeting: no second meeting, no duplicate tab
  await alice.page.click('#openCall');
  await wait(800);
  await alice.page.click('#openCall');
  await wait(1200);
  const aTabsAfter = await meetTabs(alice);
  check(aTabsAfter.length === 1 && aTabsAfter[0].startsWith('https://meet.google.com/abc-defg-hia'), `Open call reuses the same meeting (${aTabsAfter.join(', ')})`);
  await bob.page.bringToFront();
  await bob.page.click('#feed [data-end]');
  await endedForBoth('End call');

  // Chrome stops an idle extension service worker after ~30 s, so in a real meeting the worker
  // is usually asleep by the time someone leaves. Stop Bob's worker to test exactly that.
  async function stopWorker(u) {
    const cdp = await u.page.context().newCDPSession(u.page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes('background.js'));
    if (sw) await cdp.send('Target.closeTarget', { targetId: sw.targetId }).catch(() => {});
    await wait(1500);
    return !!sw;
  }

  // 2) Bob presses Meet's own Leave call button (worker asleep)
  const tab2 = await round('abc-defg-hib', 'Leave call');
  await wait(1500); // let the page notice it's in the call
  check(await stopWorker(bob), '[Leave call] stopped Bob’s service worker mid-call');
  await tab2.click('#hangup');
  await endedForBoth('Leave call');

  // 6) Google got Bob to the meeting before his browser noted the tab down (missed event):
  //    Alice taps Open call once → Bob's browser is nudged → it shares the link → Alice joins
  await web.bringToFront();
  await alice.page.fill('#askInput', 'Missed event'); await alice.page.click('#askForm button[type=submit]');
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 });
  await wait(800);
  await web.frames().find(f => f.url().includes('/bubble/bubble.html')).click('.acts .primary');
  const t3 = Date.now(); let bobTab6;
  while (!(bobTab6 = bob.ctx.pages().find(p => /meet\.google\.com\/new|chrome-error/.test(p.url()))) && Date.now() - t3 < 10000) await wait(200);
  // hide the job, let the tab reach the meeting, then put the job back (= the race)
  const job = await bob.page.evaluate(async () => { const m = (await chrome.storage.session.get('making')).making || {}; await chrome.storage.session.set({ making: {} }); return m; });
  await bobTab6.goto('https://meet.google.com/abc-defg-hif?authuser=0').catch(() => {});
  await wait(1500);
  await bob.page.evaluate(async (m) => { await chrome.storage.session.set({ making: m }); }, job);
  check((await meetTabs(alice)).length === 0, 'Alice has no link yet (the share was missed)');
  await alice.page.bringToFront();
  await alice.page.click('#openCall');
  await wait(3000);
  const a6 = await meetTabs(alice);
  check(a6.length === 1 && a6[0].startsWith('https://meet.google.com/abc-defg-hif'), `One tap on Open call fetches the link Bob is already in (${a6.join(', ') || 'none'})`);
  await alice.page.click('#helpBox #endCall');
  await endedForBoth('Missed event');

  // 5) Bob's browser never finishes making the Meet (e.g. stuck on Google's sign-in):
  //    Alice taps Open call twice → her browser makes it → Bob is sent the same link
  await web.bringToFront();
  await alice.page.fill('#askInput', 'Stuck maker'); await alice.page.click('#askForm button[type=submit]');
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 });
  await wait(800);
  await web.frames().find(f => f.url().includes('/bubble/bubble.html')).click('.acts .primary');
  await wait(2000);   // Bob's tab sits on meet.google.com/new
  await alice.page.bringToFront();
  await alice.page.click('#openCall');
  await wait(600);
  await alice.page.click('#openCall');
  const t2 = Date.now(); let aliceMaking;
  while (!(aliceMaking = alice.ctx.pages().find(p => /meet\.google\.com\/new|chrome-error/.test(p.url()))) && Date.now() - t2 < 10000) await wait(200);
  check(!!aliceMaking, 'Second tap on Open call starts the meeting in Alice’s browser');
  if (aliceMaking) await aliceMaking.goto('https://meet.google.com/abc-defg-hie?authuser=0').catch(() => {});
  await wait(3000);
  const bRe = await meetTabs(bob);
  check(bRe.length === 1 && bRe[0].startsWith('https://meet.google.com/abc-defg-hie'), `Bob gets Alice’s link and his stuck tab is closed (${bRe.join(', ') || 'none'})`);
  await alice.page.click('#helpBox #endCall');
  await endedForBoth('Rehost');

  // 4) Direct call: Bob calls Alice → she's rung at once → same meeting for both
  const aliceWeb = await alice.ctx.newPage(); await aliceWeb.goto(WEB + '/'); await aliceWeb.bringToFront();
  await bob.page.bringToFront();
  await bob.page.evaluate(() => document.querySelector('#people li[data-id="alice@x.com"] [data-call]').click());
  await aliceWeb.waitForSelector('iframe[title=Deskmate]', { timeout: 8000 }).catch(() => {});
  await wait(1200);
  const ring = aliceWeb.frames().find(f => f.url().includes('/bubble/bubble.html'));
  await ring?.waitForFunction(() => document.querySelector('#title')?.textContent, null, { timeout: 8000 }).catch(() => {});
  const ringText = ring ? await ring.textContent('#title') : '';
  check(/Bob is calling you/.test(ringText), `Alice is rung straight away ("${ringText.replace(/\s+/g, ' ').trim().slice(0, 50)}")`);
  const sound = await alice.page.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  check(sound > 0, 'A ring sound played for Alice');
  const t1 = Date.now(); let bobCallTab;
  while (!(bobCallTab = bob.ctx.pages().find(p => /meet\.google\.com\/new|chrome-error/.test(p.url()))) && Date.now() - t1 < 10000) await wait(200);
  check(!!bobCallTab, 'Bob’s browser is making the meeting');
  if (bobCallTab) await bobCallTab.goto('https://meet.google.com/abc-defg-hid?authuser=0').catch(() => {});
  await wait(1500);
  await ring?.click('.acts .primary').catch(() => {});
  await wait(2500);
  const aCall = await meetTabs(alice), bCall = await meetTabs(bob);
  check(aCall.length === 1 && aCall[0].startsWith('https://meet.google.com/abc-defg-hid') && bCall.length === 1, `Same meeting for both (Alice: ${aCall.join(', ') || 'none'} · Bob: ${bCall.join(', ') || 'none'})`);
  await aliceWeb.close();
  // Alice hangs up by closing her Meet tab → Bob's closes too
  const aTab = alice.ctx.pages().find(isMeet('abc-defg-hid'));
  if (aTab) await aTab.close(); else await alice.page.evaluate(async () => { for (const t of await chrome.tabs.query({ url: 'https://meet.google.com/*' })) await chrome.tabs.remove(t.id); });
  await wait(2500);
  check((await meetTabs(bob)).length === 0, 'Closing the Meet ends the direct call for both');

  // 3) Bob just closes his Meet tab (worker asleep)
  const tab3 = await round('abc-defg-hic', 'Close tab');
  await stopWorker(bob);
  await tab3.close();
  await endedForBoth('Close tab');

  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  await Promise.all([alice.ctx.close(), bob.ctx.close()]);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

