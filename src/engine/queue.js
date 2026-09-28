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
  const raw = String(url || '').trim();
  // BitTorrent：磁力链 / .torrent 种子文件
  if (/^magnet:\?/i.test(raw)) return 'bt';
  // 抖音等 App 的「分享」按钮复制出来的是「文案 + 链接」一整段（中间有空格），
  // 必须先把链接抠出来再判断 —— 否则整段文本会被当成普通 HTTP 直链，
  // 结果是把一段分享文案下载成一个 .bin 文件。
  const m = raw.match(/https?:\/\/[^\s，,。；;、]+/);
  const u = (m ? m[0] : raw).toLowerCase();
  if (/\.torrent(?:[?#]|$)/.test(u)) return 'bt';
  // 抖音：单独一条链路。它不能交给 yt-dlp（其 DouyinIE 明确不生成签名 cookie，
  // 实测喂 cookie 也仍 403），必须先经应用内的浏览器会话换到无水印直链。
  if (/(?:^|\.)(?:douyin|iesdouyin)\.com/.test(hostOf(u))) return 'douyin';
  // HLS：路径以 .m3u8 结尾，或由查询参数指定了 m3u8 格式。
  // 旧实现只判断 includes('m3u8?')，因此 `?format=m3u8&token=…` 这类
  // 查询参数形式的播放列表会被误判成普通 HTTP 直链，从而下载到一份文本清单。
  if (/\.m3u8(?:[?#]|$)/.test(u) || /[?&](?:format|fmt|type|ext)=m3u8\b/.test(u)) return 'hls';
  const VIDEO_SITES = ['youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'x.com', 'twitter.com', 'tiktok.com', 'reddit.com', 'ixigua.com', 'youku.com', 'v.qq.com', 'iqiyi.com'];
  if (VIDEO_SITES.some(s => u.includes(s))) return 'ytdlp';
  return 'http';
}

function hostOf(u) {
  const m = String(u).match(/^https?:\/\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
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
    // 抖音解析器由主进程注入（它依赖 Electron 的浏览器会话）。
    // 不在这里直接 require：queue.js 也被 CLI 与单测使用，那些环境没有 electron。
    this._douyinResolver = null;
  }

  setDouyinResolver(fn) { this._douyinResolver = fn; }

  async _persist() {
    const arr = [...this.tasks.values()].map(t => ({
      id: t.id, url: t.url, type: t.type, status: t.status,
      filePath: t.filePath, filename: t.filename, threads: t.threads,
      size: t.size, downloaded: t.downloaded, error: t.error, createdAt: t.createdAt,
      format: t.format || null,
      // 抖音任务需要额外持久化：直链会过期，重启后要重新解析；
      // quality 也必须记住，否则恢复时会退回全局默认清晰度、换到另一档流
      kind: t.kind || null, source: t.source || null, meta: t.meta || null,
      quality: t.quality || null
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
      // kind 以任务记录为准：下载器的 snapshot 只会报自己的实现类型（http），
      // 而界面上要区分出「抖音」这种走同一条 HTTP 引擎但来源不同的任务。
      return { ...s, kind: t.kind || s.kind, source: t.source || getSource(t.url), meta: t.meta || null };
    });
  }

  _bump(t) { this.emit('progress', t.worker ? t.worker.snapshot() : null); }

  async add(url, opts = {}) {
    const cfg = require('./config').load();
    const type = opts.type || classify(url);
    const id = this._idCounter++;
    let filename = opts.filename;
    let threads = opts.threads || (type === 'hls' ? 16 : url.includes('huggingface') || url.includes('hf-mirror') ? cfg.hfThreads : cfg.maxThreads);
    let source = getSource(url);
    let headers = opts.headers || null;
    let directUrl = null;
    let kind = opts.kind || null;
    let meta = opts.meta || null;
    // 抖音：用户在界面上选的清晰度档位标签，要跟着任务走（恢复时复用同一档）
    let quality = null;

    // 抖音：先经应用内的浏览器会话换到无水印直链，再当作普通 HTTP 任务下载。
    // 解析器由主进程注入（依赖 Electron），CLI/单测环境没注册就会走下面的报错分支。
    if (type === 'douyin') {
      if (!this._douyinResolver) throw new Error('抖音下载需要在 CDown 应用内使用（解析器未注册）');
      quality = opts.quality || null;
      const r = await this._douyinResolver(url, { quality });
      directUrl = r.url;
      headers = r.headers || null;
      filename = filename || r.filename;
      kind = 'douyin';
      source = '抖音';
      meta = r.meta || null;
      threads = opts.threads || cfg.maxThreads;
    }

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
    // 统一净化：调用方传入的 filename（如抖音的「作者 - 描述.mp4」）可能带
    // `/` 等路径字符，或超过文件系统 255 字节上限，必须过一遍 safeName 再拼路径。
    filename = safeName(filename || filenameFromUrl(url, type));
    const filePath = path.join(opts.dir || cfg.downloadDir, filename);

    const task = {
      id, url, type, source, status: 'pending', filePath, filename, threads,
      size: -1, downloaded: 0, error: null, createdAt: Date.now(), worker: null,
      format: opts.format || null, headers, directUrl, kind, meta, quality
    };
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
      } else if (task.type === 'douyin') {
        // 抖音直链带时效签名，可能已过期 —— 每次启动前重新解析一次，
        // 否则「暂停一天后继续」会拿到 403。多花一次接口调用，换掉一整个失败场景。
        // 清晰度用任务自己记的（task.quality），没有才退回全局默认：
        // 用默认值会让恢复中的任务换到另一档流，和已下载的分段混在一起。
        if (this._douyinResolver) {
          const r = await this._douyinResolver(task.url, { quality: task.quality || cfg.douyinQuality });
          task.directUrl = r.url;
          task.headers = r.headers || null;
          if (r.meta) task.meta = { ...(task.meta || {}), ...r.meta };
        }
        if (!task.directUrl) throw new Error('抖音直链解析失败，请重新添加任务');
        const pre = await resolveTarget(task.directUrl, task.headers || {});
        worker = new HttpDownloader({
          id: task.id, url: task.directUrl, finalUrl: pre.url, headers: task.headers || {},
          filePath: task.filePath, threads: task.threads,
          size: pre.size, etag: pre.etag, lastModified: pre.lastModified,
          acceptRanges: pre.acceptRanges,
          // 直链每次解析都不一样，靠 url 比对断点永远失效；用任务级稳定标识
          resumeKey: `douyin:${task.url}:${task.quality || 'best'}`
        });
        task.size = pre.size;
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
