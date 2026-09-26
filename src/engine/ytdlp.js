// TDM Fast - yt-dlp 集成（视频/流媒体下载，支持 1800+ 站点）
// 策略：yt-dlp -J 探测元数据 -> yt-dlp 直接下载（--concurrent-fragments 并发分片）
//      进度用 --newline 输出解析。暂停 = taskkill 杀进程树（PyInstaller onefile 有子进程，
//      单纯 kill() 只杀引导器，Python 子进程会继续下载）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { UA, fmtBytes } = require('./downloader');

// Windows 中文环境 Python 管道输出默认 GBK，强制 UTF-8 避免标题乱码
function ytdlpEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

const IS_WIN = process.platform === 'win32';

function findBinary() {
  const cfg = require('./config').load();
  if (cfg.ytdlpBin && fs.existsSync(cfg.ytdlpBin)) return cfg.ytdlpBin;
  // 开发环境：项目 bin/；打包后：resources/bin/（electron-builder extraResources）
  const name = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [path.join(__dirname, '..', '..', 'bin', name)];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', name));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null; // 由调用方决定是否尝试 PATH
}

function probe(url) {
  return new Promise((resolve, reject) => {
    const bin = findBinary() || 'yt-dlp';
    const p = spawn(bin, ['-J', '--no-warnings', '--encoding', 'utf-8', url], { windowsHide: true, env: ytdlpEnv() });
    const chunks = [];
    const errChunks = [];
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => errChunks.push(d));
    p.on('error', e => reject(new Error(`yt-dlp 不可用 (${e.message})。请将 yt-dlp.exe 放入项目 bin/ 目录`)));
    p.on('exit', code => {
      const out = Buffer.concat(chunks).toString('utf8');
      const err = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) return reject(new Error(err.trim().slice(0, 300) || `yt-dlp 退出码 ${code}`));
      try {
        const info = JSON.parse(out);
        resolve({
          title: info.title || info.id || 'video',
          extractor: info.extractor_key || info.extractor,
          duration: info.duration,
          isHls: !!(info.formats || []).find(f => (f.protocol || '').includes('m3u8'))
        });
      } catch (e) { reject(new Error('解析 yt-dlp 元数据失败')); }
    });
  });
}

