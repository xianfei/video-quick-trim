// Platform bridge — provides a uniform window.api the renderer talks to.
//
//   - Under Electron, preload.js already created window.api (contextBridge)
//     before this script runs, so we detect that and do nothing.
//   - Under Tauri, there is no preload; we build the same window.api surface
//     here from Tauri's JS APIs (invoke / events / dialog plugin / webview).
//
// The renderer is identical for both; only this file differs in behaviour.
(function () {
  'use strict';
  const isTauri =
    typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
    typeof window.__TAURI__ !== 'undefined';
  if (!isTauri) return; // Electron path — window.api already provided by preload.

  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const Q = window.QTExportArgs;

  // Local range-capable media server base (so large videos stream in WKWebView).
  let MEDIA_BASE = '';
  const mediaReady = invoke('media_base').then((b) => { MEDIA_BASE = b || ''; }).catch(() => {});

  const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'ts', 'flv', 'wmv'];
  const dirname = (p) => { const m = p.replace(/[\\/][^\\/]*$/, ''); return m || p; };
  const basename = (p) => p.replace(/^.*[\\/]/, '');
  const stripExt = (name) => name.replace(/\.[^.]+$/, '');
  const sep = (p) => (p.indexOf('\\') >= 0 && p.indexOf('/') < 0 ? '\\' : '/');
  const rnd = () => {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function detectPlatform() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/win/i.test(p)) return 'win32';
    if (/mac/i.test(p)) return 'darwin';
    return 'linux';
  }

  window.api = {
    platform: detectPlatform(),

    // Resolves once the media-server base URL is known (awaited before playback).
    whenReady: () => mediaReady,
    toMediaSrc: (p) => MEDIA_BASE + encodeURIComponent(p),

    probe: (filePath) => invoke('probe', { path: filePath }),

    hwEncoders: () => invoke('hw_encoders'),

    thumbnails: (opts) =>
      invoke('thumbnails', {
        path: opts.filePath,
        count: opts.count || 12,
        durationSec: opts.durationSec || 0
      }),

    // Native dialogs run in Rust (rust-side plugin-dialog) — invoked here.
    openDialog: () => invoke('open_dialog'),

    // Two-button: Yes→replace, No→save-as (cancelling the save dialog still aborts).
    saveChoice: () => invoke('save_choice'),

    exportClip: async (opts) => {
      const kind = opts.kind || 'lossless';
      const ext = Q.outputExtFor(opts);
      let target = opts.target;
      if (kind === 'frame' || kind === 'audio' || kind === 'gif') target = 'saveAs';

      const dir = dirname(opts.filePath);
      const base = stripExt(basename(opts.filePath));
      const s = sep(opts.filePath);

      let finalPath;
      if (target === 'saveAs') {
        finalPath = await invoke('save_dialog', {
          defaultPath: `${dir}${s}${base}${Q.suffixFor(kind)}${ext}`,
          ext: ext.replace('.', '')
        });
        if (!finalPath) return { canceled: true };
      } else if (target === 'replace') {
        finalPath = `${dir}${s}${base}${ext}`;
      } else {
        return { canceled: true };
      }

      // Build args here (shared logic) writing to a temp on the destination
      // volume; Rust runs ffmpeg, reports progress, and moves it into place.
      const fdir = dirname(finalPath);
      const fbase = stripExt(basename(finalPath));
      const tmpPath = `${fdir}${sep(finalPath)}.${fbase}_qt_tmp_${rnd()}${ext}`;
      const args = Q.buildArgs(opts, tmpPath);
      const totalDur = kind === 'frame' ? 0 : (Q.hmsToSeconds(opts.end) - Q.hmsToSeconds(opts.start));

      const outPath = await invoke('run_export', {
        args,
        tmpPath,
        finalPath,
        originalPath: opts.filePath,
        isReplace: target === 'replace',
        totalDur
      });
      return { canceled: false, outPath };
    },

    onProgress: (cb) => {
      let un = null;
      listen('export-progress', (e) => cb(e.payload)).then((f) => { un = f; });
      return () => { if (un) un(); };
    },

    onOpenFile: (cb) => {
      listen('open-file', (e) => cb(e.payload));
      // Also pick up a file the app was launched with (CLI arg / "Open With").
      invoke('take_pending_open').then((p) => { if (p) cb(p); }).catch(() => {});
    },

    // ffmpeg availability (Tauri doesn't bundle it). The UI asks the user to
    // download or pick one manually when it's missing.
    ffmpegStatus: () => invoke('ffmpeg_status'),
    ffmpegInfo: () => invoke('ffmpeg_info'),
    downloadFfmpeg: () => invoke('download_ffmpeg'),
    pickAndSetFfmpeg: () => invoke('pick_and_set_ffmpeg'),
    onFfmpegProgress: (cb) => {
      let un = null;
      listen('ffmpeg-download-progress', (e) => cb(e.payload)).then((f) => { un = f; });
      return () => { if (un) un(); };
    },

    onFileDrop: (handlers) => {
      const onEnter = handlers.onEnter || (() => {});
      const onLeave = handlers.onLeave || (() => {});
      const onDrop = handlers.onDrop || (() => {});
      // Tauri delivers native file drops as window events.
      listen('tauri://drag-enter', () => onEnter());
      listen('tauri://drag-leave', () => onLeave());
      listen('tauri://drag-drop', (e) => {
        onLeave();
        const p = e.payload && e.payload.paths && e.payload.paths[0];
        if (p) onDrop(p);
      });
    }
  };
})();
