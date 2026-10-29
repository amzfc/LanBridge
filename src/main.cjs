'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { LanBridge } = require('./core.cjs');

let win;
let bridge;
const relay = () => { if (win && !win.isDestroyed()) win.webContents.send('state', bridge.snapshot()); };
function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 740, minWidth: 790, minHeight: 620,
    title: '邻传', backgroundColor: '#f5f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', relay);
}
function handle(name, callback) { ipcMain.handle(name, async (_event, ...args) => callback(...args)); }
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  bridge = new LanBridge({ dataDir: app.getPath('userData'), downloadDir: path.join(app.getPath('downloads'), '邻传接收'), onChange: relay });
  try { await bridge.init(); }
  catch (error) { dialog.showErrorBox('邻传启动失败', `${error.message}\n\n请确认端口 53319 没有被占用。`); app.quit(); return; }
  handle('state', () => bridge.snapshot());
  handle('refresh-code', () => bridge.regenerateCode());
  handle('pair', (address, code) => bridge.pair(address, code));
  handle('confirm-pair', id => bridge.confirmPair(id));
  handle('decide-pair', (id, approve) => bridge.decidePair(id, approve));
  handle('forget', id => bridge.forget(id));
  handle('set-peer-address', (id, address) => bridge.setPeerAddress(id, address));
  handle('choose-files', async () => (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths);
  handle('choose-folder', async () => (await dialog.showOpenDialog(win, { properties: ['openDirectory'] })).filePaths);
  handle('send-files', (id, files) => bridge.sendFiles(id, files));
  handle('decide-offer', (id, approve) => bridge.decideOffer(id, approve));
  handle('cancel', id => bridge.cancel(id));
  handle('choose-download-dir', async () => {
    const selection = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled) return bridge.downloadDir;
    await fs.mkdir(selection.filePaths[0], { recursive: true });
    bridge.downloadDir = selection.filePaths[0]; bridge.emit();
    return bridge.downloadDir;
  });
  handle('open-download-dir', () => shell.openPath(bridge.downloadDir));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
