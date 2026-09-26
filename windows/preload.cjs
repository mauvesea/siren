const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('siren', {
  openFile: kind => ipcRenderer.invoke('dialog:open', kind),
  readFile: (filePath, kind) => ipcRenderer.invoke('file:read', filePath, kind),
  pathForFile: file => webUtils.getPathForFile(file),
  loadPresets: () => ipcRenderer.invoke('presets:load'),
  exportAsm: (sourcePath, contents) => ipcRenderer.invoke('file:export-asm', sourcePath, contents),
  exportWav: (sourcePath, contents) => ipcRenderer.invoke('file:export-wav', sourcePath, new Uint8Array(contents)),
  saveAsm: (sourcePath, contents) => ipcRenderer.invoke('file:save-asm', sourcePath, contents),
  saveStudio: (sourcePath, contents, wavContents) =>
    ipcRenderer.invoke('file:save-studio', sourcePath, contents, new Uint8Array(wavContents)),
  saveCryList: (sourcePath, contents) => ipcRenderer.invoke('file:save-cry-list', sourcePath, contents),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  onOpenPath: callback => ipcRenderer.on('app:open-path', (_event, filePath) => callback(filePath)),
});
