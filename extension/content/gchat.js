// Reads YOUR Google Chat status from the Google Chat / Gmail page you have open (no Google API,
// no sign-in prompt) and passes it to Deskmate. The status chip at the top of Chat looks like:
//   <div role="button" aria-label="Status: Active, In a meeting" data-tooltip="In a meeting">
// The part before the comma is the availability (Active / Away / Do not disturb); the part after
// it is the detail: an automatic one (In a meeting, Out of office…) or your custom status.
(() => {
  const SELECTOR = '[role="button"][aria-label^="Status:" i], [role="button"][aria-label^="Status :" i]';
  let last = null;

  function read() {
    const el = document.querySelector(SELECTOR);
    if (!el) return null;
    const label = el.getAttribute('aria-label').replace(/^status\s*:\s*/i, '').trim();
    const [availability, ...rest] = label.split(',').map(s => s.trim());
    const detail = rest.join(', ') || (el.getAttribute('data-tooltip') || '').trim();
    return { availability, detail: detail === availability ? '' : detail };
  }

  function check() {
    const s = read();
    if (!s) return;
    const key = `${s.availability}|${s.detail}`;
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ type: 'gchat:status', ...s }); } catch { /* extension reloaded */ }
  }

  // the chip re-renders when the status changes: watch the page, and poll as a backstop
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; check(); }, 400);
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'data-tooltip'] });
  setInterval(check, 15000);
  // tell Deskmate again now and then, so it picks the status up after the extension restarts
  setInterval(() => { last = null; check(); }, 5 * 60 * 1000);
  check();
})();
