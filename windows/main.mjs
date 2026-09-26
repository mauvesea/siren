import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCryDefinitionLabels, parseCryPointers } from '../src/cry-list.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = join(ROOT, 'windows', 'preload.cjs');
const INDEX = join(ROOT, 'windows', 'index.html');
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const MAX_STUDIO_WAV_BYTES = 64 * 1024 * 1024;
const MAX_ASM_BYTES = 2 * 1024 * 1024;
const MAX_PRESET_BYTES = 16 * 1024;
const windows = new Set();

app.setName('Siren');
app.setAppUserModelId('io.github.mauvesea.Siren');

if (process.argv.includes('--version')) {
  console.log('Siren 2.0.0');
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
  const revealWindow = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  };
  window.once('ready-to-show', revealWindow);
  window.on('closed', () => windows.delete(window));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(INDEX).then(() => {
    // ready-to-show can fail to fire on Windows even after the renderer loads.
    // Always reveal the loaded window so the process cannot remain invisible.
    revealWindow();
    if (initialFile) window.webContents.send('app:open-path', resolve(initialFile));
  });
  return window;
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() ?? [...windows][0] ?? null;
}

function fileDescription(kind) {
  return kind === 'cry-list'
    ? { title: 'Open data/pokemon/cries.asm', filters: [{ name: 'pokecrystal cry list', extensions: ['asm'] }] }
    : kind === 'asm'
    ? { title: 'Open cry ASM', filters: [{ name: 'Cry ASM', extensions: ['asm'] }] }
    : { title: 'Open WAV', filters: [{ name: 'WAV audio', extensions: ['wav'] }] };
}

function readCheckedFile(filePath, kind) {
  const expected = kind === 'asm' || kind === 'cry-list' ? '.asm' : '.wav';
  const limit = expected === '.asm' ? MAX_ASM_BYTES : MAX_WAV_BYTES;
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

function readStudioAsm(filePath) {
  const file = readCheckedFile(filePath, 'asm');
  const backup = join(dirname(file.path), `${basename(file.path, extname(file.path))}-backup.asm`);
  if (!existsSync(backup)) copyFileSync(file.path, backup);
  return { ...file, backup };
}

function readCryListProject(filePath) {
  const file = readCheckedFile(filePath, 'cry-list');
  const resolved = resolve(file.path);
  const pokemonDirectory = dirname(resolved);
  const dataDirectory = dirname(pokemonDirectory);
  if (basename(resolved).toLowerCase() !== 'cries.asm' || basename(pokemonDirectory).toLowerCase() !== 'pokemon' ||
      basename(dataDirectory).toLowerCase() !== 'data')
    throw new Error('Choose the project file data/pokemon/cries.asm.');
  const backup = `${resolved}.backup`;
  copyFileSync(resolved, backup);
  const projectRoot = dirname(dataDirectory);
  const constantsPath = join(projectRoot, 'constants', 'cry_constants.asm');
  const pointersPath = join(projectRoot, 'audio', 'cry_pointers.asm');
  if (!existsSync(constantsPath)) throw new Error('Could not find constants/cry_constants.asm in this project.');
  if (!existsSync(pointersPath)) throw new Error('Could not find audio/cry_pointers.asm in this project.');
  const constants = readCheckedFile(constantsPath, 'asm');
  const pointers = readCheckedFile(pointersPath, 'asm');
  const pointerText = readFileSync(pointersPath, 'utf8');
  const wanted = new Set(parseCryPointers(pointerText)
    .map(label => `CRY_${label.replace(/^Cry_/i, '').toUpperCase()}`));
  const definitionFiles = [];
  let fileCount = 0;
  const skippedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'build', 'dist']);
  const visit = (directory, depth) => {
    if (depth > 12 || !wanted.size) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !entry.name.startsWith('.')) visit(child, depth + 1);
      } else if (/\.asm$/i.test(entry.name) && !/(?:^|[-_.])backup(?:[-_.]|$)/i.test(entry.name)) {
        if (++fileCount > 25000) throw new Error('The project contains too many ASM files to search safely.');
        if (statSync(child).size > MAX_ASM_BYTES) continue;
        const source = readFileSync(child, 'utf8');
        let labels;
        try { labels = parseCryDefinitionLabels(source); }
        catch (_) { continue; }
        const found = [...labels.keys()].filter(label => wanted.has(label));
        if (found.length) {
          definitionFiles.push(readCheckedFile(child, 'asm').bytes);
          for (const label of found) wanted.delete(label);
        }
      }
    }
  };
  visit(projectRoot, 0);
  return { ...file, constantsBytes: constants.bytes, pointersBytes: pointers.bytes, definitionFiles, backup };
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
  if (result.canceled) return null;
  return kind === 'cry-list' ? readCryListProject(result.filePaths[0]) :
    kind === 'asm' ? readStudioAsm(result.filePaths[0]) : readCheckedFile(result.filePaths[0], kind);
});

