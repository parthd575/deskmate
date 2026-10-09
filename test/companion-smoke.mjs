// Runs inside the Electron main process (DESKMATE_SMOKE=this file).
// Opens the panel, gets a help request from a bot, accepts it, and checks the call connects.
import { app } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const WebSocket = createRequire(process.cwd() + '/package.json')('ws');

const OUT = process.env.OUT || '/tmp';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const d = globalThis.deskmate;
const shot = async (wc, name) => fs.writeFileSync(`${OUT}/${name}.png`, (await wc.capturePage()).toPNG());
const results = [];
const check = (ok, msg) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

(async () => {
  try {
    await wait(2500);
    check(d.client.state.conn === 'online', `companion connected (${d.client.state.conn})`);
    d.togglePanel();
    await wait(2500);
    await shot(d.panel.webContents, 'c1-panel');

    // a bot teammate joins and asks for help
    const team = d.client.settings.team;
    const bot = new WebSocket(d.client.settings.server);
    await new Promise(r => bot.on('open', r));
    bot.send(JSON.stringify({ type: 'hello', team, role: 'main', user: { id: 'sam@example.com', name: 'Sam Rivera', color: '#0EA5E9', avatar: { skin: '#C68B62', hair: '#2B2118', style: 'curly' } } }));
    await wait(500);
    bot.send(JSON.stringify({ type: 'help', topic: 'Figma export keeps failing' }));
    await wait(2500);
    const bubble = [...d.bubbles.values()][0];
    check(!!bubble, 'help bubble window appeared over other apps');
    if (bubble) await shot(bubble.webContents, 'c2-bubble');

    // accept from the bubble
    if (bubble) console.log('click result', await bubble.webContents.executeJavaScript(`(() => { const b = document.querySelector('.acts .primary'); if (!b) return 'no button: ' + document.body.innerHTML.slice(0, 300); b.click(); return 'clicked ' + typeof window.deskBridge; })()`));
    await wait(2500);

    check(!!d.callWin, 'call window opened in the Mac app');
    await wait(2500);
    // bot joins the call as a signalling peer? (audio peer needs a browser) — just check we joined the call room
    const inCall = d.client.snapshot().calls.some(c => c.participants.includes(d.client.state.me.id));
    check(inCall, 'companion joined the help huddle');
    if (d.callWin) await shot(d.callWin.webContents, 'c3-call');
    bot.close();
  } catch (e) {
    results.push('FAIL exception ' + e.stack);
  }
  console.log('\n' + results.join('\n'));
  app.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})();
