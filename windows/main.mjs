import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = join(ROOT, 'windows', 'preload.cjs');
const INDEX = join(ROOT, 'windows', 'index.html');
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const MAX_ASM_BYTES = 2 * 1024 * 1024;
const MAX_PRESET_BYTES = 16 * 1024;
const windows = new Set();

app.setName('Siren');
app.setAppUserModelId('io.github.mauvesea.Siren');

if (process.argv.includes('--version')) {
  console.log('Siren 1.0.0');
  app.exit(0);
}

function isSupportedPath(filePath) {
  return typeof filePath === 'string' && /\.(wav|asm)$/i.test(filePath);
}

function commandLineFile(argv) {
  return argv.find(argument => isSupportedPath(argument) && existsSync(argument)) ?? null;
}

function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: '#00000000',
    symbolColor: dark ? '#ffffff' : '#1a1a1a',
    height: 48,
  };
}

function createWindow(initialFile = null) {
  const window = new BrowserWindow({
    title: 'Siren',
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windows.add(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => windows.delete(window));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(INDEX).then(() => {
    if (initialFile) window.webContents.send('app:open-path', resolve(initialFile));
  });
  return window;
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? [...windows][0] ?? null;
}

function fileDescription(kind) {
  return kind === 'asm'
    ? { title: 'Open cry ASM', filters: [{ name: 'Cry ASM', extensions: ['asm'] }] }
    : { title: 'Open WAV', filters: [{ name: 'WAV audio', extensions: ['wav'] }] };
}

function readCheckedFile(filePath, kind) {
  const expected = kind === 'asm' ? '.asm' : '.wav';
  const limit = kind === 'asm' ? MAX_ASM_BYTES : MAX_WAV_BYTES;
  if (typeof filePath !== 'string' || extname(filePath).toLowerCase() !== expected)
    throw new Error(`Choose a ${expected} file.`);
  const size = statSync(filePath).size;
  if (size > limit)
    throw new Error(kind === 'asm' ? 'Choose an ASM file smaller than 2 MB.' : 'Choose a WAV smaller than 20 MB.');
  const contents = readFileSync(filePath);
  return {
    path: resolve(filePath),
    name: basename(filePath),
    bytes: contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength),
  };
}

function readPresetDirectory(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => {
      const filePath = join(directory, entry.name);
      if (statSync(filePath).size > MAX_PRESET_BYTES)
        throw new Error(`${entry.name}: preset files must be at most ${MAX_PRESET_BYTES} bytes.`);
      return { filename: entry.name, json: readFileSync(filePath, 'utf8') };
    });
}

ipcMain.handle('dialog:open', async (_event, kind) => {
  const result = await dialog.showOpenDialog(focusedWindow(), {
    ...fileDescription(kind), properties: ['openFile'],
  });
  return result.canceled ? null : readCheckedFile(result.filePaths[0], kind);
});

ipcMain.handle('file:read', (_event, filePath, kind) => readCheckedFile(filePath, kind));

ipcMain.handle('presets:load', () => ({
  bundled: readPresetDirectory(join(ROOT, 'Presets')),
  custom: readPresetDirectory(join(app.getPath('appData'), 'siren', 'Presets')),
}));

ipcMain.handle('file:export-asm', async (_event, sourcePath, contents) => {
  if (typeof sourcePath !== 'string' || extname(sourcePath).toLowerCase() !== '.wav')
    throw new Error('The source WAV path is invalid.');
  const outputPath = join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.asm`);
  if (existsSync(outputPath)) {
    const answer = await dialog.showMessageBox(focusedWindow(), {
      type: 'warning',
      title: 'Replace file?',
      message: `Replace ${basename(outputPath)}?`,
      detail: 'An ASM file with this name already exists in the source folder.',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return null;
  }
  writeFileSync(outputPath, contents, 'utf8');
  return outputPath;
});

ipcMain.handle('app:new-window', () => { createWindow(); });
ipcMain.handle('app:open-external', (_event, url) => {
  if (!/^https:\/\/(github\.com|learn\.microsoft\.com)\//.test(url))
    throw new Error('External URL is not allowed.');
  return shell.openExternal(url);
});

nativeTheme.on('updated', () => {
  for (const window of windows) window.setTitleBarOverlay(titleBarColors());
});

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const window = focusedWindow() ?? createWindow();
    const filePath = commandLineFile(argv);
    if (filePath) window.webContents.send('app:open-path', resolve(filePath));
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(() => {
    createWindow(commandLineFile(process.argv.slice(1)));
    app.on('activate', () => { if (!windows.size) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
