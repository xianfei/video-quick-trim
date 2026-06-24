// Tag the body with the OS so CSS can pad the top bar clear of the native
// window controls (macOS traffic lights on the left, Windows controls on right).
document.body.classList.add('platform-' + (window.api.platform || 'other'));

// ---------- element refs ----------
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const editor = $('editor');
const video = $('video');
const filenameEl = $('filename');
const track = $('track');
const filmstrip = $('filmstrip');
const sel = $('sel');
const dimLeft = $('dim-left');
const dimRight = $('dim-right');
const playhead = $('playhead');
const handleStart = $('handle-start');
const handleEnd = $('handle-end');
const startInput = $('start-input');
const endInput = $('end-input');
const durLabel = $('dur-label');
const playBtn = $('play-btn');
const preciseCheck = $('precise-check');
const previewFallback = $('preview-fallback');
const overlay = $('overlay');
const overlayMsg = $('overlay-msg');
const progressBar = $('progress-bar');
const progressPct = $('progress-pct');
const toastEl = $('toast');

// ---------- state ----------
let filePath = null;
let duration = 0;
let startT = 0;
let endT = 0;
const MIN_GAP = 0.05;

// ---------- time helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

function formatTime(sec) {
  sec = Math.max(0, sec || 0);
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  let t = Math.floor(totalMs / 1000);
  const s = t % 60; t = Math.floor(t / 60);
  const m = t % 60; const h = Math.floor(t / 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad3(ms)}`;
}

function parseTime(str) {
  const s = String(str).trim();
  let m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);   // HH:MM:SS(.mmm)
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);             // MM:SS(.mmm)
  if (m) return (+m[1]) * 60 + parseFloat(m[2]);
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s); // bare seconds
  return null;                                         // reject anything else
}

function toFileURL(p) {
  const s = p.replace(/\\/g, '/');
  const enc = (x) => encodeURI(x).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (s.startsWith('//')) return 'file:' + enc(s);          // UNC \\server\share -> file://server/share
  return 'file://' + enc(s.startsWith('/') ? s : '/' + s);  // POSIX or Windows drive (C:/...)
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), isError ? 5000 : 2500);
}

// ---------- load a video ----------
async function loadVideo(p) {
  try {
    const info = await window.api.probe(p);
    filePath = p;
    duration = info.durationSec || 0;
    startT = 0;
    endT = duration;

    filenameEl.textContent = info.name;
    video.src = toFileURL(p);
    video.load();

    dropzone.classList.add('hidden');
    editor.classList.remove('hidden');
    hidePreviewFallback();

    renderSelection();
    updateInputs();
    buildFilmstrip(p);
  } catch (err) {
    toast('无法读取该视频：' + err.message, true);
  }
}

async function buildFilmstrip(p) {
  filmstrip.innerHTML = '';
  const COUNT = 12;
  // placeholders first
  for (let i = 0; i < COUNT; i++) {
    const f = document.createElement('div');
    f.className = 'frame';
    filmstrip.appendChild(f);
  }
  try {
    const thumbs = await window.api.thumbnails({ filePath: p, count: COUNT, durationSec: duration });
    if (p !== filePath) return; // user switched videos meanwhile
    const frames = filmstrip.children;
    thumbs.forEach((url, i) => {
      if (url && frames[i]) frames[i].style.backgroundImage = `url("${url}")`;
    });
  } catch (_) { /* filmstrip is best-effort */ }
}

// ---------- selection rendering ----------
function renderSelection() {
  const W = track.clientWidth;
  if (duration <= 0) return;
  const sx = (startT / duration) * W;
  const ex = (endT / duration) * W;
  sel.style.left = sx + 'px';
  sel.style.width = Math.max(0, ex - sx) + 'px';
  dimLeft.style.width = sx + 'px';
  dimRight.style.left = ex + 'px';
  dimRight.style.width = Math.max(0, W - ex) + 'px';
}

function updatePlayhead() {
  const W = track.clientWidth;
  if (duration <= 0) return;
  playhead.style.left = (video.currentTime / duration) * W + 'px';
}

function updateInputs() {
  if (document.activeElement !== startInput) startInput.value = formatTime(startT);
  if (document.activeElement !== endInput) endInput.value = formatTime(endT);
  durLabel.textContent = formatTime(Math.max(0, endT - startT));
}

// ---------- handle dragging ----------
function beginDrag(which, ev) {
  ev.preventDefault();
  const rect = track.getBoundingClientRect();
  const move = (e) => {
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    let t = (x / rect.width) * duration;
    if (which === 'start') {
      startT = Math.min(t, endT - MIN_GAP);
      startT = Math.max(0, startT);
      video.currentTime = startT;
    } else {
      endT = Math.max(t, startT + MIN_GAP);
      endT = Math.min(duration, endT);
      video.currentTime = endT;
    }
    renderSelection();
    updateInputs();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
handleStart.addEventListener('mousedown', (e) => beginDrag('start', e));
handleEnd.addEventListener('mousedown', (e) => beginDrag('end', e));

// ---------- click track to seek ----------
track.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('handle')) return;
  const rect = track.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
  video.currentTime = (x / rect.width) * duration;
  updatePlayhead();
});

// ---------- time inputs ----------
function commitInput(which) {
  const el = which === 'start' ? startInput : endInput;
  const v = parseTime(el.value);
  if (v === null) { updateInputs(); return; }
  if (which === 'start') {
    startT = Math.max(0, Math.min(v, endT - MIN_GAP));
    video.currentTime = startT;
  } else {
    endT = Math.min(duration, Math.max(v, startT + MIN_GAP));
    video.currentTime = endT;
  }
  renderSelection();
  updateInputs();
}
startInput.addEventListener('change', () => commitInput('start'));
endInput.addEventListener('change', () => commitInput('end'));
startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startInput.blur(); });
endInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') endInput.blur(); });

// ---------- playback ----------
function togglePlay() {
  if (video.paused) {
    if (video.currentTime < startT || video.currentTime >= endT - 0.02) {
      video.currentTime = startT;
    }
    video.play();
  } else {
    video.pause();
  }
}
playBtn.addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
video.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

video.addEventListener('timeupdate', () => {
  if (!video.paused && video.currentTime >= endT) {
    video.currentTime = startT; // loop within selection
  }
  updatePlayhead();
});

// If the selection reaches the true end of the media, 'timeupdate' may not fire
// the loop before playback stops — restart the selection on 'ended'.
video.addEventListener('ended', () => {
  if (endT >= duration - 0.05) { video.currentTime = startT; video.play(); }
});

video.addEventListener('loadedmetadata', () => {
  if (!duration || duration <= 0) {
    duration = video.duration || 0;
    endT = duration;
    renderSelection();
    updateInputs();
  }
  // videoWidth === 0 after metadata means the codec can't be decoded for preview.
  if (!video.videoWidth) showPreviewFallback(); else hidePreviewFallback();
});

// Decode/codec failure (e.g. HEVC/HDR without OS support): trimming still works.
video.addEventListener('error', showPreviewFallback);

function showPreviewFallback() { if (previewFallback) previewFallback.classList.remove('hidden'); }
function hidePreviewFallback() { if (previewFallback) previewFallback.classList.add('hidden'); }

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const typing = document.activeElement === startInput || document.activeElement === endInput;
  if (typing) return;
  if (editor.classList.contains('hidden')) return;
  // When a settings dialog is open, only Escape (to close it) is handled.
  const openModalEl = document.querySelector('.modal:not(.hidden)');
  if (openModalEl) { if (e.key === 'Escape') closeModal(openModalEl); return; }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 1 : 0.1)); updatePlayhead(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(duration, video.currentTime + (e.shiftKey ? 1 : 0.1)); updatePlayhead(); }
});

window.addEventListener('resize', () => { renderSelection(); updatePlayhead(); });

// ---------- open / drop ----------
$('open-btn').addEventListener('click', openFile);
$('close-btn').addEventListener('click', () => {
  video.pause();
  video.removeAttribute('src');
  video.load();
  filePath = null;
  editor.classList.add('hidden');
  dropzone.classList.remove('hidden');
});

async function openFile() {
  const p = await window.api.openDialog();
  if (p) loadVideo(p);
}

// Use an enter/leave depth counter so the highlight doesn't flicker as the
// cursor crosses child elements, and clears reliably on an abandoned drag.
let dragDepth = 0;
document.body.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropzone.classList.add('dragover'); });
document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
document.body.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('dragover');
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const p = window.api.getPathForFile(file);
  if (p) loadVideo(p);
});

// Load a file the app was launched/opened with (double-click, "Open With").
if (window.api.onOpenFile) window.api.onOpenFile((p) => { if (p) loadVideo(p); });

// ---------- export ----------
// Single entry point for every export kind. opts.filePath/start/end are filled
// from current state; needChoice asks replace-vs-saveAs first.
async function performExport(opts, { needChoice = false, msg = '正在导出…' } = {}) {
  if (!filePath) return;
  opts.filePath = filePath;
  if (opts.start == null) opts.start = startT;
  if (opts.end == null) opts.end = endT;

  let target = 'saveAs';
  if (needChoice) {
    const choice = await window.api.saveChoice();
    if (choice === 'cancel') return;
    target = choice;
  }
  opts.target = target;

  overlayMsg.textContent = msg;
  progressBar.style.width = '0%';
  progressPct.textContent = '0%';
  overlay.classList.remove('hidden');
  const off = window.api.onProgress((pct) => {
    progressBar.style.width = pct.toFixed(0) + '%';
    progressPct.textContent = pct.toFixed(0) + '%';
  });

  try {
    const res = await window.api.exportClip(opts);
    off();
    overlay.classList.add('hidden');
    if (res && res.canceled) return;
    toast('已保存：' + (res.outPath || ''));
  } catch (err) {
    off();
    overlay.classList.add('hidden');
    toast('导出失败：' + err.message, true);
  }
}

// Primary 完成 button: lossless, or quick frame-accurate via the 精确模式 checkbox.
$('done-btn').addEventListener('click', () => {
  performExport(
    { kind: preciseCheck.checked ? 'precise' : 'lossless' },
    { needChoice: true, msg: preciseCheck.checked ? '正在精确导出（重新编码）…' : '正在无损导出…' }
  );
});

// ---------- advanced menu ----------
const advBtn = $('adv-btn');
const advMenu = $('adv-menu');
const closeAdvMenu = () => advMenu.classList.add('hidden');

advBtn.addEventListener('click', (e) => { e.stopPropagation(); advMenu.classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  if (!advMenu.classList.contains('hidden') && !advMenu.contains(e.target) && e.target !== advBtn) closeAdvMenu();
});

advMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.adv-item');
  if (!item) return;
  closeAdvMenu();
  switch (item.dataset.act) {
    case 'reencode': openModal('reencode-modal'); break;
    case 'audio': openModal('audio-modal'); break;
    case 'gif': openModal('gif-modal'); break;
    case 'stripAudio': performExport({ kind: 'stripAudio' }, { needChoice: true, msg: '正在移除音频…' }); break;
    case 'frame': performExport({ kind: 'frame', frameTime: video.currentTime, frameFormat: 'png' }, { msg: '正在导出当前帧…' }); break;
  }
});

// ---------- modals ----------
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) closeModal(m);
  });
});

// --- Re-encode modal ---
const reVcodec = $('re-vcodec');
const reCrf = $('re-crf');
const reCrfVal = $('re-crf-val');
const reCrfLabel = $('re-crf-label');
const reCrfWrap = $('re-crf-wrap');
const reBitrateLabel = $('re-bitrate-label');
const reBitrate = $('re-bitrate');
const reRes = $('re-res');
const reFps = $('re-fps');
const reAudio = $('re-audio');
const reContainer = $('re-container');

reCrf.addEventListener('input', () => { reCrfVal.textContent = reCrf.value; });

const HW_SUFFIXES = ['_videotoolbox', '_nvenc', '_qsv', '_amf'];
const isHwCodec = (c) => HW_SUFFIXES.some((s) => c.endsWith(s));
let HW_LIST = [];

function syncReencodeUI() {
  const codec = reVcodec.value;
  const isHw = isHwCodec(codec);
  const isCopy = codec === 'copy';
  // Hardware encoders use a target bitrate; software codecs use CRF; copy uses neither.
  reCrfLabel.classList.toggle('hidden', isHw || isCopy);
  reCrfWrap.classList.toggle('hidden', isHw || isCopy);
  reBitrateLabel.classList.toggle('hidden', !isHw);
  reBitrate.classList.toggle('hidden', !isHw);
  reRes.disabled = isCopy; // stream copy can't scale or change fps
  reFps.disabled = isCopy;
}
reVcodec.addEventListener('change', syncReencodeUI);
syncReencodeUI();

// Inject this machine's working hardware encoders (auto-detected per platform)
// into the codec dropdown. Hide the 硬件加速 preset if none are available.
window.api.hwEncoders().then((list) => {
  HW_LIST = list || [];
  const vtBtn = document.querySelector('.preset[data-preset="vt"]');
  if (!HW_LIST.length) { if (vtBtn) vtBtn.classList.add('hidden'); return; }
  const vp9opt = reVcodec.querySelector('option[value="libvpx-vp9"]');
  for (const enc of HW_LIST) {
    const opt = document.createElement('option');
    opt.value = enc.id;
    opt.textContent = enc.label;
    reVcodec.insertBefore(opt, vp9opt);
  }
});

const PRESETS = {
  h264: { vcodec: 'libx264', crf: 20, res: '', fps: '', audio: 'copy', container: 'mp4' },
  h265: { vcodec: 'libx265', crf: 24, res: '', fps: '', audio: 'copy', container: 'mp4' },
  vt:   { bitrate: '8M', res: '', fps: '', audio: 'copy', container: 'mp4' }, // vcodec chosen from HW_LIST
  web:  { vcodec: 'libvpx-vp9', crf: 31, res: '1080', fps: '', audio: 'aac', container: 'webm' }
};
document.querySelectorAll('.preset').forEach((b) => {
  b.addEventListener('click', () => {
    const p = { ...PRESETS[b.dataset.preset] };
    if (b.dataset.preset === 'vt') {
      // Prefer a hardware H.265 encoder, else any available hardware encoder.
      const hw = HW_LIST.find((c) => c.codec === 'hevc') || HW_LIST[0];
      if (!hw) return;
      p.vcodec = hw.id;
    }
    document.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    if (p.vcodec) reVcodec.value = p.vcodec;
    if (p.crf != null) { reCrf.value = p.crf; reCrfVal.textContent = p.crf; }
    if (p.bitrate) reBitrate.value = p.bitrate;
    reRes.value = p.res; reFps.value = p.fps; reAudio.value = p.audio; reContainer.value = p.container;
    syncReencodeUI();
  });
});

$('re-export').addEventListener('click', () => {
  closeModal($('reencode-modal'));
  performExport({
    kind: 'reencode',
    container: reContainer.value,
    video: {
      codec: reVcodec.value,
      crf: Number(reCrf.value),
      bitrate: reBitrate.value,
      scaleH: reRes.value ? Number(reRes.value) : null,
      fps: reFps.value ? Number(reFps.value) : null
    },
    audio: {
      mode: reAudio.value === 'copy' ? 'copy' : reAudio.value === 'remove' ? 'remove' : 'encode',
      bitrate: '192k'
    }
  }, { needChoice: true, msg: '正在重编码导出…' });
});

// --- Audio modal ---
const auFormat = $('au-format');
const auBitrate = $('au-bitrate');
const auBitrateLabel = $('au-bitrate-label');
function syncAudioUI() {
  const lossless = auFormat.value === 'wav' || auFormat.value === 'flac';
  auBitrate.classList.toggle('hidden', lossless);
  auBitrateLabel.classList.toggle('hidden', lossless);
}
auFormat.addEventListener('change', syncAudioUI);
syncAudioUI();
$('au-export').addEventListener('click', () => {
  closeModal($('audio-modal'));
  performExport({ kind: 'audio', audioFormat: auFormat.value, audioBitrate: auBitrate.value }, { msg: '正在导出音频…' });
});

// --- GIF modal ---
$('gif-export').addEventListener('click', () => {
  closeModal($('gif-modal'));
  performExport({
    kind: 'gif',
    gifFps: Number($('gif-fps').value),
    gifWidth: $('gif-width').value ? Number($('gif-width').value) : null
  }, { msg: '正在生成 GIF…' });
});
