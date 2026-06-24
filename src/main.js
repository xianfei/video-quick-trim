const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'ts', 'flv', 'wmv'];

// Resolve bundled ffmpeg / ffprobe binaries. In a packaged app the binaries
// live inside app.asar.unpacked (configured via build.asarUnpack).
function unpacked(p) {
  return p ? p.replace('app.asar', 'app.asar.unpacked') : p;
}
const ffmpegPath = unpacked(require('ffmpeg-static'));
const ffprobePath = unpacked(require('ffprobe-static').path);

let mainWindow = null;
let pendingOpenPath = null; // a file to load once the window is ready

// ---- single instance + "open with" handling --------------------------------

// Pick the first existing video-file argument out of an argv array.
function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const f = args.find((a) =>
    !a.startsWith('-') && VIDEO_EXTS.includes(path.extname(a).slice(1).toLowerCase()));
  return f && fs.existsSync(f) ? f : null;
}

function sendOpen(filePath) {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('open-file', filePath);
}

// macOS delivers "Open With" / dock-drop via the open-file event.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) { sendOpen(filePath); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  else pendingOpenPath = filePath;
});

// Windows/Linux pass the path as argv; keep a single instance so double-opening
// a file routes to the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (f) sendOpen(f);
    }
  });
  pendingOpenPath = pendingOpenPath || fileFromArgv(process.argv);
}

// Surface a clear error if the bundled binaries are missing (packaging mistake)
// instead of failing later with an opaque ENOENT.
function checkBinaries() {
  for (const [name, p] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) {
    if (!p || !fs.existsSync(p)) {
      dialog.showErrorBox(
        'Quick Trim 启动错误',
        `找不到 ${name} 可执行文件：\n${p}\n\n这通常是打包问题（asarUnpack 未匹配）。请重新安装应用。`
      );
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Once the UI is ready, load any file the app was launched/opened with.
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) { sendOpen(pendingOpenPath); pendingOpenPath = null; }
  });
}

app.whenReady().then(() => {
  checkBinaries();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

// Parse "HH:MM:SS.xx" or seconds string into seconds (number).
function hmsToSeconds(t) {
  if (typeof t === 'number') return t;
  if (!t) return 0;
  const parts = String(t).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
}

// ---- IPC: probe -------------------------------------------------------------

ipcMain.handle('probe', async (_evt, filePath) => {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    filePath
  ];
  const { stdout } = await run(ffprobePath, args);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || {};
  return {
    durationSec: parseFloat(info.format && info.format.duration) || 0,
    width: v.width || 0,
    height: v.height || 0,
    vcodec: v.codec_name || '',
    acodec: a.codec_name || '',
    ext: path.extname(filePath).replace('.', '').toLowerCase(),
    name: path.basename(filePath)
  };
});

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

// ---- IPC: export ------------------------------------------------------------

// H.264 + AAC fit these containers; anything else gets remuxed to .mp4 in
// precise mode (see exportClip).
const MP4_LIKE = /\.(mp4|mov|m4v|mkv|ts)$/i;

function buildExportArgs({ filePath, start, end, mode, outPath }) {
  const ss = hmsToSeconds(start);
  const dur = Math.max(0.001, hmsToSeconds(end) - ss);
  if (mode === 'precise') {
    // Frame-accurate: re-encode the selection to H.264/AAC.
    const args = [
      '-ss', String(ss),
      '-i', filePath,
      '-t', String(dur),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k'
    ];
    // +faststart is only meaningful for mp4/mov/m4v.
    if (/\.(mp4|mov|m4v)$/i.test(outPath)) args.push('-movflags', '+faststart');
    args.push('-y', outPath);
    return args;
  }
  // Lossless stream copy (keyframe-aligned start). Map only video/audio/subtitle
  // streams with '?' so optional ones are skipped and problematic data /
  // timecode / attachment streams don't abort the remux.
  return [
    '-ss', String(ss),
    '-i', filePath,
    '-t', String(dur),
    '-map', '0:v?', '-map', '0:a?', '-map', '0:s?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-y', outPath
  ];
}

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

// Move tmpPath onto finalPath, as close to atomic as the destination allows,
// cleaning up partial files on any failure.
function moveInto(tmpPath, finalPath) {
  try {
    fs.renameSync(tmpPath, finalPath); // atomic on the same volume
    return;
  } catch (_) {
    // Cross-volume: copy to a temp ON the destination volume, then atomic rename.
    const destTmp = path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}_qt_copy_${process.pid}_${crypto.randomBytes(6).toString('hex')}`
    );
    try {
      fs.copyFileSync(tmpPath, destTmp);
      fs.renameSync(destTmp, finalPath);
    } catch (err) {
      safeUnlink(destTmp);
      throw err;
    } finally {
      safeUnlink(tmpPath);
    }
  }
}

ipcMain.handle('exportClip', async (evt, opts) => {
  const { filePath, start, end, mode, target } = opts;
  const totalDur = hmsToSeconds(end) - hmsToSeconds(start);
  if (!(totalDur > 0)) throw new Error('选区无效：终点必须晚于起点。');

  const srcExt = path.extname(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, srcExt);
  // Precise mode re-encodes to H.264/AAC, which only fits mp4-like containers.
  // For other containers we remux the output to .mp4 so it stays valid.
  const outExt = (mode === 'precise' && !MP4_LIKE.test(srcExt)) ? '.mp4' : srcExt;

  let finalPath;
  if (target === 'saveAs') {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '另存为',
      defaultPath: path.join(dir, `${base}_trimmed${outExt}`),
      filters: [{ name: 'Video', extensions: [outExt.replace('.', '') || 'mp4'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    finalPath = res.filePath;
  } else if (target === 'replace') {
    // If precise mode changed the container, the result must carry the new
    // extension; the original (different extension) is removed after success.
    finalPath = path.join(dir, base + outExt);
  } else {
    return { canceled: true };
  }

  // Write to a temp file first (keeps the original safe if ffmpeg fails, and is
  // required for in-place replace since ffmpeg can't read+overwrite one file).
  const rnd = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${base}_qt_tmp_${process.pid}_${rnd}${outExt}`);
  const args = buildExportArgs({ filePath, start, end, mode, outPath: tmpPath });

  try {
    await runFfmpegWithProgress(args, totalDur, evt);
    moveInto(tmpPath, finalPath);
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

ipcMain.handle('openDialog', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle('saveChoice', async () => {
  const res = await dialog.showMessageBox(mainWindow, {
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
