/**
 * Electron main process.
 *
 * Boots the Express app in-process on a free port and opens a window pointing
 * at it. Closing the window shuts the server down and exits.
 */

import { app, BrowserWindow, shell, dialog } from 'electron';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverHandle = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#141414',
    title: 'CineSeat',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Without this the variable keeps a handle to a destroyed window, and any
  // later method call on it throws "Object has been destroyed".
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Anything that isn't our own page — the real booking site — opens in the
  // user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${serverHandle?.port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  try {
    // Settings, favourites and follows live beside the app's other user data,
    // not next to the source — this survives reinstalls.
    process.env.CINESEAT_DATA_DIR = app.getPath('userData');

    // Port 0 → the OS picks a free one, so a stray `npm start` on 3000 doesn't
    // collide with the packaged app.
    const { startServer } = await import('../src/index.js');
    serverHandle = await startServer({ port: 0 });
    await mainWindow.loadURL(`http://localhost:${serverHandle.port}`);
  } catch (err) {
    dialog.showErrorBox('Başlatılamadı', err.stack ?? String(err));
    app.quit();
  }
}

/**
 * Shut the server down without ever blocking the quit.
 *
 * This used to be `await serverHandle.close()` ahead of `app.quit()`, which
 * could hang forever: closing an http.Server waits for every open socket, and
 * an open /api/scan SSE stream never ends on its own. The process then stayed
 * alive with a destroyed window, still holding the single-instance lock — so
 * the *next* launch was denied the lock and the zombie threw
 * "Object has been destroyed" at the user.
 */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  serverHandle?.close();
  serverHandle = null;
}

// A second launch should focus the existing window rather than start a second
// server. Everything else is registered only by the instance holding the lock,
// so a denied instance can't race to build a window before it quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    shutdown();
    app.quit();
  });

  // Electron does not await async handlers here, so this must be synchronous.
  app.on('before-quit', shutdown);
}
