#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const VIDEO_EXTS: [&str; 9] = ["mp4", "mov", "mkv", "m4v", "avi", "webm", "ts", "flv", "wmv"];

// A file the app was launched/opened with, awaiting the frontend to pick it up.
struct PendingOpen(Mutex<Option<String>>);

// Resolved ffmpeg/ffprobe paths (cached after first resolution).
#[derive(Default)]
struct ToolsState(Mutex<Option<Tools>>);

#[derive(Clone)]
struct Tools {
    ffmpeg: PathBuf,
    ffprobe: Option<PathBuf>, // may be absent (macOS auto-download ships ffmpeg only)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeInfo {
    duration_sec: f64,
    width: i64,
    height: i64,
    vcodec: String,
    acodec: String,
    ext: String,
    name: String,
}

#[derive(Serialize, Clone)]
struct HwEnc {
    id: String,
    codec: String,
    label: String,
}

fn is_video(path: &str) -> bool {
    let lower = path.to_lowercase();
    VIDEO_EXTS.iter().any(|e| lower.ends_with(&format!(".{}", e)))
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn ext_no_dot(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

// ---- local media server (range-capable, for large-video streaming) --------

// Base URL prefix the frontend prepends the (encoded) file path to.
struct MediaBase(String);

fn content_type(path: &str) -> &'static str {
    let ext = Path::new(path).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// Parse a "bytes=start-end" Range header into an inclusive (start, end).
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let r = h.trim().strip_prefix("bytes=")?;
    let (s, e) = r.split_once('-')?;
    let (start, end) = if s.is_empty() {
        let n: u64 = e.trim().parse().ok()?;
        (len.saturating_sub(n.min(len)), len.saturating_sub(1))
    } else {
        let start: u64 = s.trim().parse().ok()?;
        let end = if e.trim().is_empty() { len - 1 } else { e.trim().parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    if len == 0 || start > end || start >= len {
        return None;
    }
    Some((start, end))
}

fn hdr(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn serve_media(req: tiny_http::Request, token: &str) {
    use std::io::{Read, Seek, SeekFrom};
    let url = req.url().to_string();
    let (path_part, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    if path_part != "/media" {
        let _ = req.respond(tiny_http::Response::empty(404));
        return;
    }
    let (mut tok, mut file_path) = (String::new(), String::new());
    for kv in query.split('&') {
        if let Some(v) = kv.strip_prefix("token=") {
            tok = v.to_string();
        } else if let Some(v) = kv.strip_prefix("path=") {
            file_path = percent_decode(v);
        }
    }
    if tok != token {
        let _ = req.respond(tiny_http::Response::empty(403));
        return;
    }
    let file = match std::fs::File::open(&file_path) {
        Ok(f) => f,
        Err(_) => {
            let _ = req.respond(tiny_http::Response::empty(404));
            return;
        }
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = content_type(&file_path);
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    match range.as_deref().and_then(|r| parse_range(r, len)) {
        Some((start, end)) => {
            let mut f = file;
            let _ = f.seek(SeekFrom::Start(start));
            let chunk = end - start + 1;
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(206),
                vec![
                    hdr("Content-Type", ctype),
                    hdr("Accept-Ranges", "bytes"),
                    hdr("Content-Range", &format!("bytes {}-{}/{}", start, end, len)),
                ],
                f.take(chunk),
                Some(chunk as usize),
                None,
            );
            let _ = req.respond(resp);
        }
        None => {
            let resp = tiny_http::Response::new(
                tiny_http::StatusCode(200),
                vec![hdr("Content-Type", ctype), hdr("Accept-Ranges", "bytes")],
                file,
                Some(len as usize),
                None,
            );
            let _ = req.respond(resp);
        }
    }
}

// Start the localhost media server; returns the URL prefix to prepend the
// encoded file path to. A token keeps other local web content from reading files.
fn start_media_server() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let token = format!("{:x}{:x}", std::process::id(), nanos);
    let server = tiny_http::Server::http("127.0.0.1:0").expect("media server");
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let tok = token.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let t = tok.clone();
            std::thread::spawn(move || serve_media(req, &t));
        }
    });
    format!("http://127.0.0.1:{}/media?token={}&path=", port, token)
}

#[tauri::command]
fn media_base(state: State<MediaBase>) -> String {
    state.0.clone()
}

// ---- ffmpeg resolution ----------------------------------------------------

// Find a binary on PATH, or in common install locations. GUI apps on macOS get
// a minimal PATH (no Homebrew), so we probe the usual dirs explicitly too.
fn find_binary(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    let dirs: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    } else if cfg!(target_os = "linux") {
        &["/usr/bin", "/usr/local/bin", "/snap/bin"]
    } else {
        &[]
    };
    for d in dirs {
        let p = Path::new(d).join(exe_name(name));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn managed_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ffmpeg");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(unix)]
fn make_executable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755));
}
#[cfg(not(unix))]
fn make_executable(_p: &Path) {}

