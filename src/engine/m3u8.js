// TDM Fast - HLS (m3u8) 分片流下载器
// 流程：解析 m3u8 (主播放列表选最高码率) -> 并发下载 ts/fMP4 分片 -> ffmpeg 合并 MP4
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { UA, fmtBytes } = require('./downloader');

function findFfmpeg(cfg) {
  if (cfg.ffmpegBin && fs.existsSync(cfg.ffmpegBin)) return cfg.ffmpegBin;
  const candidates = [path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe')];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'ffmpeg'; // 依赖 PATH
}

function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    // 主播放列表：选带宽最高的变体
    let best = null, bestBw = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;
        if (uri && bw >= bestBw) { bestBw = bw; best = uri; }
      }
    }
    if (!best) throw new Error('主播放列表中未找到可用的流');
    return { isMaster: true, playlistUrl: new URL(best, baseUrl).href };
  }
  const segments = lines.filter(l => !l.startsWith('#')).map(l => new URL(l, baseUrl).href);
  const encrypted = lines.find(l => l.startsWith('#EXT-X-KEY')) || null;
  const initSeg = (text.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || null;
  return { isMaster: false, segments, encrypted, initSeg: initSeg ? new URL(initSeg, baseUrl).href : null };
}

class HlsDownloader extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.url = opts.url;
    this.headers = { 'user-agent': UA, ...(opts.headers || {}) };
    this.filePath = opts.filePath; // 最终 .mp4
    this.workDir = opts.filePath + '.hls.tmp';
    this.threads = Math.max(2, Math.min(32, opts.threads || 16));
    this.status = 'idle';
    this.error = null;
    this.segments = [];
    this.doneSet = new Set();
    this.downloaded = 0;
    this.size = -1; // HLS 无法预知总大小
    this.speed = 0;
    this._speedWindow = [];
    this._stopped = true;
    this._metaPath = opts.filePath + '.hlsmeta.json';
    this.logs = [];
  }

  snapshot() {
    return {
      kind: 'hls', id: this.id, status: this.status,
      filename: path.basename(this.filePath), filePath: this.filePath, url: this.url,
      size: this.size, sizeText: '-', downloaded: this.downloaded,
      speed: this.speed, speedText: `${fmtBytes(this.speed)}/s`,
      progress: this.segments.length ? Number(((this.doneSet.size / this.segments.length) * 100).toFixed(1)) : 0,
      threads: this.threads, activeThreads: this._active, segments: this.segments.length,
      segDetail: [], logs: this.logs || [], error: this.error
    };
  }

  _emitProgress() {
    const now = Date.now();
    this._speedWindow.push({ t: now, b: this.downloaded });
    while (this._speedWindow.length > 2 && now - this._speedWindow[0].t > 2000) this._speedWindow.shift();
    const first = this._speedWindow[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.3) this.speed = Math.max(0, (this.downloaded - first.b) / dt);
    this.emit('progress', this.snapshot());
  }

  async start() {
    if (this.status === 'downloading' || this.status === 'completed') return;
    this.status = 'probing'; this._emitProgress();
    try {
      // 恢复
      try {
        const meta = JSON.parse(await fsp.readFile(this._metaPath, 'utf8'));
        if (meta.url === this.url) {
          this.segments = meta.segments; this.doneSet = new Set(meta.done);
          this.downloaded = meta.downloaded;
        }
      } catch { /* 全新开始 */ }

      if (this.segments.length === 0) {
        let playlistUrl = this.url;
        for (let hop = 0; hop < 3; hop++) {
          const resp = await fetch(playlistUrl, { headers: this.headers });
          if (!resp.ok) throw new Error(`m3u8 请求失败: HTTP ${resp.status}`);
          const text = await resp.text();
          const parsed = parseM3u8(text, playlistUrl);
          if (parsed.isMaster) { playlistUrl = parsed.playlistUrl; continue; }
          if (parsed.encrypted && parsed.encrypted.includes('METHOD=AES-128')) {
            // 加密流：交给 yt-dlp 处理更稳妥（若可用），否则报错提示
            const ytdlp = require('./ytdlp');
            if (ytdlp.findBinary()) return this._delegateToYtDlp();
            throw new Error('该 HLS 流已加密 (AES-128)，请安装 yt-dlp 或 ffmpeg 后重试');
          }
          this.segments = parsed.segments;
          break;
        }
        if (this.segments.length === 0) throw new Error('未解析到任何分片');
      }
      await fsp.mkdir(this.workDir, { recursive: true });
      this.status = 'downloading';
      this._stopped = false;
      this._active = 0;
      this._runWorkers();
    } catch (e) {
      this.status = 'error'; this.error = e.message;
      this.emit('error', this.snapshot());
    }
  }

  _delegateToYtDlp() {
    const ytdlp = require('./ytdlp');
    const d = new ytdlp.YtDlpDownloader({ id: this.id, url: this.url, filePath: this.filePath, headers: this.headers });
    d.on('progress', s => this.emit('progress', { ...this.snapshot(), ...s, kind: 'hls' }));
    d.on('done', s => { this.status = 'completed'; this.emit('done', this.snapshot()); });
    d.on('error', s => { this.status = 'error'; this.error = s.error; this.emit('error', this.snapshot()); });
    d.start();
  }

  async _runWorkers() {
    while (this._stopped === false) {
      const pending = this.segments.filter(u => !this.doneSet.has(u));
      const running = this._active;
      const idle = this.threads - running;
      if (pending.length === 0 && running === 0) { this._merge(); return; }
      if (idle <= 0) { await new Promise(r => setTimeout(r, 150)); continue; }
      const batch = pending.slice(0, idle);
      batch.forEach(u => this._fetchSegment(u));
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async _fetchSegment(url) {
    this._active = (this._active || 0) + 1;
    try {
      const idx = this.segments.indexOf(url);
      const resp = await fetch(url, { headers: this.headers });
      if (!resp.ok) throw new Error(`分片请求失败 HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const name = String(idx).padStart(6, '0') + '.seg';
      await fsp.writeFile(path.join(this.workDir, name), buf);
      this.doneSet.add(url);
      this.downloaded += buf.length;
      this._emitProgress();
      this._persistDebounced();
    } catch (e) {
      if (!this._stopped) {
        // 单分片失败重试 2 次后放弃整个任务
        this._segRetry = this._segRetry || new Map();
        const n = (this._segRetry.get(url) || 0) + 1;
        this._segRetry.set(url, n);
        if (n >= 3) { this.status = 'error'; this.error = `分片下载失败: ${e.message}`; this.emit('error', this.snapshot()); }
      }
    } finally {
      this._active = Math.max(0, this._active - 1);
    }
  }

  _persistDebounced() {
    if (this._persistT) return;
    this._persistT = setTimeout(async () => {
      this._persistT = null;
      await fsp.writeFile(this._metaPath, JSON.stringify({
        url: this.url, segments: this.segments, done: [...this.doneSet], downloaded: this.downloaded
      })).catch(() => {});
    }, 2000);
  }

  async _merge() {
    try {
      const ffmpeg = findFfmpeg(require('./config').load());
      const listFile = path.join(this.workDir, 'list.txt');
      const lines = this.segments.map((_, i) => `file '${String(i).padStart(6, '0')}.seg'`);
      await fsp.writeFile(listFile, lines.join('\n'));
      this.status = 'merging'; this._emitProgress();
      await new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', this.filePath], { windowsHide: true });
        p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`)));
        p.on('error', reject);
      });
      await fsp.rm(this.workDir, { recursive: true, force: true });
      await fsp.unlink(this._metaPath).catch(() => {});
      this.status = 'completed'; this.speed = 0;
      this.emit('done', this.snapshot());
    } catch (e) {
      this.status = 'error'; this.error = `合并失败: ${e.message}`;
      this.emit('error', this.snapshot());
    }
  }

  pause() {
    this._stopped = true;
    this.status = 'paused'; this.speed = 0;
    this._persistDebounced();
    this.emit('progress', this.snapshot());
  }

  async remove() {
    this.pause();
    await fsp.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(this._metaPath).catch(() => {});
    await fsp.unlink(this.filePath).catch(() => {});
  }
}

module.exports = { HlsDownloader, parseM3u8 };
