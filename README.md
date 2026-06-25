# Quick Trim — 极简无损视频裁剪工具

像 macOS 空格预览(Quick Look)一样简洁的视频无损裁剪工具。拖入一个视频 → 拖拽/输入起止时间 → 点「完成」选择**替换原文件**或**另存为**。核心裁剪用 `ffmpeg -c copy` 实现**无损、秒级**出片。跨平台（Windows / macOS / Linux）。

## 特性

- 🎬 **拖拽即用**：拖入视频直接进入预览/裁剪界面
- ✂️ **无损裁剪**：默认 `ffmpeg -ss -t -c copy`，画质零损失、几乎瞬间完成
- 🎯 **可选精确模式**：勾选后重新编码以达帧精确（稍慢，轻微画质损失）
- 🛠️ **高级导出（⋯ 菜单）**：
  - **重编码导出**：预设（高质量 H.264 / 高压缩 H.265 / 硬件加速 / 网页 WebM）+ 高级设置（编码器、CRF/码率、分辨率缩放、帧率、音频、封装格式）
    - **硬件加速按平台自动识别**：启动时实地试编码探测可用编码器——macOS → VideoToolbox；Windows → NVIDIA NVENC / Intel QSV / AMD AMF；Linux → NVENC / QSV。只把当前机器真正可用的编码器加入下拉框，没有则隐藏硬件加速预设。软件编码器（libx264 / libx265 / VP9）始终可用。
  - **仅导出音频**：MP3 / AAC(m4a) / WAV / FLAC
  - **转为 GIF**：可选帧率与宽度（调色板优化，画质佳）
  - **移除音频（无损）**：流复制去掉音轨
  - **导出当前帧为图片**：截取播放头处的画面为 PNG
- 🎞️ **缩略图胶片条**：底部时间轴铺满抽帧缩略图，定位一目了然
- ⌨️ **精确输入**：起/止支持 `HH:MM:SS.mmm` 直接输入，与拖拽手柄双向同步
- 💾 **保存即问**：替换原文件 / 另存为
- 📦 **内置 ffmpeg**：通过 `ffmpeg-static` / `@ffprobe-installer/ffprobe` 打包，用户无需自己装 ffmpeg

## 两个版本：Electron 与 Tauri

本项目同时维护 **Electron** 与 **Tauri** 两个版本，**界面与功能完全一致**（共享同一套 UI 代码），用户可自行选择构建哪个：

| | Electron 版（大而全） | Tauri 版（精简） |
|---|---|---|
| 渲染内核 | 内置 Chromium | 系统 WebView（Win: WebView2 / mac: WKWebView）|
| 安装包体积 | 较大（~80–150MB）| 极小（~10–20MB）|
| **ffmpeg** | **预置内置**（离线即装即用）| **不预置**：优先用系统 PATH，没有则首次使用时自动下载到 app 数据目录 |
| 视频**预览**兼容性 | 最佳（HEVC/HDR 都能播）| 受系统 WebView 限制（Windows 上 HEVC/HDR 可能无法预览）|
| **裁剪 / 导出** | ✅ 完全一致（都调用 ffmpeg）| ✅ 完全一致（都调用 ffmpeg）|
| 后端 | Node 主进程 (`electron/`) | Rust (`src-tauri/`) |
| 构建依赖 | 需要 Node | **纯 Cargo，无需 Node** |

