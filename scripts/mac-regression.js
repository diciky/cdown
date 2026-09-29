// CDown - 下载引擎回归测试（macOS 调试用，无需 Electron）
// 覆盖本次修复的几个缺陷，全部用本地服务器，不依赖外网：
//   1) 支持 Range 的服务器  → 应多线程分段，且文件校验一致
//   2) 忽略 Range 的服务器  → 修复前会被错误分段导致文件损坏，现在应单流下载且内容正确
//   3) 无 Content-Length    → 修复前分段循环条件恒假，产出 0 字节「已完成」文件
//   4) HLS 分片持续失败     → 修复前 _runWorkers 死循环狂发请求，现在应报错并退出，且重试次数有限
// 用法: node scripts/mac-regression.js
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HttpDownloader } = require('../src/engine/downloader');
const { HlsDownloader } = require('../src/engine/m3u8');

const SIZE = 8 * 1024 * 1024;
const DATA = (() => {
  const buf = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
})();
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');

const OUT = path.join(os.tmpdir(), 'cdown-regression');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function startServer(handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}
const close = s => new Promise(r => s.close(r));

// ---------- 1) 支持 Range ----------
function rangeHandler(req, res) {
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : SIZE - 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes'
    });
    res.end(DATA.subarray(start, end + 1));
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': SIZE,
      'Accept-Ranges': 'bytes'
    });
    res.end(DATA);
  }
}

// ---------- 2) 忽略 Range（总是返回完整 200，且不带 Accept-Ranges） ----------
let noRangeRequests = 0;
function noRangeHandler(req, res) {
  noRangeRequests++;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE });
  res.end(DATA);
}

// ---------- 3) 无 Content-Length（chunked） ----------
function chunkedHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // 不设 Content-Length -> chunked
  let off = 0;
  const step = 512 * 1024;
  const tick = () => {
    if (off >= SIZE) return res.end();
    res.write(DATA.subarray(off, Math.min(off + step, SIZE)));
    off += step;
    setTimeout(tick, 5);
  };
  tick();
}

// ---------- 4) HLS：第 2 个分片永远 404 ----------
let hlsBadHits = 0;
function hlsHandler(req, res) {
  const u = req.url;
  if (u === '/playlist.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n' +
      ['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts'].map(s => `#EXTINF:1.0,\n${s}`).join('\n') +
      '\n#EXT-X-ENDLIST\n');
  }
  if (u === '/seg1.ts') { hlsBadHits++; res.writeHead(404); return res.end('nope'); }
  if (/^\/seg\d\.ts$/.test(u)) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(Buffer.alloc(4096, 1));
  }
  res.writeHead(404); res.end();
}

function runHttp(url, filePath, threads) {
  return new Promise(resolve => {
    const d = new HttpDownloader({ id: 1, url, filePath, threads });
    d.on('done', () => resolve({ ok: true, snapshot: d.snapshot() }));
    d.on('error', s => resolve({ ok: false, error: s.error }));
    d.start();
  });
}

(async () => {
  console.log('CDown 引擎回归测试\n' + '='.repeat(52));

  // 1) Range 服务器
  {
    const { server, port } = await startServer(rangeHandler);
    const f = path.join(OUT, 'range.bin');
    fs.rmSync(f, { force: true });
    const r = await runHttp(`http://127.0.0.1:${port}/f.bin`, f, 8);
    await close(server);
    const ok = r.ok && fs.existsSync(f) && sha256(f) === SHA;
    record('支持 Range：多线程分段下载且内容一致', ok,
      r.ok ? `分段数 ${r.snapshot.segments}，校验${sha256(f) === SHA ? '通过' : '失败'}` : `失败: ${r.error}`);
  }

  // 2) 忽略 Range 的服务器（修复前文件会损坏）
  {
    const { server, port } = await startServer(noRangeHandler);
    const f = path.join(OUT, 'norange.bin');
    fs.rmSync(f, { force: true });
    noRangeRequests = 0;
    const r = await runHttp(`http://127.0.0.1:${port}/f.bin`, f, 8);
    await close(server);
    const good = r.ok && fs.existsSync(f) && sha256(f) === SHA;
    record('忽略 Range：自动降级单流且内容一致', good,
      r.ok ? `HTTP 请求 ${noRangeRequests} 次（探测 1 + 下载 1，说明没有扇出成 8 线程），分段数 ${r.snapshot.segments}，校验${sha256(f) === SHA ? '通过' : '失败'}`
           : `失败: ${r.error}`);
  }

  // 3) 无 Content-Length（修复前产出 0 字节）
  {
    const { server, port } = await startServer(chunkedHandler);
    const f = path.join(OUT, 'chunked.bin');
    fs.rmSync(f, { force: true });
    const r = await runHttp(`http://127.0.0.1:${port}/f.bin`, f, 8);
    await close(server);
    const size = fs.existsSync(f) ? fs.statSync(f).size : -1;
    const ok = r.ok && size === SIZE && sha256(f) === SHA;
    record('无 Content-Length：完整落盘而非 0 字节', ok,
      r.ok ? `落盘 ${size} 字节 / 期望 ${SIZE}` : `失败: ${r.error}`);
  }

  // 4) HLS 分片失败应快速终止，不得死循环
  {
    const { server, port } = await startServer(hlsHandler);
    const f = path.join(OUT, 'hls.mp4');
    const d = new HlsDownloader({ id: 1, url: `http://127.0.0.1:${port}/playlist.m3u8`, filePath: f, threads: 4 });
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, reason: '超时未终止（疑似死循环）' }), 20000);
      d.on('error', s => { clearTimeout(timer); resolve({ ok: true, error: s.error }); });
      d.on('done', () => { clearTimeout(timer); resolve({ ok: false, reason: '意外成功' }); });
      d.start();
    });
    await close(server);
    // 失败分片最多重试 2 次（第 3 次放弃），不应出现请求风暴
    const bounded = hlsBadHits <= 3;
    record('HLS 分片持续失败：快速报错且重试有界', outcome.ok && bounded,
      outcome.ok ? `失败分片请求 ${hlsBadHits} 次（应 ≤3）；错误: ${String(outcome.error).slice(0, 60)}`
                 : outcome.reason);
  }

  // ---------- 汇总 ----------
  const failed = results.filter(r => !r.ok);
  console.log('='.repeat(52));
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  console.log(`产物目录: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})();
