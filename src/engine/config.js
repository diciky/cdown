// CDown - 配置模块（集中管理，持久化到 data/config.json）
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TDM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 默认下载目录：交给系统给用户的标准下载目录（macOS → ~/Downloads，Windows → 用户下载文件夹），
// 而不是埋在 Application Support 里，用户下载完找不到文件。
// 在非 Electron 环境（CLI 脚本 / 单元测试）下拿不到 app，回退到数据目录。
function defaultDownloadDir() {
  try {
    const { app } = require('electron');
    const dir = app?.getPath?.('downloads');
    if (dir) return dir;
  } catch { /* 非 Electron 环境 */ }
  return path.join(DATA_DIR, 'downloads');
}

const DEFAULTS = {
  downloadDir: defaultDownloadDir(),
  maxThreads: 32,        // 单任务最大线程数 (1-64)
  maxConcurrent: 3,      // 同时下载的任务数
  segmentMinSize: 1024 * 1024, // 小于 1MB 的文件不分段
  ytdlpBin: '',          // yt-dlp 可执行文件路径，空则自动探测（macOS/Linux 无 .exe 后缀）
  ffmpegBin: '',         // ffmpeg 可执行文件路径，空则自动探测
  aria2Bin: '',          // aria2c 可执行文件路径（BT 下载），空则自动探测
  btSeedTime: 0,         // BT 下载完成后继续做种的分钟数，0 = 不做种
  btDht: true,           // 是否启用 DHT / PEX（关闭后只能依赖 tracker 与种子自带 peer）
  btTrackers: '',        // 额外 tracker 列表（逗号分隔），留空则只用种子自带 tracker
  hfThreads: 16,         // HuggingFace 大文件默认线程数
  douyinQuality: 'best', // 抖音默认清晰度：best | 1080 | 720 | 540 | lowest
  clipboardMonitor: true, // 自动识别剪贴板链接并询问添加
  serverPort: 8780       // 本地 API 端口（浏览器扩展通信用，仅监听 127.0.0.1）
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const cfg = { ...load(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  cache = cfg;
  return cfg;
}

module.exports = { load, save, DATA_DIR, DEFAULTS };