// Fast resolution (NO download): cached → system PATH/common dirs →
// previously-downloaded copy. Returns None if ffmpeg isn't available — the UI
// then asks the user whether to download or pick one manually.
fn resolve_tools(app: &tauri::AppHandle) -> Option<Tools> {
    let state = app.state::<ToolsState>();
    let mut guard = state.0.lock().unwrap();
    if let Some(t) = guard.as_ref() {
        return Some(t.clone());
    }
    if let Some(ffmpeg) = find_binary("ffmpeg") {
        let tools = Tools { ffmpeg, ffprobe: find_binary("ffprobe") };
        *guard = Some(tools.clone());
        return Some(tools);
    }
    if let Ok(dir) = managed_dir(app) {
        let ff = dir.join(exe_name("ffmpeg"));
        if ff.is_file() {
            let fp = dir.join(exe_name("ffprobe"));
            let tools = Tools { ffmpeg: ff, ffprobe: fp.is_file().then_some(fp) };
            *guard = Some(tools.clone());
            return Some(tools);
        }
    }
    None
}

fn require_tools(app: &tauri::AppHandle) -> Result<Tools, String> {
    resolve_tools(app).ok_or_else(|| "ffmpeg 未就绪".to_string())
}

// Is ffmpeg available right now (without downloading)?
#[tauri::command]
fn ffmpeg_status(app: tauri::AppHandle) -> bool {
    resolve_tools(&app).is_some()
}

#[derive(serde::Serialize)]
struct FfmpegInfo {
    available: bool,
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    source: String, // "downloaded" (in app data) | "system" (PATH/common/manual) | "none"
}

// Where the currently-resolved ffmpeg comes from, so the setup modal can show it
// instead of always prompting to download.
#[tauri::command]
fn ffmpeg_info(app: tauri::AppHandle) -> FfmpegInfo {
    match resolve_tools(&app) {
        Some(t) => {
            let downloaded = managed_dir(&app)
                .ok()
                .map_or(false, |dir| t.ffmpeg.starts_with(&dir));
            FfmpegInfo {
                available: true,
                ffmpeg: Some(t.ffmpeg.to_string_lossy().into_owned()),
                ffprobe: t.ffprobe.as_ref().map(|p| p.to_string_lossy().into_owned()),
                source: if downloaded { "downloaded" } else { "system" }.into(),
            }
        }
        None => FfmpegInfo {
            available: false,
            ffmpeg: None,
            ffprobe: None,
            source: "none".into(),
        },
    }
}

fn download_with_progress(app: &tauri::AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 16];
    let mut got: u64 = 0;
    let mut last = -2.0_f64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        let pct = if total > 0 {
            (got as f64 / total as f64) * 100.0
        } else {
            -1.0 // unknown size → indeterminate
        };
        if pct < 0.0 || pct - last >= 1.0 {
            last = pct;
            let _ = app.emit("ffmpeg-download-progress", pct);
        }
    }
    let _ = app.emit("ffmpeg-download-progress", 100.0);
    Ok(())
}

// Download ffmpeg into the app data dir (user-initiated), streaming progress via
// the "ffmpeg-download-progress" event (0–100, or -1 for unknown size).
#[tauri::command]
async fn download_ffmpeg(app: tauri::AppHandle) -> Result<(), String> {
    let dir = managed_dir(&app)?;
    let url = ffmpeg_sidecar::download::ffmpeg_download_url().map_err(|e| e.to_string())?;
    let archive = dir.join(if cfg!(target_os = "linux") {
        "ffmpeg-download.tar.xz"
    } else {
        "ffmpeg-download.zip"
    });
    download_with_progress(&app, url, &archive)?;
    ffmpeg_sidecar::download::unpack_ffmpeg(&archive, &dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&archive);

    let ff = dir.join(exe_name("ffmpeg"));
    if !ff.is_file() {
        return Err("下载完成但未找到 ffmpeg 可执行文件".into());
    }
    make_executable(&ff);
    let fp = dir.join(exe_name("ffprobe"));
    if fp.is_file() {
        make_executable(&fp);
    }
    *app.state::<ToolsState>().0.lock().unwrap() =
        Some(Tools { ffmpeg: ff, ffprobe: fp.is_file().then_some(fp) });
    Ok(())
}

