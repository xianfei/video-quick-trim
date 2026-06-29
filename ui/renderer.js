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
let ffmpegReady = false;       // Tauri: set once ffmpeg is found/installed
let pendingLoadPath = null;    // a file to load after ffmpeg becomes ready

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

// Resolve a filesystem path into a <video>-playable URL. Provided by the
// platform bridge (Electron: file:// ; Tauri: local http media server).
const toMediaSrc = (p) => window.api.toMediaSrc(p);

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
  // ffmpeg must be available before we can probe/preview (Tauri may need setup).
  if (!ffmpegReady) { pendingLoadPath = p; presentFfmpegModal(); return; }
  try {
    const info = await window.api.probe(p);
    filePath = p;
    duration = info.durationSec || 0;
    startT = 0;
    endT = duration;

    filenameEl.textContent = info.name;
    if (window.api.whenReady) await window.api.whenReady(); // media-server base ready (Tauri)
    video.src = toMediaSrc(p);
    video.load();
    setCaptureSource(p); // hidden decoder that feeds the fine-tune loupe's neighbour frames

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

// ---------- handle dragging (QuickLook-style precision fine-tuning) ----------
// "Pull up to fine-tune", like iOS variable-speed scrubbing:
//   • Drag horizontally as usual — the handle tracks the cursor 1:1 (跟手).
//   • Drag the cursor UP off the timeline and the px→time mapping gears down
//     (every HALVE_PX of lift halves the sensitivity), so a long mouse sweep
//     becomes a frame-level nudge. Return to the timeline level → back to 1:1.
// We integrate relative deltas (curT += dx · gain); at gain 1 that's identical
// to direct positioning, so unfine drags drift not at all.
const DRAG = {
  DEAD: 22,        // px of upward slack before gearing engages
  HALVE_PX: 90,    // each HALVE_PX of additional lift halves sensitivity
  GAIN_MIN: 0.05,  // finest mapping (5% of 1:1)
  TILES: 5,        // neighbor frames shown in the loupe (odd → middle is the exact frame)
  STEP_BASE: 1.0,  // seconds between adjacent frames at gain 1; shrinks with the gear
  SETTLE_MS: 70    // debounce before rendering the neighbor frames
};

// Map upward lift (px above the grab point) → sensitivity gain in [GAIN_MIN, 1].
function gainForLift(lift) {
  const over = lift - DRAG.DEAD;
  if (over <= 0) return 1;
  return Math.max(DRAG.GAIN_MIN, Math.pow(0.5, over / DRAG.HALVE_PX));
}

// --- frame loupe: a row of the REAL frames surrounding the cut point, captured
// live by drawing a hidden <video> to canvases (no ffmpeg round-trip; identical
// in both backends). The gap between adjacent frames tracks the gear — the finer
// you fine-tune, the closer together (down to ~1 frame) they sit. ---
const TILE_W = 52;
let loupeEl = null, loupeRow = null, loupeTime = null, loupeHint = null, loupeArrow = null;
let loupeShown = false;
let loupeTiles = [];           // <canvas> per frame; middle index is the exact cut
let framesCapable = false;     // false when the codec can't be decoded for preview

// A second, independently-seekable decoder used only to grab neighbour frames,
// so the main preview's playhead is never disturbed.
let capVideo = null, capGen = 0, settleTimer = null;
function ensureCapVideo() {
  if (capVideo) return;
  capVideo = document.createElement('video');
  capVideo.muted = true; capVideo.playsInline = true; capVideo.preload = 'auto';
  capVideo.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(capVideo);
}
function setCaptureSource(p) {
  ensureCapVideo();
  capVideo.src = toMediaSrc(p);
  capVideo.load();
}

const tileCenter = () => (DRAG.TILES - 1) / 2;
function ensureLoupe() {
  if (loupeEl) return;
  loupeEl = document.createElement('div');
  loupeEl.className = 'loupe';
  loupeEl.innerHTML =
    '<div class="loupe-view"><div class="loupe-row"></div></div>' +
    '<div class="loupe-time">00:00:00.000</div>' +
    '<div class="loupe-hint">↑ 向上拖动可微调</div>' +
    '<div class="loupe-arrow"></div>';
  document.body.appendChild(loupeEl);
  loupeRow = loupeEl.querySelector('.loupe-row');
  loupeTime = loupeEl.querySelector('.loupe-time');
  loupeHint = loupeEl.querySelector('.loupe-hint');
  loupeArrow = loupeEl.querySelector('.loupe-arrow');
}
function buildLoupeTiles() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const tileH = vw && vh ? Math.max(24, Math.min(64, Math.round((TILE_W * vh) / vw))) : 30;
  loupeRow.innerHTML = '';
  loupeTiles = [];
  for (let i = 0; i < DRAG.TILES; i++) {
    const c = document.createElement('canvas');
    c.width = TILE_W; c.height = tileH;
    c.className = 'loupe-tile' + (i === tileCenter() ? ' center' : '');
    loupeRow.appendChild(c);
    loupeTiles.push(c);
  }
}
// Times of the frames to show: centred on t, spaced by a gear-scaled step.
function tileTimes(t, gain) {
  const step = Math.max(1 / 60, DRAG.STEP_BASE * gain);
  const arr = [];
  for (let i = 0; i < DRAG.TILES; i++) arr.push(Math.max(0, Math.min(duration || 0, t + (i - tileCenter()) * step)));
  return arr;
}
function drawTile(idx, srcVideo) {
  const c = loupeTiles[idx];
  const vw = srcVideo.videoWidth, vh = srcVideo.videoHeight;
  if (!c || !vw || !vh) return;
  const scale = Math.max(c.width / vw, c.height / vh); // cover
  const dw = vw * scale, dh = vh * scale;
  c.getContext('2d').drawImage(srcVideo, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
}
function seekCapture(t) {
  return new Promise((resolve) => {
    if (!capVideo || capVideo.readyState < 1) return resolve(false);
    if (Math.abs(capVideo.currentTime - t) < 1e-3 && capVideo.readyState >= 2) return resolve(true);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; capVideo.removeEventListener('seeked', onSeeked); clearTimeout(to); resolve(ok); };
    const onSeeked = () => finish(true);
    const to = setTimeout(() => finish(false), 500);
    capVideo.addEventListener('seeked', onSeeked);
    try { capVideo.currentTime = t; } catch (_) { finish(false); }
  });
}
// Seek the hidden decoder to each neighbour time in turn and paint its tile.
// `gen` guards against a newer drag position superseding this pass mid-flight.
async function captureNeighbors(times, gen) {
  for (let i = 0; i < times.length; i++) {
    if (i === tileCenter()) continue;     // centre is painted from the main preview
    if (gen !== capGen) return;
    const ok = await seekCapture(times[i]);
    if (gen !== capGen) return;
    if (ok) drawTile(i, capVideo);
  }
}

