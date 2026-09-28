// TDM Fast - 核心多线程分段下载引擎
// 原理：探测文件大小与 Range 支持 -> 切 N 段 -> 每段独立线程从偏移量并行拉取
//      -> 全部落盘后按序合并（直接 rename .part）。支持断点续传（.tdmmeta.json）。
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TDMFast/0.1';

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------- 探测 ----------
// HuggingFace 特化：resolve 链接 302 到 CDN，携带 X-Linked-Size / X-Linked-ETag。
// 先手动跟随重定向拿到最终 CDN URL，之后所有分段直接命中 CDN，绕过逐段重新签名。
async function resolveTarget(url, headers = {}) {
  let current = url;
  const merged = { 'user-agent': UA, ...headers };
  for (let hop = 0; hop < 8; hop++) {
    const isHF = /huggingface\.co/.test(current);
    const resp = await fetch(current, {
      method: 'GET',
      headers: isHF ? { ...merged, range: 'bytes=0-0', 'accept-encoding': 'identity' } : merged,
      redirect: 'manual'
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => {});
      if (!loc) throw new Error(`重定向缺少 Location (${resp.status})`);
      current = new URL(loc, current).href;
      continue;
    }
    if (isHF && resp.status === 200) {
      // HF 返回了最终 CDN 的 200：从 X-Linked-* 拿真实大小
      const linkedSize = Number(resp.headers.get('x-linked-size'));
      const linkedETag = resp.headers.get('x-linked-etag');
      await resp.body?.cancel().catch(() => {});
      if (linkedSize > 0) {
        return { url: current, headers: merged, finalUrl: current, size: linkedSize, etag: linkedETag, lastModified: null, acceptRanges: true };
      }
    }
    if (resp.status === 206) {
      const cr = resp.headers.get('content-range') || ''; // bytes 0-0/123456
      const total = Number(cr.split('/')[1]);
      await resp.body?.cancel().catch(() => {});
      return {
        url: current,
        headers: merged,
        finalUrl: current,
        size: total > 0 ? total : -1,
        etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified'),
        acceptRanges: true
      };
    }
    if (resp.status === 200) {
      const size = Number(resp.headers.get('content-length'));
      const acceptRanges = resp.headers.get('accept-ranges') === 'bytes';
      await resp.body?.cancel().catch(() => {});
      return {
        url: current,
        headers: merged,
        finalUrl: current,
        size: size > 0 ? size : -1,
        etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified'),
        acceptRanges: size > 0 ? acceptRanges : false
      };
    }
    await resp.body?.cancel().catch(() => {});
    throw new Error(`探测失败: HTTP ${resp.status} ${current}`);
  }
  throw new Error('重定向次数超限');
}

