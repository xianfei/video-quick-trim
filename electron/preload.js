const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Convert a dropped File object into an absolute filesystem path.
  // (Electron removed File.path; webUtils.getPathForFile is the replacement.)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Resolve a path into a <video>-playable URL (Chromium plays file:// directly).
  toMediaSrc: (p) => {
    const s = String(p).replace(/\\/g, '/');
    const enc = (x) => encodeURI(x).replace(/#/g, '%23').replace(/\?/g, '%3F');
    if (s.startsWith('//')) return 'file:' + enc(s);          // UNC \\server\share
    return 'file://' + enc(s.startsWith('/') ? s : '/' + s);  // POSIX or Windows drive
  },

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
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),

  // Electron bundles ffmpeg, so it's always ready — no download/pick flow.
  ffmpegStatus: () => Promise.resolve(true),

  // Uniform drag-and-drop: wire DOM events and resolve the dropped file's path
  // via webUtils. (The Tauri bridge implements the same surface using native
  // drag-drop events.)
  onFileDrop: (handlers) => {
    const onEnter = handlers.onEnter || (() => {});
    const onLeave = handlers.onLeave || (() => {});
    const onDrop = handlers.onDrop || (() => {});
    let depth = 0;
    document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; onEnter(); });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) onLeave();
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      onLeave();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onDrop(webUtils.getPathForFile(f));
    });
  }
});