function positionLoupe(t) {
  const LW = loupeEl.offsetWidth || 280;
  const rect = track.getBoundingClientRect();
  const hx = rect.left + (duration > 0 ? (t / duration) * rect.width : 0);
  const left = Math.max(6, Math.min(window.innerWidth - LW - 6, hx - LW / 2));
  loupeEl.style.left = left + 'px';
  loupeEl.style.top = (rect.top - (loupeEl.offsetHeight || 96) - 12) + 'px';
  loupeArrow.style.left = Math.max(12, Math.min(LW - 12, hx - left)) + 'px'; // keep pointing at the handle even when clamped
}
function updateLoupe(t, gain) {
  if (!loupeShown) return;
  loupeTime.textContent = formatTime(t);
  const fine = gain < 0.999;
  loupeHint.textContent = fine ? ('精调 ' + Math.round(1 / gain) + '×') : '↑ 向上拖动可微调';
  loupeHint.classList.toggle('fine', fine);

  if (framesCapable) {
    drawTile(tileCenter(), video);        // live centre frame, straight from the main preview
    const times = tileTimes(t, gain);
    const gen = ++capGen;                 // invalidate any in-flight neighbour capture
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { drawTile(tileCenter(), video); captureNeighbors(times, gen); }, DRAG.SETTLE_MS);
  }
  positionLoupe(t);
}
function showLoupe(t, gain) {
  ensureLoupe();
  if (!loupeShown) {
    loupeShown = true;
    loupeEl.classList.toggle('no-frames', !framesCapable);
    if (framesCapable) buildLoupeTiles();
    loupeEl.classList.add('show');
  }
  updateLoupe(t, gain);
}
function hideLoupe() {
  loupeShown = false;
  capGen++;                                // cancel any pending capture
  clearTimeout(settleTimer);
  if (loupeEl) loupeEl.classList.remove('show');
}

