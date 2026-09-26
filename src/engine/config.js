// TDM Fast - 配置模块（集中管理，持久化到 data/config.json）
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TDM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  downloadDir: path.join(DATA_DIR, 'downloads'),
  maxThreads: 32,        // 单任务最大线程数 (1-64)
  maxConcurrent: 3,      // 同时下载的任务数
  segmentMinSize: 1024 * 1024, // 小于 1MB 的文件不分段
  ytdlpBin: '',          // yt-dlp.exe 路径，空则自动探测
  ffmpegBin: '',         // ffmpeg.exe 路径，空则自动探测
  hfThreads: 16,         // HuggingFace 大文件默认线程数
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
