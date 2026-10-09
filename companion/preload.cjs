// Exposes the same `deskBridge` interface the Chrome extension UI uses,
// so the side panel, bubble and call pages run unchanged inside the Mac app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskBridge', {
  platform: 'companion',
  onState(cb) {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state', h);
    ipcRenderer.invoke('get-state').then(cb);
    return () => ipcRenderer.removeListener('state', h);
  },
  onEvent(cb) {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('event', h);
    return () => ipcRenderer.removeListener('event', h);
  },
  onBubble(cb) { ipcRenderer.on('bubble', (_e, m) => cb(m)); },
  action: (name, args) => ipcRenderer.send('action', name, args || {}),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  profile: () => ipcRenderer.invoke('profile'),
  callConfig: () => ipcRenderer.invoke('call-config'),
  closeWindow: () => ipcRenderer.send('close-window'),
});
