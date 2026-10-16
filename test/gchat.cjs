// Google Chat status without the Google API: a stand-in chat.google.com page with the real
// status chip markup; changing it should change Bob's Deskmate status for Alice.
// Run:  node server/index.js &   then   node test/gchat.cjs
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
const EXT = path.resolve(__dirname, '../extension');
const SERVER = process.env.SERVER || 'ws://localhost:8787';
const TEAM = 'gchat-' + Date.now().toString(36);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const chip = (label, tip) => `<div aria-label="Status: ${label}" class="lJradf XQuz9d X72uL" role="button" tabindex="0" data-tooltip="${tip}"><div class="uJfPte"></div></div>`;

async function person(name) {
  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-'));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://chat.google.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: `<title>Chat</title><header id="h">${chip('Active', 'Active')}</header>` }));
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
  return { ctx, page };
}

(async () => {
  const fails = []; const check = (c, m) => { console.log((c ? '• PASS ' : '• FAIL ') + m); if (!c) fails.push(m); };
  const alice = await person('Alice'), bob = await person('Bob');
  const chat = await bob.ctx.newPage();
  await chat.goto('https://chat.google.com/');
  const row = () => alice.page.textContent('#people li[data-id="bob@x.com"]').then(t => t.replace(/\s+/g, ' ').trim());
  const set = (label, tip) => chat.evaluate(([l, t]) => { const el = document.querySelector('[role=button]'); el.setAttribute('aria-label', 'Status: ' + l); el.setAttribute('data-tooltip', t); }, [label, tip]);
  const steps = [
    ['Active, In a meeting', 'In a meeting', /meeting/i, 'In a meeting → Meeting'],
    ['Active', 'Active', /at desk/i, 'Back to Active → At desk'],
    ['Do not disturb, Deep work', 'Deep work', /focus/i, 'Do not disturb → Focus'],
    ['Active', 'Active', /at desk/i, 'Active again → At desk'],
    ['Away', 'Away', /away/i, 'Away → Away'],
    ['Do not disturb, In a meeting', 'In a meeting', /meeting/i, 'Do not disturb + In a meeting → Meeting, not Focus'],
    ['Active', 'Active', /at desk/i, 'Meeting over → At desk'],
    ['Active, 🏡 Working from home', '🏡 Working from home', /working from home/i, 'Custom status shows as the note'],
  ];
  for (const [label, tip, re, name] of steps) {
    await set(label, tip);
    let text = '';
    for (let i = 0; i < 20 && !re.test(text = await row()); i++) await wait(250);
    check(re.test(text), `${name} ("${text}")`);
  }
  await set('Do not disturb, In a meeting', 'In a meeting');
  await wait(1500);
  const here = await bob.page.getAttribute('#quick button[data-state=desk]', 'aria-checked');
  check(here === 'true', `In a meeting keeps "Here" selected for Bob (${here})`);
  // a Focus you set yourself in Deskmate isn't overridden by Chat
  await bob.page.click('#quick button[data-state=dnd]');
  await wait(800);
  await set('Active, In a meeting', 'In a meeting');
  await wait(2000);
  check(/focus/i.test(await row()), `Manual Focus is kept when Chat changes ("${await row()}")`);
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  await Promise.all([alice.ctx.close(), bob.ctx.close()]);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