class YtDlpDownloader extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.url = opts.url;
    this.headers = opts.headers || {};
    this.filePath = opts.filePath; // 期望的最终文件路径（yt-dlp 用输出目录 + 模板命名）
    this.status = 'idle';
    this.error = null;
    this.downloaded = 0;
    this.size = -1;
    this.speed = 0;
    this.title = opts.title || null;
    this._proc = null;
    this._paused = false;
    this.logs = [];
  }

  _log(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logs.push(`[${ts}] ${msg}`);
    if (this.logs.length > 100) this.logs.shift();
  }

  snapshot() {
    return {
      kind: 'ytdlp', id: this.id, status: this.status,
      filename: this.title || path.basename(this.filePath), filePath: this.finalPath || this.filePath, url: this.url,
      size: this.size, sizeText: this.size > 0 ? fmtBytes(this.size) : '-',
      downloaded: this.downloaded, speed: this.speed,
      speedText: `${fmtBytes(this.speed)}/s`,
      progress: this._pct || 0, threads: 8, activeThreads: this._proc ? 1 : 0,
      segments: 0, segDetail: [], logs: this.logs || [], error: this.error
    };
  }

  start() {
    if (this.status === 'downloading' || this.status === 'completed') return;
    const cfg = require('./config').load();
    const bin = findBinary() || 'yt-dlp';
    this._paused = false; // 重置暂停标记，允许暂停后重新启动
    this.status = 'downloading';
    this.emit('progress', this.snapshot());
    const args = [
      '--newline', '--no-warnings', '--no-playlist',
      '--encoding', 'utf-8',
      '--concurrent-fragments', '8',
      '--user-agent', UA,
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b',
      '--merge-output-format', 'mp4',
      // 完成后把真实最终路径写入 UTF-8 文件（绕过控制台编码，根治显示名乱码）
      '--print-to-file', 'after_move:filepath', path.join(cfg.downloadDir, `.cdown-path-${this.id}.txt`),
      '-o', path.join(cfg.downloadDir, '%(title).120s.%(ext)s'),
      this.url
    ];
    this._proc = spawn(bin, args, { windowsHide: true, env: ytdlpEnv() });
    this._log(`▶ yt-dlp 启动: ${this.url} (pid ${this._proc.pid}, 8 并发分片)`);
    let errBuf = '';
    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', chunk => {
      for (const line of chunk.split(/\r?\n/)) {
        // [download]  35.2% of  123.45MiB at  12.34MiB/s ETA 00:42
        const m = line.match(/\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+)(KiB|MiB|GiB)(?: at\s+([\d.]+)(KiB|MiB|GiB)\/s)?/);
        if (m) {
          this._pct = Number(m[1]);
          const mult = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[3]];
          this.size = Number(m[2]) * mult;
          this.downloaded = Math.round(this.size * this._pct / 100);
          if (m[4]) this.speed = Number(m[4]) * { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[5]];
          this.emit('progress', this.snapshot());
        }
        const fin = line.match(/\[download\] Destination: (.+)/) || line.match(/\[Merger\] Merging formats into "(.+)"/);
        if (fin) this.title = path.basename(fin[1].replace(/\.f\d+/, ''));
      }
    });
    this._proc.stderr.on('data', d => {
      errBuf += d;
      for (const line of d.toString().split(/\r?\n/).filter(Boolean)) this._log(`[yt-dlp] ${line}`);
    });
    this._proc.on('error', e => {
      this.status = 'error';
      this.error = `yt-dlp 不可用 (${e.message})。请将 yt-dlp.exe 放入项目 bin/ 目录`;
      this.emit('error', this.snapshot());
    });
    this._proc.on('exit', code => {
      this._proc = null;
      if (this._paused) return; // 用户主动暂停，不报错
      if (code === 0) {
        this._pct = 100;
        // 从 print-to-file 读取真实最终路径（yt-dlp 写文件固定 UTF-8，绝对可靠）
        try {
          const pathFile = path.join(require('./config').load().downloadDir, `.cdown-path-${this.id}.txt`);
          const finalPath = fs.readFileSync(pathFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).pop();
          if (finalPath && fs.existsSync(finalPath)) {
            this.title = path.basename(finalPath);
            this.finalPath = finalPath;
            this._log(`✔ 最终文件: ${finalPath}`);
          }
          fs.unlink(pathFile).catch(() => {});
        } catch { /* 无路径文件时保持输出行解析的标题 */ }
        this.status = 'completed';
        this.emit('done', this.snapshot());
      } else {
        this.status = 'error';
        this.error = (errBuf.trim().split('\n').pop() || `yt-dlp 退出码 ${code}`).slice(0, 300);
        this.emit('error', this.snapshot());
      }
    });
  }

  pause() {
    if (this.status !== 'downloading') return;
    this._paused = true;
    this.speed = 0;
    this.status = 'paused';
    const proc = this._proc;
    this._proc = null;
    if (proc && proc.pid) {
      if (IS_WIN) {
        // Windows：yt-dlp.exe 是 PyInstaller onefile（引导器+Python 子进程），
        // proc.kill() 只杀引导器 —— 必须杀整棵进程树
        const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        tk.on('error', () => { try { proc.kill(); } catch { /* 已退出 */ } });
        tk.on('exit', c => this._log(c === 0 ? '⏸ 已终止 yt-dlp 进程树' : `⏸ taskkill 退出码 ${c}（可能已自行退出）`));
      } else {
        // Linux/macOS：onefile 为单进程，直接 SIGTERM
        try { proc.kill('SIGTERM'); this._log('⏸ 已终止 yt-dlp 进程'); } catch { /* 已退出 */ }
      }
    }
    this.emit('progress', this.snapshot());
  }

  async remove() {
    this.pause();
    // 已产生的 .part 文件由 yt-dlp 命名规则管理，删除主文件尽力而为
  }
}

module.exports = { YtDlpDownloader, probe, findBinary };
