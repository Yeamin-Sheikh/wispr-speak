const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wisprtell', {
  // capture window
  onCaptureStart: cb => ipcRenderer.on('capture-start', cb),
  onCaptureStop: cb => ipcRenderer.on('capture-stop', cb),
  sendCaptureData: buf => ipcRenderer.send('capture-data', buf),
  sendCaptureError: msg => ipcRenderer.send('capture-error', msg),
  sendMicLevel: l => ipcRenderer.send('mic-level', l),

  // pill
  onPillState: cb => ipcRenderer.on('pill-state', (_e, s) => cb(s)),
  onMicLevel: cb => ipcRenderer.on('mic-level', (_e, l) => cb(l)),
  toggleHandsFree: () => ipcRenderer.send('toggle-handsfree'),

  // dashboard / settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: patch => ipcRenderer.invoke('set-config', patch),
  getHistory: () => ipcRenderer.invoke('get-history'),
  updateHistoryItem: payload => ipcRenderer.invoke('update-history-item', payload),
  deleteHistory: id => ipcRenderer.invoke('delete-history', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  exportProfile: () => ipcRenderer.invoke('export-profile'),
  importProfile: data => ipcRenderer.invoke('import-profile', data),
  onHistoryUpdated: cb => ipcRenderer.on('history-updated', (_e, data) => cb(data)),
  onNavTo: cb => ipcRenderer.on('nav-to', (_e, target) => cb(target)),
  listMics: () => ipcRenderer.invoke('list-mics'),
  welcomeDone: () => ipcRenderer.send('welcome-done'),
  openExternal: url => ipcRenderer.send('open-external', url),
  validateKey: key => ipcRenderer.invoke('validate-key', key),
  copyText: text => ipcRenderer.invoke('copy-text', text),
});
