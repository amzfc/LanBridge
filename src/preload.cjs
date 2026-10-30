const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('lan', {
  state: () => invoke('state'),
  onState: callback => { ipcRenderer.on('state', (_event, state) => callback(state)); },
  refreshCode: () => invoke('refresh-code'),
  pair: (address, code) => invoke('pair', address, code),
  confirmPair: id => invoke('confirm-pair', id),
  decidePair: (id, approve) => invoke('decide-pair', id, approve),
  forget: id => invoke('forget', id),
  setPeerAddress: (id, address) => invoke('set-peer-address', id, address),
  chooseFiles: () => invoke('choose-files'),
  chooseFolder: () => invoke('choose-folder'),
  sendFiles: (id, files) => invoke('send-files', id, files),
  decideOffer: (id, approve) => invoke('decide-offer', id, approve),
  cancel: id => invoke('cancel', id),
  pause: id => invoke('pause', id),
  resume: id => invoke('resume', id),
  chooseDownloadDir: () => invoke('choose-download-dir'),
  openDownloadDir: () => invoke('open-download-dir'),
  pathsForFiles: files => Array.from(files).map(file => webUtils.getPathForFile(file)).filter(Boolean)
});
