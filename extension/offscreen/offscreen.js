// Hidden page the service worker opens just to play notification sounds
// (service workers can't play audio themselves).
import { playChime } from '../lib/chime.js';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'deskmate:chime') return;
  playChime(msg.kind, msg.volume).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
  return true;
});
