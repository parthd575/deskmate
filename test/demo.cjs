// Fills a team with simulated teammates and screenshots the desk (light + dark).
// Also handy for demos: `node test/demo.cjs --live` keeps the bots online.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const WebSocket = require('../server/node_modules/ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EXT = path.resolve(__dirname, '../extension');
const OUT = process.env.OUT || path.resolve(__dirname, 'shots');
const SERVER = process.env.SERVER || 'ws://localhost:8787';
const TEAM = process.env.TEAM || 'demo-' + Date.now().toString(36);
const LIVE = process.argv.includes('--live');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const BOTS = [
  { name: 'Priya Shah', color: '#EC4899', avatar: { skin: '#C68B62', hair: '#2B2118', style: 'long' }, status: { state: 'desk' } },
  { name: 'Tom Becker', color: '#2F6FD6', avatar: { skin: '#F5D0B5', hair: '#5A3825', style: 'spiky', glasses: 'sunglasses' }, status: { state: 'lunch', until: Date.now() + 25 * 60000 } },
  { name: 'Aisha Khan', color: '#A78BFA', avatar: { skin: '#8D5A3B', hair: '#2B2118', style: 'bun' }, status: { state: 'dnd', message: 'Q4 report' } },
  { name: 'Leo Martins', color: '#F59E0B', avatar: { skin: '#E8B48F', hair: '#5A3825', style: 'curly' }, status: { state: 'afk' } },
  { name: 'Mei Lin', color: '#14B8A6', avatar: { skin: '#F5D0B5', hair: '#2B2118', style: 'long' }, status: { state: 'desk' } },
];

function bot(b, i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SERVER);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', team: TEAM, role: 'main',
        user: { id: `bot${i}@example.com`, name: b.name, email: `bot${i}@example.com`, color: b.color, avatar: b.avatar, tz: ['Asia/Kolkata', 'Europe/London', 'America/New_York'][i % 3] },
        status: { ...b.status, source: 'manual' },
      }));
      setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 20000);
      setTimeout(() => resolve(ws), 200);
    });
  });
}

(async () => {
  const bots = [];
  for (let i = 0; i < BOTS.length; i++) bots.push(await bot(BOTS[i], i));
  if (LIVE) { console.log(`Bots online in team "${TEAM}" on ${SERVER}. Ctrl+C to stop.`); return; }

  const dir = fs.mkdtempSync(path.join(process.env.PROFILES || os.tmpdir(), 'deskmate-demo-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-swiftshader'],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
  await page.waitForSelector('#setup:not([hidden])');
  await wait(1200);
  await page.screenshot({ path: `${OUT}/00-setup.png` });
  await page.fill('input[name=name]', 'Parth Dave');
  await page.fill('input[name=email]', 'parth.dave@elevationservices.co.uk');
  await page.fill('input[name=team]', TEAM);
  await page.evaluate(() => { document.querySelector('#advanced').open = true; });
  await page.fill('input[name=server]', SERVER);
  await page.click('#saveBtn');
  await page.waitForSelector('#desk:not([hidden])');
  await wait(1500);

  // Priya asks for help, Mei and Priya... Mei raises a reaction
  bots[0].send(JSON.stringify({ type: 'help', topic: 'Can someone pair on the Stripe webhook bug?' }));
  await wait(400);
  bots[4].send(JSON.stringify({ type: 'react', emoji: '🎉' }));
  await wait(2500);
  await page.screenshot({ path: `${OUT}/10-team-light.png` });

  await page.emulateMedia({ colorScheme: 'dark' });
  await wait(1500);
  await page.screenshot({ path: `${OUT}/11-team-dark.png` });

  // bubble on a page, dark
  const web = await ctx.newPage();
  await web.setViewportSize({ width: 900, height: 360 });
  await web.goto(SERVER.replace(/^ws/, 'http') + '/');
  await web.bringToFront();
  await wait(500);
  bots[4].send(JSON.stringify({ type: 'call:invite', to: 'parth.dave@elevationservices.co.uk', callId: 'demo-call' }));
  await web.waitForSelector('iframe[title=Deskmate]', { timeout: 20000 }).catch(() => console.log('no invite bubble'));
  await wait(2500);
  await web.screenshot({ path: `${OUT}/12-invite-bubble.png` });

  await ctx.close();
  bots.forEach(b => b.close());
  console.log('Screenshots in', OUT);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