> 两个版本的裁剪与导出行为完全相同（都调用 ffmpeg）。两点差异：
> 1. **预览**：Tauri 用系统 WebView，Windows 上对 HEVC/HDR 解码支持有限，预览可能黑屏（但仍可正常裁剪导出）。Tauri 版通过内置的本地 range HTTP 服务（127.0.0.1，带 token）给 `<video>` 喂流，因此大文件（数 GB）也能像 Safari 一样按需流式播放、可拖动进度——绕开了 WKWebView 自定义 `asset://` 协议不支持字节范围请求的限制。
> 2. **ffmpeg**：Electron 预置打包（离线即用，但安装包大）；Tauri 不预置——先找系统 `ffmpeg`（PATH 或 `/opt/homebrew/bin` 等常见位置），找不到则用 [`ffmpeg-sidecar`](https://lib.rs/crates/ffmpeg-sidecar) 在首次使用时自动下载（约 40MB，仅一次），保持安装包极小。两类用户各取所需。

### 架构（如何做到一致）

```
ui/            ← 共享：index.html / styles.css / renderer.js（框架无关）
               + export-args.js（ffmpeg 参数逻辑，两端共用）
               + bridge.js（探测运行环境，为 Tauri 构建 window.api）
electron/      ← Electron 主进程 + preload（提供 window.api）
src-tauri/     ← Rust 命令 + 配置（提供同样的 window.api，经 invoke）
```

渲染层只与抽象的 `window.api` 对话。Electron 由 `preload.js` 注入，Tauri 由 `bridge.js` 用 `invoke`/事件实现同一套接口。ffmpeg 参数由 `ui/export-args.js` 一处生成、两端共用——**单一事实来源**。

## 开发

```bash
# Electron 版（需要 Node）
npm install            # 含 electron 与内置 ffmpeg/ffprobe 二进制
npm start

# Tauri 版（需要 Rust 工具链 rustc ≥ 1.88；不需要 Node）
cargo install tauri-cli --version "^2"   # 一次性安装 CLI
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

> 也可以用 `npm run tauri:dev`（如果装了 Node 与 `@tauri-apps/cli`），但 Tauri 版本身**不依赖 Node** —— `cargo tauri` 即可开发与打包。前端是纯静态 `ui/`，无需任何打包步骤。

## 打包

```bash
# Electron
npm run dist           # 当前平台
npm run dist:win       # Windows (.exe, nsis)
npm run dist:mac       # macOS (.dmg)

# Tauri（纯 Cargo，无需 Node）
cargo tauri build --manifest-path src-tauri/Cargo.toml   # .dmg / .nsis / .AppImage
```

### Windows 产物

两个版本都为 Windows 提供两种产物：

- **NSIS 安装包**：安装时**可自定义安装路径**（Electron 设了 `oneClick:false` + `allowToChangeInstallationDirectory`；Tauri 安装包默认就有“选择安装位置”页）。
- **免安装便携版**：Electron 用 electron-builder 的 `portable` 目标生成单文件可执行；Tauri 直接用主 `exe`（自包含，依赖系统 WebView2——Win11/较新 Win10 默认已装）。

CI 会把它们分别命名上传（`*-setup.exe` / `*-portable.exe`，并带 `electron-`/`tauri-` 前缀），便于区分。

Tauri 版**不打包 ffmpeg**，启动时先找系统 `ffmpeg`/`ffprobe`（PATH 及 `/opt/homebrew/bin` 等常见位置）。找不到时**不会静默下载**，而是弹出提示，让用户选择：

- **自动下载**：用 `ffmpeg-sidecar` 取得对应平台/架构的 ffmpeg，下载到 app 数据目录，并显示实时进度条（macOS 的下载仅含 ffmpeg，此时元数据探测自动回退到解析 `ffmpeg -i` 输出）。
- **手动选择**：指定一个已有的 ffmpeg 可执行文件（会校验并自动定位旁边的 ffprobe）。

之后可随时在 **⋯ 菜单 → 设置 ffmpeg…** 重新配置。

ffmpeg / ffprobe 二进制通过 electron-builder 的 `asarUnpack` 解包到 `app.asar.unpacked`，主进程在生产环境自动把路径中的 `app.asar` 替换为 `app.asar.unpacked`。

## 操作

| 操作 | 方式 |
|------|------|
| 打开视频 | 拖拽进窗口，或点「点击打开」 |
| 选起止点 | 拖拽两个黄色手柄，或在输入框输入时间 |
| 预览 | 点播放按钮 / 空格键（循环播放选区） |
| 微调播放头 | ← → 方向键（±0.1s，按住 Shift ±1s）|
| 保存 | 点「完成」→ 替换原文件 / 另存为 |

## 关于裁剪精度

- **无损模式（默认）**：使用流复制 `-c copy`，只能在**关键帧**处切割，因此实际起点会自动「吸附」到最近的关键帧，可能与所选位置相差几帧。这是无损剪辑的固有特性，换来的是零画质损失与极快速度。
- **精确模式**：重新编码视频开头部分以实现帧精确切割，速度较慢且有轻微画质损失。

## 已知限制

- HEVC/HDR 视频的**预览**依赖 Electron(Chromium) 的解码能力；在部分 Windows 环境下 HEVC 预览可能黑屏（需系统安装 HEVC 解码扩展）。即便预览受限，**裁剪本身仍然可用**，因为 `-c copy` 无需解码视频。

## 打包发布前（可选）

以下为对外分发时建议补齐的项，本地自用可忽略：

- **应用图标**：在 `build/` 目录放入 `icon.icns`(macOS) / `icon.ico`(Windows) / `icon.png`(Linux)，electron-builder 会自动识别，否则使用默认 Electron 图标。
- **macOS 签名 / 公证**：未签名的 `.dmg` 会被 Gatekeeper 拦截（内置的 ffmpeg/ffprobe 二进制会被隔离）。如需公开分发，需配置 Apple Developer ID（`build.mac.hardenedRuntime`、entitlements、notarize）。
- **Windows 签名**：未签名的 `.exe` 会触发 SmartScreen 警告，可选配置代码签名证书。

## 技术栈

Electron + 原生 HTML/CSS/JS，`ffmpeg-static` / `@ffprobe-installer/ffprobe`，`electron-builder` 打包。
