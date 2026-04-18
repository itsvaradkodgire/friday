// Electron main process. Creates the window, loads the renderer, and exposes
// the GEMINI_API_KEY to the renderer via the preload script.

const path = require('path');
const { app, BrowserWindow } = require('electron');

// Bypass Chromium's autoplay policy so the Web Audio API can play immediately
// without requiring a user gesture first. This is a desktop presenter app -
// the greeting and narrations must start speaking the moment the session opens,
// not after the user clicks something. This flag is the Electron-recommended
// way to achieve this: https://www.electronjs.org/docs/latest/api/command-line-switches
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Load .env from the app root if dotenv is available.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  // dotenv not installed - the user can set env vars directly.
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0f1116',
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.resolve(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
