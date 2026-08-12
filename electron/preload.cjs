/**
 * Preload (CommonJS — the package is "type": "module", so this needs the .cjs
 * extension to be loaded as CJS).
 *
 * The renderer talks to the local Express API over plain fetch, so almost
 * nothing needs exposing. The exception is the updater: it lives in the main
 * process (only that side can launch an installer and quit the app), so the
 * Durum tab has no other way to read its state.
 *
 * Read-only, and no arguments — the renderer can ask what the updater is doing
 * but cannot start, stop or redirect it.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
  updateStatus: () => ipcRenderer.invoke('update-status'),
});
