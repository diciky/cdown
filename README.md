# CDown - 极速多线程下载器

<p align="right"><b>开发者：diciky</b> · <a href="mailto:diciky.zl@gmail.com">diciky.zl@gmail.com</a> · License: MIT</p>

灵感来自 tdmfast.com 的本地版极速下载器（品牌：CDown），Electron 桌面应用。

## ✨ 特性一览

- ⚡ 最高 64 线程分段并行下载，慢段自动补线程
- ⏸ 断点续传（暂停/中断后从断点继续，分段失败自动重试 8 次）
- 🎬 集成 yt-dlp：B站 / YouTube / X / TikTok 等 1800+ 站点视频一键下载
- 📺 m3u8/HLS 分片流自动合并 MP4
- 🤗 HuggingFace 大模型文件专项优化（绕过 CDN 签名限制）
- 🌐 附带 Chrome/Edge 浏览器扩展：右键下载 + 页面媒体嗅探
- 📋 任务队列管理 / 剪贴板自动识别 / 链接批量导出

## 打包 exe

```bash
npm install
npm run dist   # 产出 dist/ 下的安装版 (CDown Setup x.x.exe) 与便携版 (CDown x.x.exe)
```

图标 `build/icon.ico`（由 `build/icon.png` 生成）；打包后数据目录在 `%APPDATA%/CDown`。

> 注：`bin/yt-dlp.exe` 不入库，打包前请从 https://github.com/yt-dlp/yt-dlp/releases 下载放入 `bin/`；HLS 合并需要 ffmpeg.exe 同样放入 `bin/`。

## 浏览器扩展

`extension/` 目录：Chrome/Edge 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。需 CDown 桌面端运行中（本地 API `127.0.0.1:8780`）。

## 开发者

- **diciky** — 设计与开发
- 反馈/Issue 欢迎提在仓库 Issues 页

## License

[MIT](LICENSE) © 2026 diciky

## 功能

| 功能 | 状态 | 说明 |
|---|---|---|
| 多线程分段下载 | ✅ | HTTP Range 分段并行，最高 64 线程，慢段自动补线程 |
| 断点续传 | ✅ | `.tdmmeta.json` 记录分段偏移，暂停/中断后从断点继续，ETag 变化自动全量重来 |
| 任务队列 | ✅ | 排队/暂停/继续/删除，同时任务数可配，任务列表持久化 |
| HuggingFace 大文件 | ✅ | 手动跟随 302 预解析 CDN 地址 + `X-Linked-Size`，绕过逐段重新签名 |
| m3u8 / HLS | ✅ | 主播放列表自动选最高码率，分片并发下载，ffmpeg 合并 MP4（AES-128 加密流自动转交 yt-dlp） |
| 视频站点 | ✅ | 集成 yt-dlp（已内置 `bin/yt-dlp.exe`），支持 B站 / YouTube / X / TikTok 等 1800+ 站点，自动合并最高画质音视频 |

链接类型自动识别：`.m3u8` → HLS；视频站点域名 → yt-dlp；其余 → HTTP 多线程。

## 启动

```bash
cd tdm-fast
npm install        # 首次
npm start
```

## 打包（安装版 / 便携版）

```bash
npm run dist       # 需要 ffmpeg.exe 放入 bin/ 后打包
```

## 依赖的外部工具

- **yt-dlp**：已下载到 `bin/yt-dlp.exe` ✅
- **ffmpeg**：HLS 合并需要。下载 Windows 版后把 `ffmpeg.exe` 放入 `bin/`（或已在 PATH）
  - 下载地址：https://www.gyan.dev/ffmpeg/builds/ （取 release essentials 解压）

## CLI 模式（调试引擎用）

```bash
node scripts/engine-cli.js <url> --threads 16 --out data/downloads
node scripts/test-server.js   # 本地 Range 测试服务器
```

## 架构

```
src/
  engine/            # 纯 Node 下载引擎（不依赖 Electron，可独立复用）
    downloader.js    #   核心：探测/切段/并行拉取/合并/续传
    m3u8.js          #   HLS 解析与分片下载
    ytdlp.js         #   yt-dlp 集成（元数据探测 + 进度解析）
    queue.js         #   任务队列状态机与持久化
    config.js        #   集中配置
  main/              # Electron 主进程 + preload IPC 桥
  renderer/          # 界面（原生 HTML/CSS/JS，无构建步骤）
data/
  config.json        # 下载目录、线程数、并发数
  tasks.json         # 任务列表持久化
bin/                 # yt-dlp.exe / ffmpeg.exe
```

## 已验证

- 8 线程并行下载 + 字节级一致性校验 PASS
- 40% 暂停 → 断点元数据落盘 → 恢复续传 → 100% 完成 PASS
- 队列状态机（添加→下载→完成）集成测试 PASS
- Electron 启动 PASS（无 GPU 环境已做兼容）
