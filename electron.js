const { app, BrowserWindow, ipcMain, Menu, shell, systemPreferences } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

let mainWindow;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'logo.ico'),
    titleBarStyle: 'default',
    show: false
  });

  const startUrl = isDev 
    ? 'http://localhost:3000' 
    : `file://${path.join(__dirname, '../build/index.html')}`;

  // KEYBOARD: with the menu bar removed (Menu.setApplicationMenu(null)) Windows also loses every menu shortcut, so
  // F11 and friends stopped working. Handle them here instead; this works whether or not a menu exists.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const wc = mainWindow.webContents;
    const key = input.key || '';
    const ctrl = input.control || input.meta;
    if (key === 'F11') { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (key === 'F12' || (ctrl && input.shift && key.toLowerCase() === 'i')) { wc.toggleDevTools(); event.preventDefault(); }
    else if (ctrl && input.shift && key.toLowerCase() === 'r') { wc.reloadIgnoringCache(); event.preventDefault(); }
    else if (key === 'F5' || (ctrl && key.toLowerCase() === 'r')) { wc.reload(); event.preventDefault(); }
    else if (ctrl && (key === '=' || key === '+')) { wc.setZoomLevel(wc.getZoomLevel() + 0.5); event.preventDefault(); }
    else if (ctrl && (key === '-' || key === '_')) { wc.setZoomLevel(wc.getZoomLevel() - 0.5); event.preventDefault(); }
    else if (ctrl && key === '0') { wc.setZoomLevel(0); event.preventDefault(); }
  });

  // SECURITY: this window runs with nodeIntegration, so it must never display web content. Links that try to
  // open a new window go to the user's real browser instead, and the window can't navigate away from the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const internal = isDev ? url.startsWith('http://localhost:3000') : url.startsWith('file://');
    if (!internal) event.preventDefault();
  });

  mainWindow.loadURL(startUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Microphone: Windows shows no permission pop-up to desktop apps, the switch is in Settings > Privacy & security >
// Microphone. The app asks for the status and can open that page (see toggleVoiceInput in App.js).
ipcMain.handle('mic-status', () => {
  try { return systemPreferences.getMediaAccessStatus('microphone'); } catch (e) { return 'unknown'; }
});
ipcMain.on('open-mic-settings', () => { shell.openExternal('ms-settings:privacy-microphone').catch(() => {}); });

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

// ── In-app updates (electron-updater) ───────────────────────────────────────
// Flow: the renderer's update banner sends 'update:start' -> we check the feed and
// download the installer in the BACKGROUND (the app stays usable, nothing restarts).
// autoInstallOnAppQuit then installs it silently the next time the user closes the
// app, so the new version is there on the following launch. Status is streamed to
// the renderer on the 'update:status' channel as { state, percent?, version?, message? }.
// Needs: the NSIS installer build (portable can't self-update), a real `publish`
// target in package.json, and a PACKAGED app (electron-dev has no app-update.yml).
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (e) {
  console.log('electron-updater not available');
}

const sendUpdate = (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', payload);
};

if (autoUpdater) {
  autoUpdater.on('update-available', (info) => {
    sendUpdate({ state: 'downloading', percent: 0, version: info.version });
    autoUpdater.downloadUpdate().catch((err) => sendUpdate({ state: 'error', message: err.message }));
  });
  autoUpdater.on('update-not-available', () =>
    sendUpdate({ state: 'error', message: 'No newer installer was found on the update server yet.' }));
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) =>
    sendUpdate({ state: 'error', message: err && err.message ? err.message : String(err) }));

  ipcMain.on('update:start', () => {
    if (!app.isPackaged) {
      return sendUpdate({ state: 'error', message: 'Updates only work in the installed app, not in dev mode.' });
    }
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      return sendUpdate({ state: 'error', message: "The portable version can't update itself. Please download the installer from the website." });
    }
    autoUpdater.checkForUpdates().catch((err) => sendUpdate({ state: 'error', message: err.message }));
  });

  // Optional: user chooses to apply the downloaded update immediately
  ipcMain.on('update:restart-now', () => autoUpdater.quitAndInstall());
}