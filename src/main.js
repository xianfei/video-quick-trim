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
  detectHwEncoders(); // warm the cache so the re-encode modal is instant
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
// precise mode.
const MP4_LIKE = /\.(mp4|mov|m4v|mkv|ts)$/i;
const MP4_OR_MOV = /\.(mp4|mov|m4v)$/i;
const HW_SUFFIXES = ['_videotoolbox', '_nvenc', '_qsv', '_amf'];
const isHwEncoder = (c) => HW_SUFFIXES.some((s) => c.endsWith(s));
const isHevcEncoder = (c) => c === 'libx265' || /^hevc_/.test(c);

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

// Output file extension for a given export descriptor.
function outputExtFor(opts) {
  const srcExt = path.extname(opts.filePath);
  switch (opts.kind) {
    case 'frame': return '.' + (opts.frameFormat || 'png');
    case 'audio': return { mp3: '.mp3', m4a: '.m4a', aac: '.m4a', wav: '.wav', flac: '.flac' }[opts.audioFormat || 'mp3'];
    case 'gif': return '.gif';
    case 'reencode': return '.' + (opts.container || 'mp4');
    case 'precise': return MP4_LIKE.test(srcExt) ? srcExt : '.mp4';
    case 'stripAudio':
    case 'lossless':
    default: return srcExt;
  }
}

// Default filename suffix for "save as".
function suffixFor(kind) {
  return { frame: '_frame', audio: '_audio', gif: '', stripAudio: '_noaudio' }[kind] ?? '_trimmed';
}

// Build the ffmpeg argument list for a given export descriptor + output path.
function buildArgs(opts, outPath) {
  const ss = hmsToSeconds(opts.start);
  const dur = Math.max(0.001, hmsToSeconds(opts.end) - ss);
  const inSeek = ['-ss', String(ss), '-i', opts.filePath, '-t', String(dur)];
  const faststart = () => (MP4_OR_MOV.test(outPath) ? ['-movflags', '+faststart'] : []);

  switch (opts.kind) {
    case 'frame': {
      // A single still from the current playhead position.
      const t = hmsToSeconds(opts.frameTime != null ? opts.frameTime : ss);
      const q = /\.png$/i.test(outPath) ? [] : ['-q:v', '2'];
      return ['-ss', String(t), '-i', opts.filePath, '-frames:v', '1', ...q, '-y', outPath];
    }

    case 'audio': {
      const abr = opts.audioBitrate || '192k';
      const enc = {
        mp3: ['-c:a', 'libmp3lame', '-b:a', abr],
        m4a: ['-c:a', 'aac', '-b:a', abr],
        aac: ['-c:a', 'aac', '-b:a', abr],
        wav: ['-c:a', 'pcm_s16le'],
        flac: ['-c:a', 'flac']
      }[opts.audioFormat || 'mp3'] || ['-c:a', 'libmp3lame', '-b:a', abr];
      return [...inSeek, '-vn', ...enc, '-y', outPath];
    }

    case 'gif': {
      const fps = opts.gifFps || 15;
      const scale = opts.gifWidth ? `,scale=${opts.gifWidth}:-1:flags=lanczos` : '';
      // One-pass high-quality GIF: build an optimal palette, then apply it.
      const fc = `[0:v]fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
      return [...inSeek, '-filter_complex', fc, '-y', outPath];
    }

    case 'stripAudio':
      return [...inSeek, '-map', '0:v?', '-map', '0:s?', '-c', 'copy', '-an',
        '-avoid_negative_ts', 'make_zero', '-y', outPath];

    case 'precise': {
      // Frame-accurate: re-encode the selection to H.264/AAC.
      return [...inSeek, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '192k', ...faststart(), '-y', outPath];
    }

    case 'reencode': {
      const v = opts.video || {};
      const a = opts.audio || {};
      const container = opts.container || 'mp4';
      const args = [...inSeek];

      // Video filters (scale / fps) only apply when actually re-encoding.
      const vf = [];
      if (v.fps) vf.push(`fps=${v.fps}`);
      if (v.scaleH) vf.push(`scale=-2:${v.scaleH}`);

      if (v.codec === 'copy') {
        args.push('-c:v', 'copy'); // filters not possible with stream copy
      } else {
        if (vf.length) args.push('-vf', vf.join(','));
        const codec = v.codec || 'libx264';
        args.push('-c:v', codec);
        if (isHwEncoder(codec)) {
          args.push('-b:v', v.bitrate || '8M'); // hardware encoders are bitrate-driven
        } else if (codec === 'libvpx-vp9') {
          args.push('-b:v', '0', '-crf', String(v.crf != null ? v.crf : 31));
        } else { // libx264 / libx265
          args.push('-crf', String(v.crf != null ? v.crf : 23), '-preset', v.preset || 'medium');
        }
        // QuickTime needs the hvc1 tag to recognise HEVC in mp4/mov.
        if (isHevcEncoder(codec) && MP4_OR_MOV.test(outPath)) args.push('-tag:v', 'hvc1');
      }

      // Audio
      if (a.mode === 'remove') {
        args.push('-an');
      } else if (a.mode === 'copy') {
        args.push('-c:a', 'copy');
      } else {
        // WebM only takes Opus/Vorbis; everything else gets AAC.
        args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-b:a', a.bitrate || '192k');
      }

      return [...args, ...faststart(), '-y', outPath];
    }

    case 'lossless':
    default:
      // Lossless stream copy (keyframe-aligned start). Map only v/a/s with '?'
      // so problematic data/timecode/attachment streams don't abort the remux.
      return [...inSeek, '-map', '0:v?', '-map', '0:a?', '-map', '0:s?',
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', outPath];
  }
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
    const res = await dialog.showSaveDialog(mainWindow, {
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