ipcMain.handle('file:read', (_event, filePath, kind) =>
  kind === 'cry-list' ? readCryListProject(filePath) : kind === 'asm' ? readStudioAsm(filePath) : readCheckedFile(filePath, kind));

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

ipcMain.handle('file:export-wav', async (_event, sourcePath, contents) => {
  if (typeof sourcePath !== 'string' || extname(sourcePath).toLowerCase() !== '.wav')
    throw new Error('The source WAV path is invalid.');
  if (!(contents instanceof Uint8Array) || contents.byteLength < 44 || contents.byteLength > MAX_WAV_BYTES)
    throw new Error('The converted WAV data is invalid.');
  const outputPath = join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}-converted.wav`);
  if (existsSync(outputPath)) {
    const answer = await dialog.showMessageBox(focusedWindow(), {
      type: 'warning', title: 'Replace file?', message: `Replace ${basename(outputPath)}?`,
      detail: 'A converted WAV with this name already exists in the source folder.',
      buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (answer.response !== 0) return null;
  }
  writeFileSync(outputPath, contents);
  return outputPath;
});

ipcMain.handle('file:save-asm', (_event, sourcePath, contents) => {
  if (typeof sourcePath !== 'string' || extname(sourcePath).toLowerCase() !== '.asm' ||
      typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_ASM_BYTES)
    throw new Error('The ASM document is invalid.');
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) throw new Error('The input ASM file no longer exists.');
  const backup = join(dirname(resolved), `${basename(resolved, extname(resolved))}-backup.asm`);
  if (!existsSync(backup)) copyFileSync(resolved, backup);
  writeFileSync(resolved, contents, 'utf8');
  return { path: resolved, backup };
});

ipcMain.handle('file:save-studio', (_event, sourcePath, contents, wavContents) => {
  if (typeof sourcePath !== 'string' || extname(sourcePath).toLowerCase() !== '.asm' ||
      typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_ASM_BYTES ||
      !(wavContents instanceof Uint8Array) || wavContents.byteLength < 44 || wavContents.byteLength > MAX_STUDIO_WAV_BYTES)
    throw new Error('The Studio project is invalid.');
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) throw new Error('The input ASM file no longer exists.');
  const backup = join(dirname(resolved), `${basename(resolved, extname(resolved))}-backup.asm`);
  if (!existsSync(backup)) copyFileSync(resolved, backup);
  const wavPath = join(dirname(resolved), `${basename(resolved, extname(resolved))}.wav`);
  writeFileSync(resolved, contents, 'utf8');
  writeFileSync(wavPath, wavContents);
  return { asm: resolved, wav: wavPath, backup };
});

ipcMain.handle('file:save-cry-list', (_event, sourcePath, contents) => {
  if (typeof sourcePath !== 'string' || typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_ASM_BYTES)
    throw new Error('The cry-list document is invalid.');
  const resolved = resolve(sourcePath);
  const pokemonDirectory = dirname(resolved);
  const dataDirectory = dirname(pokemonDirectory);
  if (basename(resolved).toLowerCase() !== 'cries.asm' || basename(pokemonDirectory).toLowerCase() !== 'pokemon' ||
      basename(dataDirectory).toLowerCase() !== 'data' || !existsSync(resolved))
    throw new Error('The input data/pokemon/cries.asm file is invalid.');
  writeFileSync(resolved, contents, 'utf8');
  return resolved;
});

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
