const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Shared ffmpeg-arg logic (also used by the Tauri bridge) — single source of truth.
const { buildArgs, outputExtFor, suffixFor, hmsToSeconds } = require('../ui/export-args.js');

const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'ts', 'flv', 'wmv'];

// Resolve the bundled ffmpeg binary. In a packaged app it lives inside
// app.asar.unpacked (configured via build.asarUnpack).
function unpacked(p) {
  return p ? p.replace('app.asar', 'app.asar.unpacked') : p;
}
const ffmpegPath = unpacked(require('ffmpeg-static'));
// Metadata (duration/resolution/codecs) is read from `ffmpeg -i` output, so we
// ship only ffmpeg — no separate ffprobe binary to bundle.

// Files waiting for a window (queued before the app is ready at launch). Each
// opens in its OWN window — a second "Open With" never clobbers the first video.
let pendingOpenPaths = [];

// ---- single instance + "open with" handling --------------------------------

// Pick the first existing video-file argument out of an argv array.
function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const f = args.find((a) =>
    !a.startsWith('-') && VIDEO_EXTS.includes(path.extname(a).slice(1).toLowerCase()));
  return f && fs.existsSync(f) ? f : null;
}

// macOS delivers "Open With" / dock-drop / double-click via open-file — open
// each file in its own window (queued until the app is ready at launch).
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) createWindow(filePath);
  else pendingOpenPaths.push(filePath);
});

// Windows/Linux pass the path as argv; a single instance keeps one process, and
// a second launch opens its file in a NEW window rather than a second process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (f) { createWindow(f); return; }
    // Relaunched without a file → just surface an existing window.
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) { const w = wins[wins.length - 1]; if (w.isMinimized()) w.restore(); w.focus(); }
    else createWindow(null);
  });
  const initial = fileFromArgv(process.argv);
  if (initial) pendingOpenPaths.push(initial);
}

// Surface a clear error if the bundled binary is missing (packaging mistake)
// instead of failing later with an opaque ENOENT.
function checkBinaries() {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    dialog.showErrorBox(
      'Quick Trim 启动错误',
      `找不到 ffmpeg 可执行文件：\n${ffmpegPath}\n\n这通常是打包问题（asarUnpack 未匹配）。请重新安装应用。`
    );
  }
}

