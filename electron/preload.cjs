/**
 * Preload (CommonJS — the package is "type": "module", so this needs the .cjs
 * extension to be loaded as CJS).
 *
 * The renderer talks to the local Express API over plain fetch, so there is
 * nothing privileged to expose. This only advertises that the page is running
 * inside the desktop shell, which the UI uses to adjust its chrome.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
});
