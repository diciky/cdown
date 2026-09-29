<div align="center">

<img src="build/icon.png" width="120" alt="CDown" />

# CDown

**极速多线程下载器 · Windows**

[![Version](https://img.shields.io/badge/version-0.2.2-blue)](https://github.com/diciky/CDown/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)](#)
[![Electron](https://img.shields.io/badge/Electron-33-9feaf9)](https://www.electronjs.org/)

把每一次下载压榨到满速：64 线程分段并行 · 断点续传 · 视频/流媒体/大模型文件全支持

**开发者：[diciky](mailto:diciky.zl@gmail.com)**

</div>

---

## ✨ 功能特性

| | 功能 | 说明 |
|---|---|---|
| ⚡ | **多线程分段下载** | HTTP Range 切段并行，最高 64 线程，慢段自动补线程 |
| ⏸ | **断点续传** | 暂停/中断后从断点继续；分段失败自动重试 8 次（递增退避） |
| 🎬 | **视频站点下载** | 集成 yt-dlp：B站 / YouTube / X / TikTok 等 1800+ 站点，自动合并最高画质 |
| 📺 | **HLS 直播流** | m3u8 自动选最高码率，分片并发下载，ffmpeg 合并 MP4 |
| 🤗 | **大模型文件** | HuggingFace 专项优化：预解析 CDN 直链，绕过分段签名限制 |
| 🔍 | **网址嗅探** | 输入任意网址自动发现可下载文件：直链识别 / 页面标签与链接解析 / yt-dlp 全站画质清单 |
| 📋 | **任务队列** | 排队 / 暂停 / 继续 / 删除，实时速度与分段进度可视化 |
| 🌐 | **浏览器扩展** | Chrome/Edge 右键下载 + 全站媒体嗅探（后缀 + URL 关键词 + Content-Type 三重检测） |
| 📎 | **便捷操作** | 剪贴板自动识别链接、任务链接批量复制导出、来源站点徽章 |

> 链接类型自动识别：`.m3u8` → HLS ｜ 视频站点域名 → yt-dlp ｜ 其余 → HTTP 多线程

## 📦 下载安装

前往 [**Releases**](../../releases) 页面下载：

| 文件 | 说明 |
|---|---|
| `CDown Setup x.x.exe` | 安装版（可选安装目录、创建桌面快捷方式） |
| `CDown x.x.exe` | 便携版（免安装，单文件直接运行） |
| `CDown-x.x.dmg` / `.zip` | macOS（Apple Silicon & Intel） |
| `CDown-x.x.AppImage` / `.deb` | Linux |
| `CDown-Extension-vx.x.zip` | 浏览器扩展包 |

## 🤖 自动构建（GitHub Actions）

推送 `v*` 标签即触发云端构建，**无需本地打包**——三平台（Windows / macOS / Linux）矩阵并行，
产物自动发布到 [Releases](../../releases)，并附自动生成的**更新记录**（提交记录 + [`CHANGELOG.md`](CHANGELOG.md) 对应章节）。

> **移动端说明**：CDown 基于 Electron（桌面框架），iOS/Android 无原生版本。安卓用户可通过支持扩展的
> 浏览器（Firefox for Android / Kiwi）安装 Release 里的扩展 zip，获得右键下载与媒体嗅探能力。

## 🚀 从源码运行

```bash
git clone https://github.com/diciky/CDown.git
cd CDown
npm install
npm start
```

### 本地打包（可选，日常发版走 CI）

```bash
npm run dist      # Windows
npx electron-builder --mac    # macOS
npx electron-builder --linux  # Linux
```

> **前置准备**：`bin/yt-dlp.exe` 不随仓库分发，请从
> [yt-dlp Releases](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe)
> 下载放入 `bin/`；如需 HLS 合并，将 [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) 的
> `ffmpeg.exe` 一并放入。
>
> **BitTorrent 支持**：BT 下载由 [aria2](https://github.com/aria2/aria2) 驱动。
> `bin/aria2/` 同样不入库，macOS 上执行 `npm run bundle:aria2` 可自动生成
> （它会递归收集 aria2c 的非系统动态库、改写成相对引用并重新做 ad-hoc 签名，
> 使应用无需用户预装 aria2）。Linux 可用发行版包管理器安装 aria2 后指定 `aria2Bin` 配置项。
> 未找到 aria2c 时 BT 任务会给出明确的安装提示，其它类型下载不受影响。
>
> 打包后数据目录位于 `%APPDATA%/CDown`（macOS 为 `~/Library/Application Support/CDown`）。
> 可用环境变量 `TDM_DATA_DIR` 覆盖，便于做便携版或多实例。

## 🌐 浏览器扩展

1. 启动 CDown 桌面端（本地 API 监听 `127.0.0.1:8780`）
2. Chrome/Edge 打开 `chrome://extensions`
3. 开启右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension` 目录
4. 在网页的视频/链接上右键，选择「用 CDown 下载」

扩展嗅探为**全站通用**三重检测：文件后缀（mp4/m3u8/mp3…）+ URL 关键词（m3u8/mpd/manifest）+ 响应 Content-Type（video/audio/流媒体清单）。弹窗内「▶ 本页视频」可把当前页面直接交给 yt-dlp 解析（1800+ 视频站）。

### 网址嗅探

主程序点击「🔍 嗅探」，输入任意网址：

| 输入类型 | 嗅探方式 |
|---|---|
| 直链文件（mp4/m3u8/zip/pdf…） | 直接识别为下载项 |
| 视频站点（YouTube/B站/X/抖音…） | yt-dlp 解析全部画质/音质，勾选下载或「最佳画质自动合并」 |
| 普通网页 | 解析 `<video>/<audio>/<source>/og:video` + 全文扫描链接（含内嵌 JS、相对路径、GBK 编码页） |
| 无直链的播放器页面 | 自动回退 yt-dlp 通用解析 |

嗅探结果支持全选/多选、线程数设置、一键批量下载。

## 🗂 项目结构

```
cdown/
├── src/
│   ├── engine/            # 纯 Node 下载引擎（不依赖 Electron，可独立复用）
│   │   ├── downloader.js  #   核心：探测 / 切段 / 并行拉取 / 合并 / 续传
│   │   ├── m3u8.js        #   HLS 解析与分片下载
│   │   ├── ytdlp.js       #   yt-dlp 集成（元数据探测 + 格式清单 + 进度解析）
│   │   ├── sniffer.js     #   网址嗅探（页面解析 / 直链识别 / yt-dlp 全站）
│   │   ├── queue.js       #   任务队列状态机与持久化
│   │   └── config.js      #   集中配置
│   ├── main/              # Electron 主进程 + preload IPC 桥 + 本地 API
│   └── renderer/          # 界面（原生 HTML/CSS/JS，零构建）
├── extension/             # Chrome/Edge 浏览器扩展 (MV3)
├── scripts/               # CLI 工具与测试脚本
├── build/                 # 应用图标
└── bin/                   # yt-dlp.exe / ffmpeg.exe（不入库）
```

## 🧪 测试

```bash
# 引擎独立冒烟：多线程下载 + 断点续传
node scripts/engine-cli.js <url> --threads 16 --out data/downloads

# 本地 Range 测试服务器 / 不稳定网络模拟
node scripts/test-server.js
node scripts/flaky-server.js <dropRate%> [failAboveByte]

# 不稳定网络全套测试
node scripts/engine-flaky-test.js
```

## 🧑‍💻 开发者

**diciky** · [diciky.zl@gmail.com](mailto:diciky.zl@gmail.com)

欢迎通过 Issues 反馈问题与建议。

## 📄 License

[MIT](LICENSE) © 2026 diciky
