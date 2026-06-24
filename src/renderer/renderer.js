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
$('done-btn').addEventListener('click', async () => {
  if (!filePath) return;
  const choice = await window.api.saveChoice();
  if (choice === 'cancel') return;

  overlayMsg.textContent = preciseCheck.checked ? '正在精确导出（重新编码）…' : '正在无损导出…';
  progressBar.style.width = '0%';
  progressPct.textContent = '0%';
  overlay.classList.remove('hidden');

  const off = window.api.onProgress((pct) => {
    progressBar.style.width = pct.toFixed(0) + '%';
    progressPct.textContent = pct.toFixed(0) + '%';
  });

  try {
    const res = await window.api.exportClip({
      filePath,
      start: startT,
      end: endT,
      mode: preciseCheck.checked ? 'precise' : 'lossless',
      target: choice
    });
    off();
    overlay.classList.add('hidden');
    if (res && res.canceled) return;
    progressBar.style.width = '100%';
    toast('已保存：' + (res.outPath || ''));
  } catch (err) {
    off();
    overlay.classList.add('hidden');
    toast('导出失败：' + err.message, true);
  }
});
