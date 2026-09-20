const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('siren', {
  openFile: kind => ipcRenderer.invoke('dialog:open', kind),
  readFile: (filePath, kind) => ipcRenderer.invoke('file:read', filePath, kind),
  pathForFile: file => webUtils.getPathForFile(file),
  loadPresets: () => ipcRenderer.invoke('presets:load'),
  exportAsm: (sourcePath, contents) => ipcRenderer.invoke('file:export-asm', sourcePath, contents),
  newWindow: () => ipcRenderer.invoke('app:new-window'),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  onOpenPath: callback => ipcRenderer.on('app:open-path', (_event, filePath) => callback(filePath)),
});
