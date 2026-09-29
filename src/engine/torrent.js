// CDown - BitTorrent 下载器（基于 aria2c）
//
// 设计取舍：BT 的 peer 交换、DHT、分片校验、磁力链元数据获取是巨量工作，
// 自己实现既不现实也不安全。aria2c 是成熟实现，且能被当作子进程驱动，
// 所以这里只做「参数拼装 + 进度解析 + 生命周期管理」。
//
// 与 HttpDownloader / HlsDownloader 保持同一套接口（start/pause/remove/snapshot + 事件），
// 这样 queue.js 可以不加区分地调度三种任务。
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'aria2c.exe' : 'aria2c';

// ---------- 二进制探测 ----------
// 顺序：配置项 → 随包分发的 bin/aria2/ → 项目 bin/ → PATH → 各平台常见安装位置
function findAria2(cfg = {}) {
  const cands = [];
  if (cfg.aria2Bin) cands.push(cfg.aria2Bin);
  const root = path.join(__dirname, '..', '..');
  // 随包分发（electron-builder extraResources 会放到 resources/ 下）
  cands.push(path.join(root, 'bin', 'aria2', BIN_NAME));
  cands.push(path.join(root, 'bin', BIN_NAME));
  if (process.resourcesPath) {
    cands.push(path.join(process.resourcesPath, 'bin', 'aria2', BIN_NAME));
    cands.push(path.join(process.resourcesPath, 'bin', BIN_NAME));
  }
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (p) cands.push(path.join(p, BIN_NAME));
  }
  if (IS_WIN) {
    cands.push('C:\\Program Files\\aria2\\aria2c.exe');
  } else {
    cands.push('/opt/homebrew/bin/aria2c', '/usr/local/bin/aria2c', '/usr/bin/aria2c');
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
        if (!IS_WIN) fs.accessSync(c, fs.constants.X_OK);
        return c;
      }
    } catch { /* 继续找 */ }
  }
  return null;
}

function missingHint() {
  return IS_WIN
    ? '未找到 aria2c，BitTorrent 下载需要它。可从 https://github.com/aria2/aria2/releases 下载 aria2-*-win-64bit.zip，把 aria2c.exe 放到项目 bin/ 目录'
    : '未找到 aria2c，BitTorrent 下载需要它。macOS 可执行 brew install aria2，或把 aria2c 放到项目 bin/aria2/ 目录';
}

// ---------- 解析 ----------
// aria2 的容量单位是二进制后缀：0B / 512KiB / 4.0MiB / 1.2GiB
const UNIT = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, KB: 1000, MB: 1e6, GB: 1e9 };

function parseSize(s) {
  if (!s) return -1;
  const m = String(s).trim().match(/^([\d.]+)\s*([A-Za-z]*)$/);
  if (!m) return -1;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return -1;
  const unit = (m[2] || 'B').toUpperCase();
  return Math.round(n * (UNIT[unit] || 1));
}

