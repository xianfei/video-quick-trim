// Shared ffmpeg argument builder — the single source of truth for how every
// export kind maps to ffmpeg CLI args. Used by BOTH backends:
//   - Electron main process (Node, via require)
//   - Tauri bridge (browser, via <script> global window.QTExportArgs)
// Keep this file pure: no Node APIs, no DOM, no framework imports.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node
  else root.QTExportArgs = api;                                           // browser
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MP4_LIKE = /\.(mp4|mov|m4v|mkv|ts)$/i;
  const MP4_OR_MOV = /\.(mp4|mov|m4v)$/i;
  const HW_SUFFIXES = ['_videotoolbox', '_nvenc', '_qsv', '_amf'];
  const isHwEncoder = (c) => HW_SUFFIXES.some((s) => c.endsWith(s));
  const isHevcEncoder = (c) => c === 'libx265' || /^hevc_/.test(c);

  function extname(p) {
    const m = String(p).match(/(\.[^.\/\\]+)$/);
    return m ? m[1] : '';
  }

  // Parse "HH:MM:SS.xx" / "MM:SS" / seconds into a number of seconds.
  function hmsToSeconds(t) {
    if (typeof t === 'number') return t;
    if (!t) return 0;
    const parts = String(t).split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(t) || 0;
  }

  // Output file extension for a given export descriptor.
  function outputExtFor(opts) {
    const srcExt = extname(opts.filePath);
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
    const map = { frame: '_frame', audio: '_audio', gif: '', stripAudio: '_noaudio' };
    return kind in map ? map[kind] : '_trimmed';
  }

  // Build the ffmpeg argument list for a given export descriptor + output path.
  function buildArgs(opts, outPath) {
    const ss = hmsToSeconds(opts.start);
    const dur = Math.max(0.001, hmsToSeconds(opts.end) - ss);
    const inSeek = ['-ss', String(ss), '-i', opts.filePath, '-t', String(dur)];
    const faststart = () => (MP4_OR_MOV.test(outPath) ? ['-movflags', '+faststart'] : []);

    switch (opts.kind) {
      case 'frame': {
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
        const fc = `[0:v]fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
        return [...inSeek, '-filter_complex', fc, '-y', outPath];
      }

      case 'stripAudio':
        return [...inSeek, '-map', '0:v?', '-map', '0:s?', '-c', 'copy', '-an',
          '-avoid_negative_ts', 'make_zero', '-y', outPath];

      case 'precise':
        return [...inSeek, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
          '-c:a', 'aac', '-b:a', '192k', ...faststart(), '-y', outPath];

      case 'reencode': {
        const v = opts.video || {};
        const a = opts.audio || {};
        const container = opts.container || 'mp4';
        const args = [...inSeek];

        const vf = [];
        if (v.fps) vf.push(`fps=${v.fps}`);
        if (v.scaleH) vf.push(`scale=-2:${v.scaleH}`);

        if (v.codec === 'copy') {
          args.push('-c:v', 'copy');
        } else {
          if (vf.length) args.push('-vf', vf.join(','));
          const codec = v.codec || 'libx264';
          args.push('-c:v', codec);
          if (isHwEncoder(codec)) {
            args.push('-b:v', v.bitrate || '8M');
          } else if (codec === 'libvpx-vp9') {
            args.push('-b:v', '0', '-crf', String(v.crf != null ? v.crf : 31));
          } else {
            args.push('-crf', String(v.crf != null ? v.crf : 23), '-preset', v.preset || 'medium');
          }
          if (isHevcEncoder(codec) && MP4_OR_MOV.test(outPath)) args.push('-tag:v', 'hvc1');
        }

        if (a.mode === 'remove') args.push('-an');
        else if (a.mode === 'copy') args.push('-c:a', 'copy');
        else args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-b:a', a.bitrate || '192k');

        return [...args, ...faststart(), '-y', outPath];
      }

      case 'lossless':
      default:
        return [...inSeek, '-map', '0:v?', '-map', '0:a?', '-map', '0:s?',
          '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', outPath];
    }
  }

  return { buildArgs, outputExtFor, suffixFor, hmsToSeconds, extname, isHwEncoder, isHevcEncoder };
});