// Let the user point at an existing ffmpeg binary; validate it, locate a nearby
// ffprobe, and cache the result. Returns false if the user cancelled.
#[tauri::command]
async fn pick_and_set_ffmpeg(app: tauri::AppHandle) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("选择 ffmpeg 可执行文件")
        .blocking_pick_file();
    let path = match picked {
        Some(p) => PathBuf::from(p.to_string()),
        None => return Ok(false),
    };
    let valid = Command::new(&path)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !valid {
        return Err("所选文件不是有效的 ffmpeg 可执行文件".into());
    }
    let ffprobe = path
        .parent()
        .map(|d| d.join(exe_name("ffprobe")))
        .filter(|p| p.is_file())
        .or_else(|| find_binary("ffprobe"));
    *app.state::<ToolsState>().0.lock().unwrap() = Some(Tools { ffmpeg: path, ffprobe });
    Ok(true)
}

// ---- probe ----------------------------------------------------------------

fn parse_hms(s: &str) -> f64 {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
        let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
        let sec: f64 = parts[2].trim().parse().unwrap_or(0.0);
        return h * 3600.0 + m * 60.0 + sec;
    }
    s.trim().parse().unwrap_or(0.0)
}

fn parse_ffprobe_json(stdout: &[u8], path: &str) -> Result<ProbeInfo, String> {
    let json: Value = serde_json::from_slice(stdout).map_err(|e| e.to_string())?;
    let duration_sec = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let empty = vec![];
    let streams = json["streams"].as_array().unwrap_or(&empty);
    let v = streams.iter().find(|s| s["codec_type"] == "video");
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    Ok(ProbeInfo {
        duration_sec,
        width: v.and_then(|s| s["width"].as_i64()).unwrap_or(0),
        height: v.and_then(|s| s["height"].as_i64()).unwrap_or(0),
        vcodec: v.and_then(|s| s["codec_name"].as_str()).unwrap_or("").to_string(),
        acodec: a.and_then(|s| s["codec_name"].as_str()).unwrap_or("").to_string(),
        ext: ext_no_dot(path),
        name: file_name(path),
    })
}

// Extract "WIDTHxHEIGHT" (e.g. 1920x1080) from an ffmpeg stream line.
fn parse_resolution(line: &str) -> Option<(i64, i64)> {
    for tok in line.split(|c: char| c == ' ' || c == ',' || c == '(' || c == ')') {
        let t = tok.trim();
        if let Some(xi) = t.find('x') {
            let (a, b) = (&t[..xi], &t[xi + 1..]);
            if let (Ok(w), Ok(h)) = (a.parse::<i64>(), b.parse::<i64>()) {
                if w >= 16 && h >= 16 {
                    return Some((w, h));
                }
            }
        }
    }
    None
}

// Fallback metadata extraction from `ffmpeg -i` stderr (when no ffprobe).
fn parse_ffmpeg_info(stderr: &str, path: &str) -> ProbeInfo {
    let mut duration = 0.0;
    if let Some(i) = stderr.find("Duration:") {
        let val: String = stderr[i + "Duration:".len()..]
            .trim_start()
            .chars()
            .take_while(|c| *c != ',')
            .collect();
        duration = parse_hms(val.trim());
    }
    let (mut w, mut h, mut vcodec, mut acodec) = (0i64, 0i64, String::new(), String::new());
    for line in stderr.lines() {
        let l = line.trim();
        if vcodec.is_empty() {
            if let Some(vi) = l.find("Video:") {
                vcodec = l[vi + 6..]
                    .trim()
                    .split([' ', ',', '('])
                    .next()
                    .unwrap_or("")
                    .to_string();
                if let Some((ww, hh)) = parse_resolution(l) {
                    w = ww;
                    h = hh;
                }
            }
        }
        if acodec.is_empty() {
            if let Some(ai) = l.find("Audio:") {
                acodec = l[ai + 6..]
                    .trim()
                    .split([' ', ',', '('])
                    .next()
                    .unwrap_or("")
                    .to_string();
            }
        }
    }
    ProbeInfo {
        duration_sec: duration,
        width: w,
        height: h,
        vcodec,
        acodec,
        ext: ext_no_dot(path),
        name: file_name(path),
    }
}

