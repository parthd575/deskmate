// Deskmate in-page pop-ups. Runs on every page but does nothing until the
// extension asks it to show a bubble (help request, call, wave).
(() => {
  if (window.top !== window || window.__deskmate) return;
  window.__deskmate = true;

  let host = null;
  const frames = new Map(); // id -> iframe

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return host;
    host = document.createElement('div');
    host.setAttribute('data-deskmate', '');
    Object.assign(host.style, {
      position: 'fixed', top: '64px', right: '8px', zIndex: '2147483647',
      display: 'flex', flexDirection: 'column', gap: '0px', pointerEvents: 'none',
      width: '380px', maxHeight: 'calc(100vh - 80px)', overflow: 'visible',
    });
    document.documentElement.appendChild(host);
    return host;
  }

  function show(data) {
    if (frames.has(data.id)) return;
    const h = ensureHost();
    while (frames.size >= 3) remove(frames.keys().next().value);
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('bubble/bubble.html') + '#' + encodeURIComponent(JSON.stringify(data));
    f.setAttribute('allowtransparency', 'true');
    f.setAttribute('title', 'Deskmate');
    Object.assign(f.style, {
      width: '380px', height: '150px', border: '0', background: 'transparent', colorScheme: 'normal',
      pointerEvents: 'auto', display: 'block', margin: '0',
    });
    h.prepend(f);
    frames.set(data.id, f);
  }

  function remove(id) {
    const f = frames.get(id);
    if (!f) return;
    f.remove();
    frames.delete(id);
    if (!frames.size && host) { host.remove(); host = null; }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'deskmate:bubble') show(msg.data);
  });

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !String(d.type || '').startsWith('deskmate:')) return;
    // only trust messages coming from our own bubble frames
    const entry = [...frames.entries()].find(([, f]) => f.contentWindow === e.source);
    if (!entry) return;
    if (d.type === 'deskmate:close') remove(entry[0]);
    if (d.type === 'deskmate:height') entry[1].style.height = Math.min(220, Math.max(60, d.height)) + 'px';
  });
})();
