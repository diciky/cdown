// TDM Fast - 任务存储与调度队列
// 状态机: pending -> downloading -> (paused <-> downloading) -> completed | error
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { HttpDownloader, resolveTarget } = require('./downloader');
const { HlsDownloader } = require('./m3u8');
const { TorrentDownloader, guessTorrentName } = require('./torrent');
const ytdlp = require('./ytdlp');

const TASKS_FILE = path.join(require('./config').DATA_DIR, 'tasks.json');

// 下载来源识别：主机名 → 站点名
const SOURCE_MAP = [
  [/x\.com$|twitter\.com$/i, 'X'],
  [/youtube\.com$|youtu\.be$/i, 'YouTube'],
  [/bilibili\.com$|b23\.tv$/i, '哔哩哔哩'],
  [/tiktok\.com$/i, 'TikTok'],
  [/douyin\.com$/i, '抖音'],
  [/huggingface\.co$/i, 'HuggingFace'],
  [/hf-mirror\.com$/i, 'HF-Mirror'],
  [/modelscope\.cn$/i, '魔搭'],
  [/reddit\.com$/i, 'Reddit'],
  [/weibo\.com$|weibo\.cn$/i, '微博'],
  [/ixigua\.com$/i, '西瓜视频'],
  [/v\.qq\.com$/i, '腾讯视频'],
  [/iqiyi\.com$/i, '爱奇艺'],
  [/youku\.com$/i, '优酷'],
  [/instagram\.com$/i, 'Instagram'],
  [/facebook\.com$|fb\.watch$/i, 'Facebook'],
  [/github\.com$/i, 'GitHub'],
  [/pixiv\.net$/i, 'Pixiv'],
  [/twitch\.tv$/i, 'Twitch'],
  [/vimeo\.com$/i, 'Vimeo'],
];

function getSource(url) {
  try {
    const u = new URL(url);
    for (const [re, name] of SOURCE_MAP) if (re.test(u.hostname)) return name;
    const h = u.hostname.replace(/^www\./, '');
    return h.length > 26 ? h.slice(0, 26) + '…' : (h || '未知来源');
  } catch { return '未知来源'; }
}