#[tauri::command]
async fn probe(app: tauri::AppHandle, path: String) -> Result<ProbeInfo, String> {
    let tools = require_tools(&app)?;
    if let Some(ffprobe) = &tools.ffprobe {
        let out = Command::new(ffprobe)
            .args([
                "-v", "error",
                "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
                "-of", "json", &path,
            ])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                return parse_ffprobe_json(&o.stdout, &path);
            }
        }
        // fall through to ffmpeg-based parsing on any failure
    }
    let out = Command::new(&tools.ffmpeg)
        .args(["-hide_banner", "-i", &path])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(parse_ffmpeg_info(&String::from_utf8_lossy(&out.stderr), &path))
}

// ---- thumbnails -----------------------------------------------------------

#[tauri::command]
async fn thumbnails(
    app: tauri::AppHandle,
    path: String,
    count: u32,
    duration_sec: f64,
) -> Result<Vec<Option<String>>, String> {
    let tools = require_tools(&app)?;
    let n = count.clamp(1, 20);
    let dir = std::env::temp_dir().join(format!("qt-thumbs-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let mut out = Vec::new();
    for i in 0..n {
        let t = if duration_sec > 0.0 {
            duration_sec * (i as f64 + 0.5) / n as f64
        } else {
            0.0
        };
        let file = dir.join(format!("thumb-{}.jpg", i));
        let file_str = file.to_string_lossy().to_string();
        let res = Command::new(&tools.ffmpeg)
            .args([
                "-ss", &t.to_string(), "-i", &path, "-frames:v", "1",
                "-vf", "scale=160:-1", "-q:v", "5", "-y", &file_str,
            ])
            .output();
        match res {
            Ok(o) if o.status.success() => match std::fs::read(&file) {
                Ok(bytes) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    out.push(Some(format!("data:image/jpeg;base64,{}", b64)));
                }
                Err(_) => out.push(None),
            },
            _ => out.push(None),
        }
    }
    Ok(out)
}

// ---- hardware encoder detection -------------------------------------------

fn hw_candidates() -> Vec<HwEnc> {
    let mk = |id: &str, codec: &str, label: &str| HwEnc {
        id: id.into(),
        codec: codec.into(),
        label: label.into(),
    };
    match std::env::consts::OS {
        "macos" => vec![
            mk("h264_videotoolbox", "h264", "H.264 硬件加速 (VideoToolbox)"),
            mk("hevc_videotoolbox", "hevc", "H.265 硬件加速 (VideoToolbox)"),
        ],
        "windows" => vec![
            mk("hevc_nvenc", "hevc", "H.265 硬件加速 (NVIDIA NVENC)"),
            mk("h264_nvenc", "h264", "H.264 硬件加速 (NVIDIA NVENC)"),
            mk("hevc_qsv", "hevc", "H.265 硬件加速 (Intel QSV)"),
            mk("h264_qsv", "h264", "H.264 硬件加速 (Intel QSV)"),
            mk("hevc_amf", "hevc", "H.265 硬件加速 (AMD AMF)"),
            mk("h264_amf", "h264", "H.264 硬件加速 (AMD AMF)"),
        ],
        _ => vec![
            mk("hevc_nvenc", "hevc", "H.265 硬件加速 (NVIDIA NVENC)"),
            mk("h264_nvenc", "h264", "H.264 硬件加速 (NVIDIA NVENC)"),
            mk("hevc_qsv", "hevc", "H.265 硬件加速 (Intel QSV)"),
            mk("h264_qsv", "h264", "H.264 硬件加速 (Intel QSV)"),
        ],
    }
}

fn encoder_works(ffmpeg: &Path, enc: &str) -> bool {
    Command::new(ffmpeg)
        .args([
            "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "color=c=black:s=256x256:r=5:d=0.2", "-frames:v", "3",
            "-c:v", enc, "-f", "null", "-",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn hw_encoders(app: tauri::AppHandle) -> Vec<HwEnc> {
    let tools = match require_tools(&app) {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    hw_candidates()
        .into_iter()
        .filter(|c| encoder_works(&tools.ffmpeg, &c.id))
        .collect()
}

// ---- export ---------------------------------------------------------------

fn parse_progress_time(s: &str) -> Option<f64> {
    let idx = s.find("out_time=").or_else(|| s.find("time="))?;
    let val = s[idx..].split('=').nth(1)?.split_whitespace().next()?;
    let mut parts = val.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

// Move temp -> final. Retries rename on transient locks (Windows: media-handle
// teardown, antivirus, Search indexer) before falling back to a copy — which
// also covers a genuine cross-volume move.
fn move_into(tmp: &str, final_path: &str) -> Result<(), String> {
    for i in 0..6 {
        match std::fs::rename(tmp, final_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = e.kind() == std::io::ErrorKind::PermissionDenied
                    || matches!(e.raw_os_error(), Some(5) | Some(32)); // Win ACCESS_DENIED / SHARING_VIOLATION
                if transient && i < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    continue;
                }
                break;
            }
        }
    }
    std::fs::copy(tmp, final_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(tmp);
    Ok(())
}

#[tauri::command]
async fn run_export(
    app: tauri::AppHandle,
    args: Vec<String>,
    tmp_path: String,
    final_path: String,
    original_path: String,
    is_replace: bool,
    total_dur: f64,
) -> Result<String, String> {
    let tools = require_tools(&app)?;
    // Prepend newline-terminated progress so we can stream percentages reliably.
    let mut full: Vec<String> = vec!["-progress".into(), "pipe:2".into()];
    full.extend(args);

    let mut child = Command::new(&tools.ffmpeg)
        .args(&full)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let mut tail = String::new();
    for line in BufReader::new(stderr).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if total_dur > 0.0 {
            if let Some(t) = parse_progress_time(&line) {
                let pct = ((t / total_dur) * 100.0).clamp(0.0, 100.0);
                let _ = app.emit("export-progress", pct);
            }
        }
        tail.push_str(&line);
        tail.push('\n');
        if tail.len() > 4000 {
            tail = tail.split_off(tail.len() - 4000);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("ffmpeg 退出码 {:?}\n{}", status.code(), tail));
    }

    // Move temp -> final: retry transient locks, else copy across volumes.
    move_into(&tmp_path, &final_path)?;
    if is_replace && Path::new(&final_path) != Path::new(&original_path) {
        let _ = std::fs::remove_file(&original_path);
    }
    Ok(final_path)
}

// ---- native dialogs (plugin-dialog Rust API) ------------------------------

#[tauri::command]
async fn open_dialog(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Video", &VIDEO_EXTS)
        .blocking_pick_file()
        .map(|p| p.to_string())
}

#[tauri::command]
async fn save_dialog(app: tauri::AppHandle, default_path: String, ext: String) -> Option<String> {
    let pb = PathBuf::from(&default_path);
    let mut builder = app.dialog().file().add_filter("File", &[ext.as_str()]);
    if let Some(parent) = pb.parent() {
        builder = builder.set_directory(parent);
    }
    if let Some(name) = pb.file_name() {
        builder = builder.set_file_name(name.to_string_lossy().to_string());
    }
    builder.blocking_save_file().map(|p| p.to_string())
}

#[tauri::command]
async fn save_choice(app: tauri::AppHandle) -> String {
    let replace = app
        .dialog()
        .message("「替换原文件」会覆盖原视频；「另存为」会保存为新文件。")
        .title("保存")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "替换原文件".into(),
            "另存为".into(),
        ))
        .blocking_show();
    if replace {
        "replace".into()
    } else {
        "saveAs".into()
    }
}

#[tauri::command]
fn take_pending_open(state: State<PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen(Mutex::new(None)))
        .manage(ToolsState::default())
        .manage(MediaBase(start_media_server()))
        .setup(|app| {
            // A file passed on the command line ("Open With" on Windows/Linux).
            let args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(f) = args
                .iter()
                .find(|a| !a.starts_with('-') && is_video(a) && Path::new(a).exists())
            {
                *app.state::<PendingOpen>().0.lock().unwrap() = Some(f.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe, thumbnails, hw_encoders, run_export,
            open_dialog, save_dialog, save_choice, take_pending_open,
            ffmpeg_status, ffmpeg_info, download_ffmpeg, pick_and_set_ffmpeg, media_base
        ])
        .build(tauri::generate_context!())
        .expect("error while building Quick Trim")
        .run(|_app, _event| {
            // macOS delivers "Open With" / double-click as an Opened event.
            // (Windows/Linux receive the file via argv — handled in setup().)
            // RunEvent::Opened only exists on macOS, so gate it out elsewhere.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(p) = url.to_file_path() {
                        let s = p.to_string_lossy().to_string();
                        if let Some(state) = _app.try_state::<PendingOpen>() {
                            *state.0.lock().unwrap() = Some(s.clone());
                        }
                        let _ = _app.emit("open-file", s);
                    }
                }
            }
        });
}
