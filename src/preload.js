const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wisprtell', {
  // capture window
  onCaptureStart: cb => ipcRenderer.on('capture-start', cb),
  onCaptureStop: cb => ipcRenderer.on('capture-stop', cb),
  sendCaptureData: buf => ipcRenderer.send('capture-data', buf),
  sendCaptureError: msg => ipcRenderer.send('capture-error', msg),
  sendMicLevel: l => ipcRenderer.send('mic-level', l),
  handleListMics: fn => ipcRenderer.handle('list-mics', fn),
  // pill
  onPillState: cb => ipcRenderer.on('pill-state', (_e, s) => cb(s)),
  onMicLevel: cb => ipcRenderer.on('mic-level', (_e, l) => cb(l)),
  // settings / welcome
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: patch => ipcRenderer.invoke('set-config', patch),
  listMics: () => ipcRenderer.invoke('list-mics'),
  welcomeDone: () => ipcRenderer.send('welcome-done'),
  openExternal: url => ipcRenderer.send('open-external', url),
  validateKey: key => ipcRenderer.invoke('validate-key', key),
});
