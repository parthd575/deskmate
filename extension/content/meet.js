// Runs on meet.google.com. Tells Deskmate which tab shows which meeting, and when you leave it
// with Meet's own red "Leave call" button, so Deskmate can end the help request (and close the
// Meet for the other person). Deskmate ignores meetings that aren't one of its help calls.
(() => {
  const codeOf = () => location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|\/)/)?.[1] || null;
  const tell = (type, code) => { try { chrome.runtime.sendMessage({ type, url: `https://meet.google.com/${code}` }); } catch {} };

  // The hang-up button. Meet draws its icon with the Material Symbols ligature "call_end", which
  // doesn't change with the UI language; jsname and the English label are extra fallbacks.
  const isLeaveButton = (el) => {
    const b = el?.closest?.('button, [role="button"]');
    if (!b) return null;
    if (b.matches('[jsname="CQylAd"], [aria-label*="leave call" i], [aria-label*="hang up" i]')) return b;
    return [...b.querySelectorAll('i, span')].some(i => i.textContent.trim() === 'call_end') ? b : null;
  };
  const leaveButtonOnPage = () =>
    document.querySelector('[jsname="CQylAd"], button[aria-label*="leave call" i]') ||
    [...document.querySelectorAll('i, span')].find(i => i.textContent.trim() === 'call_end' && i.closest('button, [role="button"]'));

  let code = null, joined = false, missing = 0, sent = false;
  const left = () => { if (!sent && code) { sent = true; tell('meet:left', code); } };

  // instant path: the click on Leave call
  addEventListener('click', (e) => { if (joined && isLeaveButton(e.target)) left(); }, true);

  setInterval(() => {
    const now = codeOf();
    if (now !== code) { // first load, or Meet moved to another meeting in this tab
      if (code && joined) left();
      code = now; joined = false; missing = 0; sent = false;
      if (code) tell('meet:open', code);
    }
    if (!code || sent) return;
    // fallback: the in-call controls were there and have gone ("You left the meeting" screen)
    if (leaveButtonOnPage()) { joined = true; missing = 0; }
    else if (joined && ++missing >= 3) left();
  }, 1000);
})();