// Create a window; if `filePath` is given, load it once the UI is ready. New
// windows cascade off the current one so stacked windows stay distinguishable.
function createWindow(filePath) {
  const opts = {
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#1c1c1e',
    // macOS: inset traffic lights over the custom top bar (left side).
    // Windows: native control overlay over the custom top bar (right side).
    titleBarStyle: process.platform === 'win32' ? 'hidden'
      : process.platform === 'darwin' ? 'hiddenInset'
      : 'default',
    titleBarOverlay: process.platform === 'win32'
      ? { color: '#28282a', symbolColor: '#f2f2f7', height: 52 }
      : false,
    // macOS: drop the inset traffic lights onto the 52px top bar's mid-line so
    // they share a centerline with the title text and buttons. Ignored elsewhere.
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
  const ref = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().slice(-1)[0];
  if (ref && !ref.isDestroyed()) { const [x, y] = ref.getPosition(); opts.x = x + 30; opts.y = y + 30; }

  const win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (filePath) win.webContents.send('open-file', filePath);
  });
  return win;
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'; // force dark native UI (menus, scrollbars, <select>/range controls)
  checkBinaries();
  detectHwEncoders(); // warm the cache so the re-encode modal is instant
  if (pendingOpenPaths.length) { pendingOpenPaths.forEach((p) => createWindow(p)); pendingOpenPaths = []; }
  else createWindow(null);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- helpers ----------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${stderr}`));
    });
  });
}

// ---- IPC: probe -------------------------------------------------------------

// Parse metadata out of `ffmpeg -i` stderr — the same approach the Tauri backend
// uses when ffprobe is absent, so no separate ffprobe binary is needed.
function parseHms(s) {
  const parts = String(s).trim().split(':');
  if (parts.length === 3) return (+parts[0] || 0) * 3600 + (+parts[1] || 0) * 60 + (parseFloat(parts[2]) || 0);
  return parseFloat(s) || 0;
}
function parseFfmpegInfo(stderr, filePath) {
  let durationSec = 0;
  const dm = stderr.match(/Duration:\s*([0-9:.]+)/);
  if (dm) durationSec = parseHms(dm[1]);
  let width = 0, height = 0, vcodec = '', acodec = '';
  const vLine = stderr.split('\n').find((l) => l.includes('Video:'));
  if (vLine) {
    const vm = vLine.match(/Video:\s*([^\s,(]+)/); if (vm) vcodec = vm[1];
    const rm = vLine.match(/(\d{2,5})x(\d{2,5})/); if (rm) { width = +rm[1]; height = +rm[2]; }
  }
  const aLine = stderr.split('\n').find((l) => l.includes('Audio:'));
  if (aLine) { const am = aLine.match(/Audio:\s*([^\s,(]+)/); if (am) acodec = am[1]; }
  return {
    durationSec, width, height, vcodec, acodec,
    ext: path.extname(filePath).replace('.', '').toLowerCase(),
    name: path.basename(filePath)
  };
}
// `ffmpeg -i` with no output file exits non-zero but prints stream info to
// stderr — that's expected; capture stderr regardless of exit code.
function ffmpegProbe(filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => resolve(stderr));
    child.on('close', () => resolve(stderr));
  });
}

ipcMain.handle('probe', async (_evt, filePath) => parseFfmpegInfo(await ffmpegProbe(filePath), filePath));

// ---- IPC: thumbnails --------------------------------------------------------

ipcMain.handle('thumbnails', async (_evt, { filePath, count = 10, durationSec = 0 }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-thumbs-'));
  const n = Math.max(1, Math.min(count, 20));
  const out = [];
  // Sample frames at evenly spaced timestamps. Use input-seek per frame
  // (fast, accurate enough for a filmstrip) with scaled-down output.
  for (let i = 0; i < n; i++) {
    const t = durationSec > 0 ? (durationSec * (i + 0.5)) / n : 0;
    const file = path.join(dir, `thumb-${i}.jpg`);
    const args = [
      '-ss', String(t),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-q:v', '5',
      '-y', file
    ];
    try {
      await run(ffmpegPath, args);
      if (fs.existsSync(file)) out.push('file://' + file);
      else out.push(null);
    } catch (e) {
      out.push(null);
    }
  }
  return out;
});

// ---- hardware encoder detection --------------------------------------------

// Candidate hardware encoders per platform. macOS → VideoToolbox; Windows →
// NVIDIA/Intel/AMD; Linux → NVIDIA/Intel. We only advertise the ones that
// actually work on this machine (probed below).
function hwCandidates() {
  switch (process.platform) {
    case 'darwin':
      return [
        { id: 'h264_videotoolbox', codec: 'h264', label: 'H.264 硬件加速 (VideoToolbox)' },
        { id: 'hevc_videotoolbox', codec: 'hevc', label: 'H.265 硬件加速 (VideoToolbox)' }
      ];
    case 'win32':
      return [
        { id: 'hevc_nvenc', codec: 'hevc', label: 'H.265 硬件加速 (NVIDIA NVENC)' },
        { id: 'h264_nvenc', codec: 'h264', label: 'H.264 硬件加速 (NVIDIA NVENC)' },
        { id: 'hevc_qsv', codec: 'hevc', label: 'H.265 硬件加速 (Intel QSV)' },
        { id: 'h264_qsv', codec: 'h264', label: 'H.264 硬件加速 (Intel QSV)' },
        { id: 'hevc_amf', codec: 'hevc', label: 'H.265 硬件加速 (AMD AMF)' },
        { id: 'h264_amf', codec: 'h264', label: 'H.264 硬件加速 (AMD AMF)' }
      ];
    case 'linux':
      return [
        { id: 'hevc_nvenc', codec: 'hevc', label: 'H.265 硬件加速 (NVIDIA NVENC)' },
        { id: 'h264_nvenc', codec: 'h264', label: 'H.264 硬件加速 (NVIDIA NVENC)' },
        { id: 'hevc_qsv', codec: 'hevc', label: 'H.265 硬件加速 (Intel QSV)' },
        { id: 'h264_qsv', codec: 'h264', label: 'H.264 硬件加速 (Intel QSV)' }
      ];
    default:
      return [];
  }
}

// An encoder "works" if it can encode a few synthetic frames without error —
// this proves both the build support and the presence of the GPU/driver.
function encoderWorks(encoder) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let child;
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=5:d=0.2',
        '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-'
      ]);
    } catch (_) { return finish(false); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(false); }, 12000);
    child.on('error', () => { clearTimeout(t); finish(false); });
    child.on('close', (code) => { clearTimeout(t); finish(code === 0); });
  });
}

let _hwPromise = null;
function detectHwEncoders() {
  if (!_hwPromise) {
    _hwPromise = Promise.all(hwCandidates().map((c) => encoderWorks(c.id).then((ok) => (ok ? c : null))))
      .then((list) => {
        const ok = list.filter(Boolean);
        if (!app.isPackaged) console.log('[hw] available encoders:', ok.map((c) => c.id).join(', ') || '(none)');
        return ok;
      })
      .catch(() => []);
  }
  return _hwPromise;
}

ipcMain.handle('hwEncoders', () => detectHwEncoders());

// Electron ships ffmpeg inside the app (metadata via `ffmpeg -i`, no ffprobe).
ipcMain.handle('ffmpegInfo', () => ({
  available: true,
  ffmpeg: ffmpegPath,
  ffprobe: null,
  source: 'bundled'
}));

function runFfmpegWithProgress(args, totalDur, evt) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && totalDur > 0) {
        const cur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        const pct = Math.max(0, Math.min(100, (cur / totalDur) * 100));
        evt.sender.send('export-progress', pct);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });
  });
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rename with a few retries: on Windows the destination can be transiently locked
// (media-handle teardown, antivirus, Search indexer) → EPERM/EBUSY. Back off and
// retry rather than fail the whole export.
async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < attempts) { await sleep(150); continue; }
      throw err;
    }
  }
}

// Move tmpPath onto finalPath, as close to atomic as the destination allows,
// cleaning up partial files on any failure.
async function moveInto(tmpPath, finalPath) {
  try {
    await renameWithRetry(tmpPath, finalPath); // atomic on the same volume
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err; // only a genuine cross-volume move needs a copy
    // Cross-volume: copy to a temp ON the destination volume, then atomic rename.
    const destTmp = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}_qt_copy_${process.pid}_${crypto.randomBytes(6).toString('hex')}`
    );
    try {
      fs.copyFileSync(tmpPath, destTmp);
      await renameWithRetry(destTmp, finalPath);
    } catch (e) {
      safeUnlink(destTmp);
      throw e;
    } finally {
      safeUnlink(tmpPath);
    }
  }
}