function classify(url) {
  const u = String(url || '').trim().toLowerCase();
  // BitTorrent：磁力链 / .torrent 种子文件
  if (u.startsWith('magnet:?')) return 'bt';
  if (/\.torrent(?:[?#]|$)/.test(u)) return 'bt';
  // HLS：路径以 .m3u8 结尾，或由查询参数指定了 m3u8 格式。
  // 旧实现只判断 includes('m3u8?')，因此 `?format=m3u8&token=…` 这类
  // 查询参数形式的播放列表会被误判成普通 HTTP 直链，从而下载到一份文本清单。
  if (/\.m3u8(?:[?#]|$)/.test(u) || /[?&](?:format|fmt|type|ext)=m3u8\b/.test(u)) return 'hls';
  const VIDEO_SITES = ['youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'x.com', 'twitter.com', 'tiktok.com', 'douyin.com', 'reddit.com', 'ixigua.com', 'youku.com', 'v.qq.com', 'iqiyi.com'];
  if (VIDEO_SITES.some(s => u.includes(s))) return 'ytdlp';
  return 'http';
}

// 文件名净化。
// 注意必须按「字节」截断而不是按「字符」：APFS/HFS+/NTFS 的上限是 255 字节，
// 中文文件名一个字符占 3 字节，按 180 字符截断会得到 540 字节 —— 直接 ENAMETOOLONG。
function safeName(name, maxBytes = 200) {
  const cleaned = (name || 'download').replace(/[\\/:*?"<>|]/g, '_');
  if (Buffer.byteLength(cleaned, 'utf8') <= maxBytes) return cleaned;
  // 保留扩展名，正文按字节裁剪（避免把多字节字符截断成乱码）
  const m = cleaned.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext = m ? m[1] : '';
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const budget = maxBytes - Buffer.byteLength(ext, 'utf8');
  let out = '', used = 0;
  for (const ch of stem) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > budget) break;
    out += ch; used += b;
  }
  return out + ext;
}

// 从 URL 推导文件名。
// type 会影响扩展名：m3u8 是「播放列表」而不是最终产物，合并后得到的是 MP4，
// 若沿用 .m3u8 就会得到一个装着 MP4 数据的 .m3u8 文件，且任务记录的路径
// 与磁盘上的真实文件永久对不上（「打开所在文件夹」因此失效）。
function filenameFromUrl(url, type) {
  const isHls = type === 'hls';
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    if (last) {
      const name = isHls || /\.m3u8$/i.test(last) ? last.replace(/\.m3u8$/i, '.mp4') : last;
      if (/\.[a-z0-9]{1,8}$/i.test(name)) return safeName(name);
    }
  } catch { /* ignore */ }
  return isHls ? `video_${Date.now()}.mp4` : `download_${Date.now()}.bin`;
}

class Queue extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // id -> task record {id,url,type,status,...,worker}
    this._idCounter = 1;
    this._loaded = false;
  }

  async _persist() {
    const arr = [...this.tasks.values()].map(t => ({
      id: t.id, url: t.url, type: t.type, status: t.status,
      filePath: t.filePath, filename: t.filename, threads: t.threads,
      size: t.size, downloaded: t.downloaded, error: t.error, createdAt: t.createdAt, format: t.format || null
    }));
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
    await fsp.writeFile(TASKS_FILE, JSON.stringify(arr, null, 2)).catch(() => {});
  }

  snapshotAll() {
    return [...this.tasks.values()].reverse().map(t => {
      const s = t.worker ? t.worker.snapshot() : {
        kind: t.type, id: t.id, status: t.status, filename: t.filename, filePath: t.filePath,
        url: t.url, size: t.size || -1, sizeText: '-', downloaded: t.downloaded || 0,
        speed: 0, speedText: '-', progress: t.size > 0 ? Number(((t.downloaded / t.size) * 100).toFixed(1)) : 0,
        threads: t.threads, activeThreads: 0, segments: 0, segDetail: [], logs: [], error: t.error
      };
      return { ...s, source: t.source || getSource(t.url) };
    });
  }

  _bump(t) { this.emit('progress', t.worker ? t.worker.snapshot() : null); }

  async add(url, opts = {}) {
    const cfg = require('./config').load();
    const type = opts.type || classify(url);
    const id = this._idCounter++;
    let filename = opts.filename;
    let threads = opts.threads || (type === 'hls' ? 16 : url.includes('huggingface') || url.includes('hf-mirror') ? cfg.hfThreads : cfg.maxThreads);
    const source = getSource(url);

    // BT：真实文件名要等拿到种子元数据才知道，先给个占位名
    if (type === 'bt' && !filename) filename = guessTorrentName(url);

    // yt-dlp 任务先探测标题
    if (type === 'ytdlp') {
      try { const info = await ytdlp.probe(url); filename = filename || safeName(info.title) + '.' + (opts.formatExt || 'mp4'); }
      catch (e) {
        this.emit('add-failed', { id, error: e.message });
        throw e;
      }
    }
    filename = filename || filenameFromUrl(url, type);
    const filePath = path.join(opts.dir || cfg.downloadDir, filename);

    const task = { id, url, type, source, status: 'pending', filePath, filename, threads, size: -1, downloaded: 0, error: null, createdAt: Date.now(), worker: null, format: opts.format || null };
    this.tasks.set(id, task);
    await this._persist();
    this.emit('progress');
    this._maybeStart();
    return id;
  }

  _maybeStart() {
    const cfg = require('./config').load();
    const running = [...this.tasks.values()].filter(t => t.status === 'downloading' || t.status === 'probing' || t.status === 'merging').length;
    const slots = Math.max(0, cfg.maxConcurrent - running);
    const pending = [...this.tasks.values()].filter(t => t.status === 'pending').slice(0, slots);
    pending.forEach(t => this._startTask(t));
  }

  async _startTask(task) {
    // 同步置位防止重复派发：_maybeStart 可能在探测阶段被再次触发
    // （如其他任务完成/暂停时），否则会为同一任务创建两个下载器写同一文件
    if (task._starting || task.worker) return;
    task._starting = true;
    task.status = 'downloading';
    const cfg = require('./config').load();
    try {
      let worker;
      if (task.type === 'bt') {
        // BT 由 aria2c 全权负责，落盘位置由 --dir 决定（真实文件名由种子元数据决定）
        worker = new TorrentDownloader({
          id: task.id,
          url: task.url,
          filePath: task.filePath,
          dir: path.dirname(task.filePath),
          seedTime: Number(cfg.btSeedTime) || 0,
          trackers: cfg.btTrackers || '',
          dht: cfg.btDht !== false,
          aria2Bin: cfg.aria2Bin || ''
        });
      } else if (task.type === 'hls') {
        worker = new HlsDownloader({ id: task.id, url: task.url, filePath: task.filePath, threads: task.threads });
      } else if (task.type === 'ytdlp') {
        worker = new ytdlp.YtDlpDownloader({ id: task.id, url: task.url, filePath: task.filePath, title: task.filename, format: task.format });
      } else {
        const pre = await resolveTarget(task.url, {});
        // HuggingFace：resolveTarget 已命中最终 CDN URL，直接以线程数开跑
        worker = new HttpDownloader({
          id: task.id, url: task.url, finalUrl: pre.url, headers: {},
          filePath: task.filePath, threads: task.threads,
          size: pre.size, etag: pre.etag, lastModified: pre.lastModified,
          // 把探测到的 Range 支持情况带下去，避免 HttpDownloader 再探测一次，
          // 同时保证不支持 Range 的服务器不会被错误分段
          acceptRanges: pre.acceptRanges
        });
        task.size = pre.size;
      }
      task.worker = worker;
      // 终态（error/completed）后忽略进度事件的状态回写，防止状态跳回 downloading
      worker.on('progress', s => {
        if (task.status !== 'error' && task.status !== 'completed') {
          task.status = s.status; task.downloaded = s.downloaded; task.size = s.size;
        }
        this.emit('progress', s);
      });
      worker.on('done', async s => {
        task.status = 'completed'; task.downloaded = s.downloaded; task.size = s.size;
        // 用 yt-dlp 回报的真实最终文件纠正显示名与路径（自愈历史乱码名）
        if (s.filename) { task.filename = s.filename; }
        if (s.filePath) { task.filePath = s.filePath; }
        this.emit('done', s); await this._persist(); this._maybeStart();
      });
      worker.on('error', async s => {
        task.status = 'error'; task.error = s.error;
        this.emit('error', s); await this._persist(); this._maybeStart();
      });
      task.status = 'downloading';
      await worker.start();
      await this._persist();
    } catch (e) {
      task.status = 'error'; task.error = e.message;
      this.emit('error', { id: task.id, error: e.message, status: 'error', kind: task.type, filename: task.filename, progress: 0, speedText: '-', sizeText: '-', activeThreads: 0, segments: 0, url: task.url, filePath: task.filePath });
      await this._persist(); this._maybeStart();
    } finally {
      task._starting = false;
    }
  }

  // 重新下载：清除所有进度产物，从头开始（原文件保留至新下载完成时覆盖）
  async restart(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.worker) { try { await t.worker.remove(); } catch { /* 忽略 */ } t.worker = null; }
    // 视频任务重新探测标题（同时修复历史乱码文件名）
    if (t.type === 'ytdlp') {
      try {
        const info = require('./ytdlp').probe(t.url);
        const newName = safeName(await info.then(i => i.title)) + '.mp4';
        const dir = path.dirname(t.filePath);
        const newPath = path.join(dir, newName);
        if (newPath !== t.filePath) {
          await fsp.unlink(t.filePath).catch(() => {});
          t.filename = newName;
          t.filePath = newPath;
        }
      } catch { /* 探测失败保持旧名 */ }
    }
    await fsp.unlink(t.filePath + '.part').catch(() => {});
    await fsp.unlink(t.filePath + '.tdmmeta.json').catch(() => {});
    await fsp.unlink(t.filePath + '.hlsmeta.json').catch(() => {});
    await fsp.rm(t.filePath + '.hls.tmp', { recursive: true, force: true }).catch(() => {});
    // BT：aria2 的断点控制文件与磁力链元数据也要清，否则「重新下载」会直接续上旧进度
    await fsp.unlink(t.filePath + '.aria2').catch(() => {});
    const btStem = t.filePath.replace(/\.[^.]+$/, '');
    await fsp.unlink(btStem + '.aria2').catch(() => {});
    await fsp.unlink(btStem + '.torrent').catch(() => {});
    t.size = -1; t.downloaded = 0; t.error = null; t.status = 'pending';
    await this._persist();
    this.emit('progress');
    this._maybeStart();
  }

  async pause(id) {
    const t = this.tasks.get(id);
    if (!t || !t.worker) return;
    t.worker.pause();
    t.status = 'paused';
    await this._persist();
    // 空出的并发槽位给下一个任务
    this._maybeStart();
  }

  async resume(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (!['paused', 'error', 'pending'].includes(t.status)) return;
    t.error = null;
    // 优先复用已有 worker（分段状态/断点元数据都在内存里，恢复最快最可靠）
    if (t.worker) {
      t.status = 'downloading';
      t.worker.start();
    } else {
      t.status = 'pending';
      this._maybeStart();
    }
    await this._persist();
  }

  async pauseAll() {
    for (const t of this.tasks.values()) if (t.status === 'downloading' || t.status === 'probing') await this.pause(t.id);
  }

  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.worker) await t.worker.remove();
    else if (t.status !== 'completed') await fsp.unlink(t.filePath).catch(() => {});
    this.tasks.delete(id);
    await this._persist();
    this.emit('progress');
    this._maybeStart();
  }

  async clearCompleted() {
    for (const t of [...this.tasks.values()]) if (t.status === 'completed') await this.remove(t.id);
  }

  async loadPersisted() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const arr = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf8'));
      for (const r of arr) {
        const task = { ...r, worker: null };
        task.source = task.source || getSource(task.url); // 兼容旧任务记录
        // 自愈历史记录：HLS 任务早期把 filePath 定成了 .m3u8（播放列表后缀），
        // 而磁盘上真实产物是合并后的 .mp4。不纠正的话记录路径永久指向一个不存在的文件。
        if (task.type === 'hls' && /\.m3u8$/i.test(task.filePath || '')) {
          task.filePath = task.filePath.replace(/\.m3u8$/i, '.mp4');
          task.filename = (task.filename || path.basename(task.filePath)).replace(/\.m3u8$/i, '.mp4');
        }
        if (task.status === 'downloading' || task.status === 'pending' || task.status === 'probing') {
          task.status = 'paused'; // 进程重启后标记为暂停，等待用户恢复
        }
        this.tasks.set(task.id, task);
        this._idCounter = Math.max(this._idCounter, task.id + 1);
      }
    } catch { /* 首次运行 */ }
    await this.sweepOrphans();
  }

  // 清扫下载目录里的孤儿文件：.part / .tdmmeta.json / .hlsmeta.json / .hls.tmp
  // 不属于任何已知任务的（历史崩溃或删除残留）一律删除。
  //
  // 安全约束（重要）：下载目录在 macOS 上默认是 ~/Downloads，是用户共用的目录。
  // `.part` 是 Firefox 等其它下载器也在用的通用后缀，无条件删除会误删别人的文件。
  // 因此：
  //   1) CDown 专属后缀（.tdmmeta.json / .hlsmeta.json / .hls.tmp / .cdown-path-*.txt）任何目录下都可清；
  //   2) 通用后缀 `.part` 仅在下载目录位于 CDown 自己的数据目录内时才清。
  async sweepOrphans() {
    const cfg = require('./config').load();
    const dir = cfg.downloadDir;
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    const known = new Set();
    for (const t of this.tasks.values()) {
      known.add(t.filePath);
      known.add(t.filePath + '.part');
      known.add(t.filePath + '.tdmmeta.json');
      known.add(t.filePath + '.hlsmeta.json');
      known.add(t.filePath + '.hls.tmp');
    }
    // 下载目录是否在 CDown 私有数据目录内（决定能否安全清理通用后缀 .part）
    const ownDataDir = path.resolve(require('./config').DATA_DIR) + path.sep;
    const canSweepGenericPart = path.resolve(dir).startsWith(ownDataDir);
    let cleaned = 0, skipped = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      if (known.has(full)) continue;
      const isCdownArtifact = name.endsWith('.tdmmeta.json')
        || name.endsWith('.hlsmeta.json') || name.endsWith('.hls.tmp')
        || /^\.cdown-path-\d+\.txt$/.test(name);
      const isGenericPart = name.endsWith('.part');
      const isTemp = isCdownArtifact || (isGenericPart && canSweepGenericPart);
      if (!isTemp) {
        if (isGenericPart) skipped++;
        continue;
      }
      const st = await fsp.stat(full).catch(() => null);
      if (st?.isDirectory()) await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      else await fsp.unlink(full).catch(() => {});
      cleaned++;
    }
    if (cleaned > 0) console.log(`[sweep] 已清理 ${cleaned} 个孤儿临时文件`);
    // 共用目录（如 ~/Downloads）里的 .part 属其它程序所有，一律不动
    if (skipped > 0) console.log(`[sweep] 跳过 ${skipped} 个非 CDown 的 .part 文件（共用目录，不越权删除）`);
  }
}

module.exports = { Queue, classify, filenameFromUrl, getSource };