function beginDrag(which, ev) {
  ev.preventDefault();
  const rect = track.getBoundingClientRect();
  const handleEl = which === 'start' ? handleStart : handleEnd;
  let lastX = ev.clientX;
  const refY = ev.clientY;        // gearing is measured as upward lift from here
  let curGain = 1;
  const curT = () => (which === 'start' ? startT : endT);

  const apply = (t) => {
    if (which === 'start') {
      startT = Math.max(0, Math.min(t, endT - MIN_GAP));
      video.currentTime = startT;
    } else {
      endT = Math.min(duration, Math.max(t, startT + MIN_GAP));
      video.currentTime = endT;
    }
    renderSelection();
    updateInputs();
    updateLoupe(curT(), curGain);
  };

  const move = (e) => {
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    curGain = gainForLift(refY - e.clientY);
    if (!loupeShown) showLoupe(curT(), curGain); // teaches the up-drag from the first move
    apply(curT() + (dx / rect.width) * duration * curGain);
    handleEl.classList.toggle('focusing', curGain < 0.999);
  };

  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    handleEl.classList.remove('focusing');
    hideLoupe();
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
  framesCapable = !!video.videoWidth;        // gates the loupe's frame thumbnails
  if (!video.videoWidth) showPreviewFallback(); else hidePreviewFallback();
});

// Decode/codec failure (e.g. HEVC/HDR without OS support): trimming still works.
video.addEventListener('error', () => { framesCapable = false; showPreviewFallback(); });

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

// Drag-and-drop is handled by the platform bridge (Electron DOM events / Tauri
// native drag-drop events), surfaced uniformly via window.api.onFileDrop.
if (window.api.onFileDrop) window.api.onFileDrop({
  onEnter: () => dropzone.classList.add('dragover'),
  onLeave: () => dropzone.classList.remove('dragover'),
  onDrop: (p) => { dropzone.classList.remove('dragover'); if (p) loadVideo(p); }
});

// Load a file the app was launched/opened with (double-click, "Open With").
if (window.api.onOpenFile) window.api.onOpenFile((p) => { if (p) loadVideo(p); });

// ---------- ffmpeg setup (Tauri: ffmpeg isn't bundled) ----------
const ffModal = $('ffmpeg-modal');
const ffActions = $('ff-actions');
const ffProgressWrap = $('ff-progress-wrap');
const ffBar = $('ff-bar');
const ffPct = $('ff-pct');
const ffTitle = $('ff-title');
const ffStatus = $('ff-status');
const ffStatusText = $('ff-status-text');
const ffPath = $('ff-path');
const ffNote = $('ff-note');
const ffDesc = $('ff-desc');
const ffDoneBtn = $('ff-done');
const ffDownloadBtn = $('ff-download');
const ffPickBtn = $('ff-pick');

let ffDownloading = false;
function showFfmpegModal() { if (ffModal) ffModal.classList.remove('hidden'); }
function hideFfmpegModal() { if (ffModal) ffModal.classList.add('hidden'); }

const FF_SOURCE_LABEL = {
  bundled: '内置 ffmpeg（随应用打包）',
  downloaded: '已下载的 ffmpeg（应用数据目录）',
  system: '系统 ffmpeg'
};

// Populate the modal from the current ffmpeg state: when it's already available
// show WHERE it comes from (no misleading "download needed" prompt); only when
// it's genuinely missing do we lead with download / manual-pick.
async function renderFfmpegModal() {
  let info = { available: false, source: 'none' };
  try { if (window.api.ffmpegInfo) info = await window.api.ffmpegInfo(); } catch (_) {}

  if (info.available) {
    ffTitle.textContent = 'ffmpeg 设置';
    ffStatus.classList.remove('hidden', 'warn');
    ffStatus.classList.add('ok');
    ffStatusText.textContent = '正在使用：' + (FF_SOURCE_LABEL[info.source] || 'ffmpeg');
    ffPath.textContent = info.ffmpeg || '';
    ffNote.classList.toggle('hidden', !!info.ffprobe);
    ffNote.textContent = info.ffprobe ? '' : '未找到 ffprobe —— 时长/分辨率会回退到解析 ffmpeg 输出。';
    ffDesc.textContent = '已就绪，可直接裁剪导出。如需更换，可重新下载或指定其他 ffmpeg。';
    ffDoneBtn.classList.remove('hidden');
    ffDownloadBtn.textContent = '重新下载（约 40MB）';
    ffDownloadBtn.classList.remove('btn-primary'); ffDownloadBtn.classList.add('btn-secondary');
    ffPickBtn.textContent = '手动选择其他 ffmpeg…';
  } else {
    ffTitle.textContent = '需要 ffmpeg';
    ffStatus.classList.remove('hidden', 'ok');
    ffStatus.classList.add('warn');
    ffStatusText.textContent = '未在系统 PATH 中找到 ffmpeg';
    ffPath.textContent = '';
    ffNote.classList.add('hidden');
    ffDesc.textContent = '精简版不预置 ffmpeg。你可以自动下载，或手动指定一个已有的 ffmpeg 可执行文件。';
    ffDoneBtn.classList.add('hidden');
    ffDownloadBtn.textContent = '自动下载（约 40MB，仅一次）';
    ffDownloadBtn.classList.remove('btn-secondary'); ffDownloadBtn.classList.add('btn-primary');
    ffPickBtn.textContent = '手动选择 ffmpeg…';
  }
}