// 进度行（已实测确认的格式，来自 scripts/bt-local-test.js 抓取的真实输出）：
//   [#<gid> <done>/<total>(<pct>%) CN:<connections> SD:<seeders> DL:<speed>]
//   [#<gid> SEED(<ratio>) CN:<n> SD:<n>]              ← 已完成并在做种
// 注意：这些行只在设置了 --summary-interval 时才会输出（默认 60s，太慢）。
const RE_PROGRESS = /\[#([0-9a-f]{6})\s+([\d.]+[A-Za-z]*)\/([\d.]+[A-Za-z]*)\((\d+)%\)\s+CN:(\d+)\s+SD:(\d+)\s+DL:([^\]]*)\]/;
const RE_SEED = /\[#([0-9a-f]{6})\s+SEED\(([\d.]+)\)\s+CN:(\d+)\s+SD:(\d+)\]/;

function parseProgressLine(line) {
  const p = RE_PROGRESS.exec(line);
  if (p) {
    return {
      gid: p[1], size: parseSize(p[3]), downloaded: parseSize(p[2]),
      progress: Number(p[4]), connections: Number(p[5]), seeders: Number(p[6]),
      speedText: p[7].trim(), seeding: false
    };
  }
  const s = RE_SEED.exec(line);
  if (s) {
    return { gid: s[1], progress: 100, connections: Number(s[3]), seeders: Number(s[4]), seeding: true, speedText: '0B' };
  }
  return null;
}

// ---------- 下载器 ----------
class TorrentDownloader extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = opts.id;
    this.url = opts.url;                       // magnet: 或 http(s)://.../x.torrent
    this.filePath = opts.filePath;             // 期望的落盘路径（BT 可能产出多文件，仅作提示）
    this.dir = opts.dir || (opts.filePath ? path.dirname(opts.filePath) : process.cwd());
    this.status = 'idle';
    this.error = null;
    this.size = -1;
    this.downloaded = 0;
    this.speed = 0;
    this.speedText = '-';
    this.progress = 0;
    this.connections = 0;
    this.seeders = 0;
    this.seeding = false;
    this.logs = [];
    this.proc = null;
    this._stopped = true;
    this._buf = '';
    this._doneEmitted = false;

    // 可选参数
    this.seedTime = Number.isFinite(opts.seedTime) ? opts.seedTime : 0; // 分钟，0 = 下完不做种
    this.trackers = opts.trackers || '';        // 额外 tracker，逗号分隔
    this.maxPeers = opts.maxPeers || 0;         // 0 = aria2 默认(55)
    this.dht = opts.dht !== false;
    this.aria2Bin = opts.aria2Bin || null;
  }

  _log(line) {
    const s = String(line).trim();
    if (!s) return;
    this.logs.push(s);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
  }

  snapshot() {
    return {
      kind: 'bt',
      id: this.id,
      status: this.status,
      filename: this.filePath ? path.basename(this.filePath) : (this.url || '').slice(0, 60),
      filePath: this.filePath,
      url: this.url,
      size: this.size,
      sizeText: this.size > 0 ? fmtBytes(this.size) : '-',
      downloaded: this.downloaded,
      speed: this.speed,
      speedText: this.speedText,
      progress: Number(this.progress.toFixed(1)),
      threads: this.connections,
      activeThreads: this.connections,
      segments: 0,
      segDetail: [],
      // BT 专属信息，界面可选用
      seeders: this.seeders,
      connections: this.connections,
      seeding: this.seeding,
      logs: this.logs,
      error: this.error
    };
  }

  _emitProgress() { this.emit('progress', this.snapshot()); }

  _args() {
    const a = [
      '--dir', this.dir,
      // 进度行：默认 60s 才输出一次，必须缩短
      '--summary-interval=1',
      '--console-log-level=notice',
      '--show-console-readout=false',
      // 端口用区间，aria2 会挑第一个空闲端口；写死端口一旦被占用就整个任务失败
      '--listen-port=6881-6999',
      this.dht ? '--enable-dht=true' : '--enable-dht=false',
      this.dht ? '--dht-listen-port=6881-6999' : null,
      // 局域网 peer 发现关掉：行为不可预期，且企业网络里常被安全软件拦
      '--bt-enable-lpd=false',
      '--enable-peer-exchange=true',
      // 不做种时把做种比压到 0，下完立刻结束
      this.seedTime > 0 ? `--seed-time=${this.seedTime}` : '--seed-time=0',
      this.seedTime > 0 ? '--seed-ratio=0' : null,
      // 磁力链把元数据存下来，便于断点续传与任务列表展示
      '--bt-save-metadata=true',
      '--bt-metadata-only=false',
      // 断点续传：保留 .aria2 控制文件
      '--continue=true',
      // 不自动改名，保证落盘路径可预测（界面要按这个路径定位文件）
      '--auto-file-renaming=false',
      // 减少对目标站点的冲击
      '--max-tries=5',
      '--retry-wait=3',
      '--connect-timeout=15',
      '--timeout=60'
    ].filter(Boolean);
    if (this.trackers) a.push('--bt-tracker=' + this.trackers);
    if (this.maxPeers > 0) a.push(`--bt-max-peers=${this.maxPeers}`);
    return a;
  }

  async start() {
    if (this.status === 'downloading' || this.status === 'completed') return;
    const bin = this.aria2Bin || findAria2(require('./config').load());
    if (!bin) {
      this.status = 'error';
      this.error = missingHint();
      this.emit('error', this.snapshot());
      return;
    }
    this._stopped = false;
    this._doneEmitted = false;
    this.error = null;
    this.status = 'downloading';
    this._log(`启动 aria2c: ${bin}`);
    this._emitProgress();

    await fsp.mkdir(this.dir, { recursive: true }).catch(() => {});

    // 参数顺序要紧：选项在前，URI 在最后。aria2 对未知选项是「立即退出」而非警告，
    // 所以任何拼错的选项都会表现为「进程瞬间消失且没有任何进度」。
    const args = [...this._args(), this.url];
    this.proc = spawn(bin, args, {
      windowsHide: true,
      // POSIX 下独立进程组，暂停时可以连同子进程一起收掉
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.on('data', d => this._onData(d));
    this.proc.on('error', e => {
      this.status = 'error';
      this.error = e.code === 'ENOENT' ? missingHint() : e.message;
      this.emit('error', this.snapshot());
    });
    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
  }

  _onData(chunk) {
    // aria2 用 \r 刷新同一行，必须按 \r 和 \n 一起切分，否则进度行会粘成一坨
    this._buf += chunk.toString('utf8');
    const parts = this._buf.split(/[\r\n]+/);
    this._buf = parts.pop() || '';
    for (const line of parts) this._onLine(line);
    if (this._buf.length > 8192) this._buf = ''; // 防止无换行的输出把缓冲撑爆
  }

  _onLine(raw) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim(); // 去掉 ANSI 颜色
    if (!line) return;

    const p = parseProgressLine(line);
    if (p) {
      if (p.size > 0) this.size = p.size;
      if (typeof p.downloaded === 'number' && p.downloaded >= 0) this.downloaded = p.downloaded;
      if (typeof p.progress === 'number') this.progress = Math.min(100, p.progress);
      this.connections = p.connections;
      this.seeders = p.seeders;
      this.speedText = p.speedText;
      this.speed = parseSize(p.speedText);
      this.seeding = !!p.seeding;
      if (this.seeding) { this.progress = 100; this.speed = 0; }
      this._emitProgress();
      return;
    }

    // 只在真正有用的行上留日志，避免把界面日志区刷爆
    if (/\[NOTICE\]|\[ERROR\]|\[WARN\]|Exception|Download complete|download completed|Verification|SEED|Saving|FILE:/.test(line)) {
      this._log(line);
    }

    if (/Download complete|download completed/i.test(line)) {
      this.status = 'completed';
      this.progress = 100;
      this.speed = 0;
      this.speedText = '0B';
      this._emitProgress();
    }
    // aria2 在多文件种子下会打印每个文件的落盘路径，取第一个作为代表
    const fm = /^FILE:\s*(.+)$/.exec(line);
    if (fm && !this._realPath) this._realPath = fm[1].trim();
    const dc = /Download complete:\s*(.+)$/.exec(line);
    if (dc) this._realPath = dc[1].trim();
  }

  async _onExit(code, signal) {
    if (this._doneEmitted) return;
    this._doneEmitted = true;
    this.proc = null;
    if (this._stopped) {
      this.status = 'paused';
      this._emitProgress();
      return;
    }
    if (code === 0) {
      this.status = 'completed';
      this.progress = 100;
      // 用 aria2 报告的真实路径纠正 filePath（多文件种子/磁力链下名字可能与预期不同）
      if (this._realPath) this.filePath = this._realPath;
      this.emit('done', { ...this.snapshot(), filename: this.filePath ? path.basename(this.filePath) : undefined, filePath: this.filePath });
      return;
    }
    this.status = 'error';
    this.error = this._lastError() || `aria2c 异常退出（code=${code}${signal ? ', signal=' + signal : ''}）`;
    this.emit('error', this.snapshot());
  }

  // 从日志里挑一条最能说明问题的错误
  _lastError() {
    const hits = this.logs.filter(l => /\[ERROR\]|Exception|errorCode=|unrecognized option/i.test(l));
    if (!hits.length) return null;
    const last = hits[hits.length - 1].replace(/^\[[^\]]*\]\s*/, '').replace(/^CUID#\d+\s*-\s*/, '');
    if (/unrecognized option/i.test(last)) return `${last}（aria2 选项不被该版本支持）`;
    return last.slice(0, 300);
  }

  pause() {
    this._stopped = true;
    this.status = 'paused';
    if (!this.proc) { this._emitProgress(); return; }
    // 必须给 aria2 机会保存 .aria2 控制文件，SIGKILL 会让断点信息丢失
    try {
      if (IS_WIN) this.proc.kill();
      else process.kill(-this.proc.pid, 'SIGTERM');
    } catch {
      try { this.proc.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
    this._emitProgress();
  }

  async remove() {
    this._stopped = true;
    if (this.proc) {
      try {
        if (IS_WIN) this.proc.kill();
        else process.kill(-this.proc.pid, 'SIGKILL');
      } catch { /* 已退出 */ }
      this.proc = null;
    }
    // 清掉 aria2 的断点控制文件与磁力链元数据，避免残留影响下次下载
    await fsp.unlink(this.filePath + '.aria2').catch(() => {});
    if (this.filePath) {
      const stem = this.filePath.replace(/\.[^.]+$/, '');
      await fsp.unlink(stem + '.aria2').catch(() => {});
      await fsp.unlink(stem + '.torrent').catch(() => {});
    }
    await fsp.unlink(this.filePath).catch(() => {});
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// 从磁力链 / 种子 URL 推导一个展示名。
// 注意：BT 的真实文件名由种子元数据决定，只有连上 peer 拿到 metadata 之后才知道，
// 所以这里给出的只是一个「先显示着」的占位名，任务完成后会被 aria2 报告的真实路径纠正。
function guessTorrentName(url) {
  const u = String(url || '');
  if (/^magnet:/i.test(u)) {
    const qs = u.slice(u.indexOf('?') + 1);
    try {
      const dn = new URLSearchParams(qs).get('dn');
      if (dn && dn.trim()) return dn.trim().replace(/[\\/:*?"<>|]/g, '_');
    } catch { /* 继续 */ }
    const m = /xt=urn:btih:([0-9a-zA-Z]{32,40})/i.exec(u);
    return m ? `torrent_${m[1].slice(0, 8)}` : `torrent_${Date.now()}`;
  }
  try {
    const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last.replace(/\.torrent$/i, '') || `torrent_${Date.now()}`;
  } catch { /* 继续 */ }
  return `torrent_${Date.now()}`;
}

module.exports = { TorrentDownloader, findAria2, missingHint, parseProgressLine, parseSize, guessTorrentName, BIN_NAME };
