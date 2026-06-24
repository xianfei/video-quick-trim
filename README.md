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
- 📦 **内置 ffmpeg**：通过 `ffmpeg-static` / `ffprobe-static` 打包，用户无需自己装 ffmpeg

## 开发

```bash
npm install      # 安装依赖（含 electron 与 ffmpeg/ffprobe 二进制）
npm start        # 启动应用
```

## 打包

```bash
npm run dist         # 当前平台
npm run dist:win     # Windows (.exe, nsis)
npm run dist:mac     # macOS (.dmg)
```

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

Electron + 原生 HTML/CSS/JS，`ffmpeg-static` / `ffprobe-static`，`electron-builder` 打包。