ipcMain.handle('exportClip', async (evt, opts) => {
  const { filePath, kind = 'lossless' } = opts;
  const totalDur = hmsToSeconds(opts.end) - hmsToSeconds(opts.start);
  // Frame grab ignores the selection length; everything else needs a real range.
  if (kind !== 'frame' && !(totalDur > 0)) throw new Error('选区无效：终点必须晚于起点。');

  const srcExt = path.extname(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, srcExt);
  const outExt = outputExtFor(opts);

  // Frame / audio / GIF produce inherently new files — replacing the source
  // makes no sense, so force "save as" for those.
  let target = opts.target;
  if (kind === 'frame' || kind === 'audio' || kind === 'gif') target = 'saveAs';

  let finalPath;
  if (target === 'saveAs') {
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(evt.sender), {
      title: '导出',
      defaultPath: path.join(dir, `${base}${suffixFor(kind)}${outExt}`),
      filters: [{ name: '文件', extensions: [outExt.replace('.', '') || 'mp4'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    finalPath = res.filePath;
  } else if (target === 'replace') {
    // If the operation changed the container, the result carries the new
    // extension; the original (different extension) is removed after success.
    finalPath = path.join(dir, base + outExt);
  } else {
    return { canceled: true };
  }

  // Write to a temp file first (keeps the original safe if ffmpeg fails, and is
  // required for in-place replace since ffmpeg can't read+overwrite one file).
  // Put the temp on the destination volume so the final move is an atomic rename.
  const rnd = crypto.randomBytes(6).toString('hex');
  const tmpDir = target === 'saveAs' ? path.dirname(finalPath) : dir;
  const tmpName = path.basename(finalPath, outExt);
  const tmpPath = path.join(tmpDir, `.${tmpName}_qt_tmp_${process.pid}_${rnd}${outExt}`);
  const args = buildArgs(opts, tmpPath);

  try {
    await runFfmpegWithProgress(args, kind === 'frame' ? 0 : totalDur, evt);
    await moveInto(tmpPath, finalPath);
    // Replacing with a changed container: drop the now-stale original.
    if (target === 'replace' && path.resolve(finalPath) !== path.resolve(filePath)) {
      safeUnlink(filePath);
    }
    return { canceled: false, outPath: finalPath };
  } catch (err) {
    safeUnlink(tmpPath);
    throw err;
  }
});

// ---- IPC: open dialog -------------------------------------------------------

ipcMain.handle('openDialog', async (evt) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(evt.sender), {
    title: '打开视频',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'ts', 'flv', 'wmv'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---- IPC: confirm dialog (save choice) -------------------------------------

ipcMain.handle('saveChoice', async (evt) => {
  const res = await dialog.showMessageBox(BrowserWindow.fromWebContents(evt.sender), {
    type: 'question',
    buttons: ['替换原文件', '另存为', '取消'],
    defaultId: 1,
    cancelId: 2,
    title: '保存',
    message: '如何保存裁剪后的视频？',
    detail: '「替换原文件」会覆盖原视频；「另存为」会保存为新文件。'
  });
  return ['replace', 'saveAs', 'cancel'][res.response];
});
