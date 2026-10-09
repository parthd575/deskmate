// UI <-> background bridge for the Chrome extension.
// The Mac companion provides the same interface as window.deskBridge.

export function createBridge() {
  const stateCbs = new Set();
  const eventCbs = new Set();
  let port = null;
  let last = null;

  const connect = () => {
    port = chrome.runtime.connect({ name: 'ui' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'state') { last = msg.state; stateCbs.forEach(cb => cb(msg.state)); }
      else if (msg.type === 'event') eventCbs.forEach(cb => cb(msg.event));
    });
    // the service worker can be restarted by Chrome; just reconnect
    port.onDisconnect.addListener(() => setTimeout(connect, 300));
  };
  connect();

  return {
    platform: 'extension',
    onState(cb) { stateCbs.add(cb); if (last) cb(last); return () => stateCbs.delete(cb); },
    onEvent(cb) { eventCbs.add(cb); return () => eventCbs.delete(cb); },
    action(name, args = {}) {
      try { port.postMessage({ type: 'action', name, args }); }
      catch { chrome.runtime.sendMessage({ type: 'action', name, args }); }
    },
    async getSettings() { return (await chrome.storage.sync.get('settings')).settings || null; },
    saveSettings(settings) { return chrome.runtime.sendMessage({ type: 'settings:save', settings }); },
    profile() { return chrome.runtime.sendMessage({ type: 'profile' }); },
    closeWindow() { window.close(); },
  };
}

export const bridge = globalThis.deskBridge || createBridge();
