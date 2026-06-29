# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Quick Trim — a minimal, Quick-Look-style **lossless video trimmer**. The same app ships as **two desktop versions from one UI codebase**: an **Electron** build (bundled ffmpeg, Chromium) and a **Tauri** build (system WebView, ffmpeg resolved at runtime, tiny installer). Trimming/exporting is identical in both (both shell out to ffmpeg); only the shell and ffmpeg delivery differ.

## Commands

```bash
npm install                 # deps for the Electron build (+ @tauri-apps/cli, ffmpeg-static, @ffprobe-installer)

# Electron
npm start                   # run
npm run dist:win | dist:mac # package (.exe nsis+portable / .dmg)

# Tauri (needs Rust ≥ 1.88; Node NOT required for the build itself)
npm run tauri:dev           # run (or: cargo tauri dev --manifest-path src-tauri/Cargo.toml)
npm run tauri:build         # package (.dmg / nsis .exe / .AppImage)
cd src-tauri && cargo check # fast type-check of the Rust backend
```

There is **no automated test suite**. Verify changes by running the app and observing behavior (load a video, scrub, export). For quick Rust feedback use `cargo check` in `src-tauri/`. ffmpeg-arg logic can be checked headlessly by running the exact arg arrays through the bundled binary (`node_modules/ffmpeg-static/ffmpeg`).

## Architecture: one UI, two backends, joined by `window.api`

```
ui/            ← framework-agnostic UI; talks ONLY to window.api
  index.html   ← layout + the meta CSP (governs BOTH backends — see gotchas)
  renderer.js  ← all UI logic
  styles.css
  export-args.js ← UMD module: the SINGLE source of truth for ffmpeg arg building
  bridge.js    ← builds window.api under Tauri; no-op under Electron
electron/
  main.js      ← Electron main process (IPC handlers, spawns ffmpeg)
  preload.js   ← exposes window.api via contextBridge
src-tauri/
  src/main.rs  ← Tauri commands (Rust), the local media server, ffmpeg resolution
```

The renderer never imports Electron or Tauri APIs directly — it only calls `window.api.*`. Each backend provides that object:

- **Electron**: `preload.js` builds `window.api` (contextBridge) before page scripts run; methods are thin `ipcRenderer.invoke` wrappers to `main.js`.
- **Tauri**: `bridge.js` detects `window.__TAURI__` and builds the *same* `window.api` from `invoke`/events; under Electron it returns early (no-op, since preload already set it).

**Adding/changing a feature usually means editing in parallel:** `renderer.js` (UI) + the method in **both** `preload.js` and `bridge.js` + (for Tauri) a `#[tauri::command]` in `main.rs`. Keep the two `window.api` surfaces behaviorally identical.

`ui/export-args.js` is shared by both backends — Electron `main.js` `require()`s it; `bridge.js` uses it as the browser global `window.QTExportArgs`. Keep it **pure** (no Node/DOM/framework). It maps each export "kind" (`lossless`, `precise`, `reencode`, `audio`, `gif`, `stripAudio`, `frame`) to ffmpeg args. **Never duplicate ffmpeg arg logic anywhere else.**

Note the export flow differs by backend: in Electron, `exportClip(opts)` is one IPC call and `main.js` does dialogs + ffmpeg + atomic file move. In Tauri, `bridge.js`'s `exportClip` runs the dialogs in JS (`open_dialog`/`save_dialog`/`save_choice`), builds args via `export-args.js`, then calls the Rust `run_export` command (which only spawns ffmpeg, streams progress, and moves the temp file into place).

## Backend-specific invariants (non-obvious; learned the hard way)

**Tauri**
- **Blocking commands MUST be `async fn`.** Sync Tauri commands run on the main/UI thread; the dialog plugin's `blocking_*` calls then deadlock (frozen UI), and ffmpeg spawns freeze the UI. `probe`, `thumbnails`, `run_export`, `download_ffmpeg`, and all dialog commands are `async` for this reason. `ffmpeg_status`/`take_pending_open` are fast and stay sync.
- **Video preview uses a local range-capable HTTP server, not `asset://`.** WKWebView's custom-scheme handler can't serve byte-range requests, so large videos fail (`<video>` error code 4) over `asset://`. `start_media_server()` in `main.rs` serves files from `127.0.0.1` (random port, token-guarded) with `Range`/`206` support; `bridge.js`'s `toMediaSrc` points `<video>` at it. `renderer.js` awaits `window.api.whenReady()` before setting `video.src`.
- **ffmpeg is not bundled.** Resolution order (`resolve_tools` in `main.rs`): system PATH → common dirs (`/opt/homebrew/bin`, etc. — GUI apps get a minimal PATH, so probe these explicitly) → previously downloaded copy. If none, the UI prompts (download via `ffmpeg-sidecar` with progress, or manual pick); nothing downloads silently. The macOS auto-download ships **ffmpeg only, no ffprobe**, so `probe` falls back to parsing `ffmpeg -i` stderr when ffprobe is absent.
- **`RunEvent::Opened` is macOS-only** — gate it with `#[cfg(target_os = "macos")]` or the Windows/Linux build fails (E0599). Windows/Linux get the opened file via argv (handled in `setup()`).

**Electron**
- **ffprobe comes from `@ffprobe-installer/ffprobe`, not `ffprobe-static`** — the latter mislabels an x86_64 binary as arm64 (forces Rosetta, flags the app as Intel). ffmpeg is `ffmpeg-static`.
- Bundled binaries are unpacked via `asarUnpack`; `main.js` rewrites `app.asar` → `app.asar.unpacked` at runtime.

**Shared UI**
- **The `<meta>` CSP in `ui/index.html` is a union for both backends.** It must keep `file:` (Electron media), `ipc://localhost`/`http://ipc.localhost` (Tauri IPC), and `http://127.0.0.1:*` / `http://localhost:*` (Tauri media server) in the right directives, or one backend silently breaks. Tauri's own CSP is `null` so only this meta tag applies there.
- Window dragging needs **both** `-webkit-app-region: drag` (Electron) and `data-tauri-drag-region` (Tauri) on the same elements. Platform padding for OS window controls keys off the `platform-darwin`/`platform-win32` body class set by `renderer.js`.

## Trimming / export semantics

- **Lossless** (`-c copy`, the default 「完成」) only cuts at keyframes, so the real start snaps to the nearest keyframe. This is inherent; the UI states it.
- **Precise mode** re-encodes (frame-accurate); for containers that can't hold H.264/AAC it forces a `.mp4` output.
- **Hardware encoders are runtime-probed** (`hw_encoders` / `detectHwEncoders` test-encode a few frames per candidate) — never assume availability. Candidates are per-platform (VideoToolbox / NVENC / QSV / AMF). The codec dropdown is populated from what actually works.
- In-place "replace" always writes a temp file first, then atomically moves it over the original.

## CI

`.github/workflows/build.yml` has two jobs (`electron`, `tauri`) producing **separately-named artifacts** (`quick-trim-electron-*` / `quick-trim-tauri-*`); installer files are prefixed `electron-`/`tauri-` and Windows gets both `*-setup.exe` (path-changeable NSIS) and `*-portable.exe`. Builds are unsigned. Tags `v*` publish a Release.
