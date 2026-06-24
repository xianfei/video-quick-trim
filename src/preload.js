const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Convert a dropped File object into an absolute filesystem path.
  // (Electron removed File.path; webUtils.getPathForFile is the replacement.)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  probe: (filePath) => ipcRenderer.invoke('probe', filePath),
  hwEncoders: () => ipcRenderer.invoke('hwEncoders'),
  thumbnails: (opts) => ipcRenderer.invoke('thumbnails', opts),
  exportClip: (opts) => ipcRenderer.invoke('exportClip', opts),
  openDialog: () => ipcRenderer.invoke('openDialog'),
  saveChoice: () => ipcRenderer.invoke('saveChoice'),

  onProgress: (cb) => {
    const listener = (_e, pct) => cb(pct);
    ipcRenderer.on('export-progress', listener);
    return () => ipcRenderer.removeListener('export-progress', listener);
  },

  // Fired when the app is launched/opened with a video file (double-click,
  // "Open With", drag onto dock icon).
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p))
});