// Reset to the actions view, refresh the status, then show. Used by both the
// auto prompt (ffmpeg missing) and the ⋯ → 设置 ffmpeg… menu item.
async function presentFfmpegModal() {
  ffActions.classList.remove('hidden');
  ffProgressWrap.classList.add('hidden');
  await renderFfmpegModal();
  showFfmpegModal();
}

// The ffmpeg modal closes on backdrop click or 完成, but never mid-download.
if (ffModal) ffModal.addEventListener('click', (e) => {
  if (e.target === ffModal && !ffDownloading) hideFfmpegModal();
});
if (ffDoneBtn) ffDoneBtn.addEventListener('click', hideFfmpegModal);

function onFfmpegReady() {
  ffmpegReady = true;
  hideFfmpegModal();
  loadHwEncoders();
  // "设置 ffmpeg…" is only meaningful where ffmpeg isn't bundled (Tauri).
  if (window.api.downloadFfmpeg) { const m = document.getElementById('adv-ffmpeg'); if (m) m.classList.remove('hidden'); }
  if (pendingLoadPath) { const p = pendingLoadPath; pendingLoadPath = null; loadVideo(p); }
}

// Decide on startup whether ffmpeg is available. Electron always returns true;
// Tauri returns false when ffmpeg isn't found → we show the setup modal.
(function initFfmpeg() {
  if (!window.api.ffmpegStatus) { onFfmpegReady(); return; } // no gate → ready
  window.api.ffmpegStatus().then((ok) => {
    if (ok) onFfmpegReady();
    else presentFfmpegModal();
  }).catch(() => presentFfmpegModal());
})();

if (ffDownloadBtn) ffDownloadBtn.addEventListener('click', async () => {
  ffActions.classList.add('hidden');
  ffProgressWrap.classList.remove('hidden');
  ffBar.style.width = '0%';
  ffPct.textContent = '0%';
  ffDownloading = true;
  const off = window.api.onFfmpegProgress ? window.api.onFfmpegProgress((pct) => {
    if (pct < 0) { ffBar.classList.add('indeterminate'); ffBar.style.width = '100%'; ffPct.textContent = '下载中…'; }
    else { ffBar.classList.remove('indeterminate'); ffBar.style.width = pct.toFixed(0) + '%'; ffPct.textContent = pct.toFixed(0) + '%'; }
  }) : null;
  try {
    await window.api.downloadFfmpeg();
    if (off) off();
    ffDownloading = false;
    onFfmpegReady();
  } catch (err) {
    if (off) off();
    ffDownloading = false;
    ffProgressWrap.classList.add('hidden');
    ffActions.classList.remove('hidden');
    toast('下载失败：' + (err && err.message ? err.message : err), true);
  }
});

if (ffPickBtn) ffPickBtn.addEventListener('click', async () => {
  try {
    const ok = await window.api.pickAndSetFfmpeg();
    if (ok) onFfmpegReady();
  } catch (err) {
    toast(err && err.message ? err.message : String(err), true);
  }
});

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
    case 'ffmpeg': presentFfmpegModal(); break;
  }
});

// ---------- modals ----------
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }
document.querySelectorAll('.modal').forEach((m) => {
  if (m.id === 'ffmpeg-modal') return; // handled separately (no dismiss mid-download)
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
// Called once ffmpeg is ready (detection needs to run ffmpeg).
let hwLoaded = false;
function loadHwEncoders() {
  if (hwLoaded) return;
  hwLoaded = true;
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
}

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