// ---------- 分段下载器 ----------
class HttpDownloader extends EventEmitter {
  /**
   * opts: { id, url, headers, filePath, threads, size?, etag?, lastModified?, finalUrl? }
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.url = opts.url;
    this.headers = opts.headers || {};
    this.finalUrl = opts.finalUrl || null;
    this.filePath = opts.filePath;
    this.tmpPath = opts.filePath + '.part';
    this.metaPath = opts.filePath + '.tdmmeta.json';
    this.threads = Math.max(1, Math.min(64, opts.threads || 8));
    this.status = 'idle'; // idle|probing|downloading|paused|completed|error
    this.error = null;
    this.size = opts.size || -1;
    // 是否支持 Range 分段。null = 尚未探测；调用方（Queue）已探测过则会传入明确布尔值
    this.acceptRanges = opts.acceptRanges === undefined ? null : opts.acceptRanges;
    this.etag = opts.etag || null;
    this.lastModified = opts.lastModified || null;
    // 稳定资源标识。抖音这类「直链每次解析都带新的签名 token」的资源，
    // url 每次都不一样，靠 url 比对会让断点续传永远失效（每次都从 0 重来）。
    // 传入 resumeKey（如 douyin:<aweme_id>:<清晰度>）后改用 key + size 判定同一资源。
    this.resumeKey = opts.resumeKey || null;
    this.segments = []; // {index,start,end,done}
    this.workers = new Map(); // index -> AbortController
    this.downloaded = 0;
    this.speed = 0;
    this._speedWindow = []; // {t, bytes}
    this._persistTimer = null;
    this._stopped = true;
    this.logs = []; // 运行日志（环形，最多 100 条），用于界面展示与复制
  }

  _log(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logs.push(`[${ts}] ${msg}`);
    if (this.logs.length > 100) this.logs.shift();
  }

  snapshot() {
    const pct = this.size > 0 ? Math.min(100, (this.downloaded / this.size) * 100) : 0;
    return {
      kind: 'http',
      id: this.id,
      status: this.status,
      filename: path.basename(this.filePath),
      filePath: this.filePath,
      url: this.url,
      size: this.size,
      sizeText: fmtBytes(this.size),
      downloaded: this.downloaded,
      speed: this.speed,
      speedText: `${fmtBytes(this.speed)}/s`,
      progress: Number(pct.toFixed(1)),
      threads: this.threads,
      activeThreads: this.workers.size,
      segments: this.segments.length,
      segDetail: this.segments.map(s => ({
        i: s.index,
        done: s.done,
        total: s.end === -1 ? -1 : s.end - s.start + 1,
        active: this.workers.has(s.index)
      })),
      logs: this.logs.slice(-40),
      error: this.error
    };
  }

  _emitProgress() {
    if (this.status === 'error' || this.status === 'completed') return; // 终态后不再发进度，避免状态回跳
    const now = Date.now();
    this._speedWindow.push({ t: now, b: this.downloaded });
    while (this._speedWindow.length > 2 && now - this._speedWindow[0].t > 2000) this._speedWindow.shift();
    const first = this._speedWindow[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.3) this.speed = Math.max(0, (this.downloaded - first.b) / dt);
    this.emit('progress', this.snapshot());
  }

  async _persist() {
    const meta = {
      version: 1,
      url: this.url,
      finalUrl: this.finalUrl,
      headers: this.headers,
      filePath: this.filePath,
      size: this.size,
      etag: this.etag,
      lastModified: this.lastModified,
      resumeKey: this.resumeKey,
      segments: this.segments.map(s => ({ start: s.start, end: s.end, done: s.done }))
    };
    await fsp.writeFile(this.metaPath, JSON.stringify(meta), 'utf8').catch(() => {});
  }

  // 尝试从 .tdmmeta.json 恢复；服务器资源已变化则返回 false 全新开始
  async _tryResume() {
    try {
      const meta = JSON.parse(await fsp.readFile(this.metaPath, 'utf8'));
      // 有 resumeKey 时按 key + size 判定（url 含时效签名，每次解析都不同，不能参与比对）；
      // 没有 resumeKey 的普通直链仍按 url + size + etag 三重校验，保持原有严格性。
      const sameResource = this.resumeKey
        ? (meta.resumeKey === this.resumeKey && meta.size === this.size)
        : (meta.url === this.url && meta.size === this.size && meta.etag === this.etag);
      if (!sameResource || !fs.existsSync(this.tmpPath)) return false;
      this.segments = meta.segments.map((s, i) => ({ index: i, ...s }));
      this.downloaded = this.segments.reduce((a, s) => a + s.done, 0);
      this.finalUrl = meta.finalUrl || this.finalUrl;
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    if (this.status === 'downloading' || this.status === 'completed') return;
    this.status = 'probing';
    this.error = null;
    this._stopped = false; // 必须先复位，否则探测重试循环会因该标记直接放弃
    this._emitProgress();
    try {
      // 调用方已探测出 size + Range 支持情况时跳过重复探测（省一次往返）
      if (this.size === -1 || this.acceptRanges === null || this.segments.length === 0) {
        let probe;
        for (let i = 1; ; i++) {
          try { probe = await resolveTarget(this.finalUrl || this.url, this.headers); break; }
          catch (e) {
            if (i >= 4 || this._stopped) throw new Error(`探测失败: ${e.message}`);
            this._log(`⚠ 探测失败（${e.message}），${i}s 后第 ${i}/3 次重试`);
            await new Promise(r => setTimeout(r, i * 1000));
          }
        }
        this.finalUrl = probe.url;
        this.headers = { ...this.headers, ...(probe.headers && !probe.headers['user-agent'] ? {} : {}) };
        this.size = probe.size;
        this.acceptRanges = probe.acceptRanges === true;
        this.etag = probe.etag;
        this.lastModified = probe.lastModified;
        const target = { 'user-agent': UA, ...this.headers };
        this.headers = target;
      }
      if (this.segments.length === 0 && !(await this._tryResume())) this._planSegments();
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      if (!this.fd) {
        const flags = fs.existsSync(this.tmpPath) ? 'r+' : 'w';
        this.fd = await fsp.open(this.tmpPath, flags);
      }
      await this.fd.truncate(this.size).catch(() => {}); // 预分配
      this.status = 'downloading';
      this._stopped = false;
      this._log(fs.existsSync(this.metaPath) || this.segments.some(s => s.done > 0)
        ? `▶ 从断点恢复下载（${fmtBytes(this.downloaded)} / ${fmtBytes(this.size)}，${this.segments.length} 段 × ${this.threads} 线程）`
        : `▶ 开始下载（${this.segments.length} 段 × ${this.threads} 线程）`);
      this._persistTimer = setInterval(() => this._persist(), 2000);
      this._runWorkers();
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.emit('error', this.snapshot());
    }
  }

  // 分段是否仍未下完。
  // end === -1 表示长度未知（一直读到 EOF），只能由流的自然结束（seg.eof）来判定完成，
  // 否则 while 条件永远为真会无限重发请求。
  _segNotDone(seg) {
    if (seg.eof) return false;
    if (seg.end === -1) return true;
    return seg.done < seg.end - seg.start + 1;
  }

  _planSegments() {
    this.segments = [];
    this.downloaded = 0;
    const { segmentMinSize } = require('./config').load();
    // 只有服务端明确支持 Range 才分段。
    // 原来判断用的是 this.acceptRanges（从未赋值，恒为 undefined，!== false 恒真），
    // 于是不支持 Range 的服务器也被切成多段：每段都拿回完整文件并写到各自的偏移上，文件彻底损坏。
    const canRange = this.acceptRanges === true && this.size > segmentMinSize;
    const n = canRange ? Math.min(this.threads, Math.ceil(this.size / segmentMinSize)) : 1;
    if (!canRange || this.size <= 0) {
      // 单流顺序写入，end = -1 表示读到 EOF 为止
      this.segments = [{ index: 0, start: 0, end: -1, done: 0 }];
      return;
    }
    const chunk = Math.floor(this.size / n);
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      const end = i === n - 1 ? this.size - 1 : (i + 1) * chunk - 1;
      this.segments.push({ index: i, start, end, done: 0 });
    }
  }

  async _runWorkers() {
    if (this._finished) return;
    // 排除已有活动线程的分段，避免对同一分段重复派发导致竞态
    const pending = this.segments.filter(s => !this.workers.has(s.index) && this._segNotDone(s));
    const idle = this.threads - this.workers.size;
    const toRun = pending.slice(0, Math.max(0, idle));
    toRun.forEach(seg => this._worker(seg));
    if (pending.length === 0 && this.workers.size === 0) this._finish();
  }

  // 整体失败：停止所有线程，状态置为 error（可通过 ▶ 从断点恢复）
  async _fail(msg) {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = msg;
    this.speed = 0;
    this._stopped = true;
    this._log(`✖ ${msg}`);
    this.workers.forEach(ac => ac.abort());
    this.workers.clear();
    clearInterval(this._persistTimer);
    await this._persist();
    this.emit('error', this.snapshot());
  }

  async _worker(seg) {
    const ac = new AbortController();
    this.workers.set(seg.index, ac);
    let attempts = 0; // 连续失败次数，成功推进后归零
    try {
      while (this._segNotDone(seg) && !this._stopped) {
        try {
          const from = seg.start + seg.done;
          const range = `bytes=${from}-${seg.end === -1 ? '' : seg.end}`;
          const resp = await fetch(this.finalUrl || this.url, {
            headers: { ...this.headers, range },
            signal: ac.signal,
            redirect: seg.end === -1 ? 'follow' : 'manual'
          });
          if (seg.end !== -1 && resp.status !== 206 && resp.status !== 200) {
            throw new Error(`HTTP ${resp.status}`);
          }
          const stream = Readable.fromWeb(resp.body);
          for await (const buf of stream) {
            if (this._stopped) { stream.destroy(); break; }
            await this.fd.write(buf, 0, buf.length, seg.start + seg.done);
            seg.done += buf.length;
            this.downloaded += buf.length;
            this._emitProgress();
          }
          // 长度未知的单流：流正常读到 EOF 即该段完成（不能靠区间长度判断，否则会无限重发）
          if (!this._stopped && seg.end === -1) seg.eof = true;
          attempts = 0; // 本轮请求成功，重置重试计数
        } catch (e) {
          if (this._stopped || e.name === 'AbortError') break;
          attempts++;
          if (attempts >= 8) {
            await this._fail(`分段 ${seg.index + 1}: ${e.message}（已自动重试 ${attempts} 次）`);
            return;
          }
          const wait = Math.min(attempts * 1000, 8000);
          this._log(`⚠ 分段 ${seg.index + 1} 出错（${e.message}），${wait / 1000}s 后第 ${attempts}/8 次重试`);
          this.emit('progress', this.snapshot());
          await new Promise(r => setTimeout(r, wait));
          if (this._stopped) break;
        }
      }
    } finally {
      this.workers.delete(seg.index);
      if (!this._stopped) {
        if (this.status === 'error') { clearInterval(this._persistTimer); this._persist(); }
        else {
          const hasPending = this.segments.some(s => this._segNotDone(s));
          // 只有所有工作线程都退出且无未完成分段时才能收尾（避免提前关闭 fd 的竞态）
          if (!hasPending && this.workers.size === 0) this._finish();
          else this._runWorkers(); // 慢段自动补线程
        }
      }
    }
  }

  async _finish() {
    if (this._finished) return;
    this._finished = true;
    clearInterval(this._persistTimer);
    try {
      await this.fd?.close();
      this.fd = null;
      try {
        await fsp.rename(this.tmpPath, this.filePath);
      } catch (e) {
        // 数据其实已完整落盘在 .part 里，只是最后改名失败（权限 / 文件被占用 / 跨卷等）。
        // 不能笼统报「合并失败」，否则用户会以为要重新下载，白白浪费已完成的流量。
        throw new Error(`保存文件失败: ${e.message}。数据已完整下载在 ${path.basename(this.tmpPath)}，排除占用或权限问题后重试即可`);
      }
      await fsp.unlink(this.metaPath).catch(() => {});
      // 长度未知的流：以实际落盘字节数作为最终大小，让界面能显示 100%
      if (!(this.size > 0) && this.downloaded > 0) this.size = this.downloaded;
      this.downloaded = this.size > 0 ? this.size : this.downloaded;
      this.status = 'completed';
      this.speed = 0;
      this.emit('done', this.snapshot());
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.emit('error', this.snapshot());
    }
  }

  pause() {
    if (this.status !== 'downloading' && this.status !== 'probing') return;
    this._stopped = true;
    this.workers.forEach(ac => ac.abort());
    this.workers.clear();
    clearInterval(this._persistTimer);
    this.status = 'paused';
    this.speed = 0;
    this._persist();
    this.emit('progress', this.snapshot());
  }

  async remove() {
    this.pause();
    try { await this.fd?.close(); } catch { /* 已关闭 */ }
    this.fd = null;
    await fsp.unlink(this.tmpPath).catch(() => {});
    await fsp.unlink(this.metaPath).catch(() => {});
    if (this.status !== 'completed') await fsp.unlink(this.filePath).catch(() => {});
  }
}

module.exports = { HttpDownloader, resolveTarget, fmtBytes, UA };
