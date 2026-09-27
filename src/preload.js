const { contextBridge, ipcRenderer } = require('electron');

// Direct MessagePort bridging for zero-copy audio IPC between windows
ipcRenderer.on('audio-port-setup', event => {
  const [port] = event.ports;
  window.postMessage({ type: 'AUDIO_PORT_OFFER' }, '*', [port]);
});

ipcRenderer.on('viz-port-setup', event => {
  const [port] = event.ports;
  window.postMessage({ type: 'VIZ_PORT_OFFER' }, '*', [port]);
});

contextBridge.exposeInMainWorld('wisprtell', {
  // capture window
  onCaptureStart: cb => ipcRenderer.on('capture-start', cb),
  onCaptureStop: cb => ipcRenderer.on('capture-stop', cb),
  sendCaptureData: (buf, compressedBuf) => ipcRenderer.send('capture-data', buf, compressedBuf),
  sendCaptureChunk: chunk => ipcRenderer.send('capture-chunk', chunk),
  sendCaptureError: msg => ipcRenderer.send('capture-error', msg),
  sendMicLevel: l => ipcRenderer.send('mic-level', l),

  // pill
  onPillState: cb => ipcRenderer.on('pill-state', (_e, s) => cb(s)),
  onMicLevel: cb => ipcRenderer.on('mic-level', (_e, l) => cb(l)),
  toggleHandsFree: () => ipcRenderer.send('toggle-handsfree'),
  movePillByDelta: delta => ipcRenderer.send('pill-move-delta', delta),
  savePillPosition: () => ipcRenderer.invoke('save-pill-position'),

  // theme synchronization
  onThemeSync: cb => ipcRenderer.on('theme-sync', (_e, data) => cb(data)),
  getTheme: () => ipcRenderer.invoke('get-theme'),

  // dashboard / settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: patch => ipcRenderer.invoke('set-config', patch),
  getHistory: () => ipcRenderer.invoke('get-history'),
  updateHistoryItem: payload => ipcRenderer.invoke('update-history-item', payload),
  deleteHistory: id => ipcRenderer.invoke('delete-history', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: data => ipcRenderer.invoke('import-data'),
  exportProfile: () => ipcRenderer.invoke('export-data'),
  importProfile: data => ipcRenderer.invoke('import-data'),
  learnCorrection: payload => ipcRenderer.invoke('learn-correction', payload),
  onDictionaryUpdated: cb => ipcRenderer.on('dictionary-updated', (_e, data) => cb(data)),
  onHistoryUpdated: cb => ipcRenderer.on('history-updated', (_e, data) => cb(data)),
  onNavTo: cb => ipcRenderer.on('nav-to', (_e, target) => cb(target)),
  listMics: () => ipcRenderer.invoke('list-mics'),
  welcomeDone: () => ipcRenderer.send('welcome-done'),
  openExternal: url => ipcRenderer.send('open-external', url),
  validateKey: key => ipcRenderer.invoke('validate-key', key),
  copyText: text => ipcRenderer.invoke('copy-text', text),

  // personas and context polish
  getPersonas: () => ipcRenderer.invoke('get-personas'),
  setActivePersona: id => ipcRenderer.invoke('set-active-persona', id),
  savePersona: p => ipcRenderer.invoke('save-persona', p),
  deletePersona: id => ipcRenderer.invoke('delete-persona', id),
  setContextPolish: enabled => ipcRenderer.invoke('set-context-polish', enabled),
  previewPolish: params => ipcRenderer.invoke('preview-polish', params),

  // audio history and offline reset
  getHistoryAudio: id => ipcRenderer.invoke('get-history-audio', id),
  deleteHistoryAudio: id => ipcRenderer.invoke('delete-history-audio', id),
  resetOfflineMode: () => ipcRenderer.invoke('reset-offline-mode'),
});
