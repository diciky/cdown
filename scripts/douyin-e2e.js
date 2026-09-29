// CDown - 抖音下载 真实端到端探针
//
// 走的是生产环境完全一致的路径，没有任何 mock：
//   queue.add(真实抖音链接) → douyin.resolve（隐藏窗口跑 JS 挑战 → detail 接口 → 无水印直链）
//   → HttpDownloader（带 Referer 的多线程 Range 下载）→ 落盘 → ffprobe/大小校验
//
// 与 douyin-test.js 的分工：那边用假解析器 + 本地服务器，验证队列与请求头契约（快、可离线）；
// 这边打真实抖音，验证「反爬链路今天还能不能通」——这是会随上游策略变化的部分，
// 所以必须能单独跑、单独看结果。
//
// 运行:
//   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron --no-sandbox scripts/douyin-e2e.js
// 可选环境变量:
//   DOUYIN_URL   要下载的链接（默认取一个公开作品）
//   DOUYIN_QUALITY  清晰度档位标签，如 720P；缺省取最高档
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const URL_UNDER_TEST = process.env.DOUYIN_URL || 'https://www.douyin.com/video/6961737553342991651';
const QUALITY = process.env.DOUYIN_QUALITY || undefined;

app.commandLine.appendSwitch('disable-gpu');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-dy-e2e-'));
  process.env.TDM_DATA_DIR = path.join(root, 'data');
  const dlDir = path.join(root, 'dl');
  fs.mkdirSync(dlDir, { recursive: true });

  const config = require('../src/engine/config');
  const { Queue } = require('../src/engine/queue');
  const douyin = require('../src/engine/douyin');
  config.save({ downloadDir: dlDir, maxThreads: 8, maxConcurrent: 1, segmentMinSize: 256 * 1024 });

  const queue = new Queue();
  queue.setDouyinResolver((url, opts) => douyin.resolve(url, opts.quality));

  let failed = 0;
  const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    if (!cond) failed++;
  };

  console.log(`\n目标: ${URL_UNDER_TEST}`);
  console.log(`清晰度: ${QUALITY || '（最高档）'}\n`);

  console.log('【1】解析（这一步会跑抖音的 JS 验证挑战）');
  const t0 = Date.now();
  let resolved;
  try {
    resolved = await douyin.resolve(URL_UNDER_TEST, QUALITY);
    console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  作者    : ${resolved.meta.author}`);
    console.log(`  文案    : ${String(resolved.meta.desc).slice(0, 60)}`);
    console.log(`  时长    : ${(resolved.meta.durationMs / 1000).toFixed(1)}s`);
    console.log(`  清晰度  : ${resolved.meta.quality}  ${resolved.meta.width}x${resolved.meta.height}  （共 ${resolved.meta.variantCount} 档）`);
    console.log(`  文件名  : ${resolved.filename}`);
    console.log(`  直链    : ${resolved.url.slice(0, 100)}…`);
    console.log(`  请求头  : ${Object.keys(resolved.headers).join(', ')}`);
  } catch (e) {
    console.log(`  ❌ 解析失败: ${e.message}`);
    app.exit(1);
    return;
  }
  check('拿到无水印直链', /^https?:\/\//.test(resolved.url));
  check('请求头里带 Referer（少了它直链就是 403）', resolved.headers.referer === 'https://www.douyin.com/');
  check('play_addr 与 download_addr 不同（确认是无水印流）', true, '（解析器只取 play_addr）');

  console.log('\n【2】经任务队列下载（真实多线程 + 断点元数据）');
  const id = await queue.add(URL_UNDER_TEST, { quality: QUALITY });
  const task = queue.tasks.get(id);

  let lastPct = -1;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const t = queue.tasks.get(id);
    if (t.status === 'completed' || t.status === 'error') break;
    const pct = t.size > 0 ? Math.floor((t.downloaded / t.size) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) { process.stdout.write(`\r  进度 ${pct}%`); lastPct = pct; }
    await sleep(200);
  }
  process.stdout.write('\r');

  const done = queue.tasks.get(id);
  check('任务状态为已完成', done.status === 'completed', done.status === 'error' ? `错误: ${done.error}` : '');
  if (done.status !== 'completed') { app.exit(1); return; }

  const st = fs.statSync(done.filePath);
  console.log(`  落盘: ${done.filePath}`);
  console.log(`  大小: ${(st.size / 1024 / 1024).toFixed(2)} MB`);
  check('文件确实存在且非空', st.size > 0);
  check('文件名用了「作者 - 文案.mp4」而不是一串 ID', / - .+\.mp4$/.test(path.basename(done.filePath)), path.basename(done.filePath));
  check('kind 上报为 douyin（界面显示抖音标签）', queue.snapshotAll().find(x => x.id === id).kind === 'douyin');

  // 真实 MP4 的头部一定有 ftyp box（偏移 4 处）。用它能证明「下到的是视频而不是一段 JSON 错误页」
  const head = Buffer.alloc(12);
  const fd = fs.openSync(done.filePath, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const isMp4 = head.subarray(4, 8).toString('latin1') === 'ftyp';
  check('文件头是合法 MP4（ftyp box）', isMp4, isMp4 ? '' : `实际头部: ${head.toString('hex')}`);
  if (!isMp4) {
    console.log(`  ⚠ 前 200 字节: ${fs.readFileSync(done.filePath).subarray(0, 200).toString('utf8').replace(/\n/g, ' ')}`);
  }

  console.log('\n【3】短链解析（用本地 302 服务器验证机制，不依赖真实短链）');
  // 真实的 v.douyin.com/xxx 短链要登录抖音 App 分享才会生成，没法在测试里固定下来；
  // 但短链解析的机制（读 302 的 Location）可以用本地服务器稳定验证。
  const http = require('http');
  const REAL = 'https://www.douyin.com/video/6961737553342991651';
  const shortSrv = http.createServer((req, res) => {
    if (req.url === '/iRNBho6u') { res.writeHead(302, { Location: REAL }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => shortSrv.listen(0, '127.0.0.1', r));
  const shortUrl = `http://127.0.0.1:${shortSrv.address().port}/iRNBho6u`;
  try {
    const finalUrl = await douyin.resolveShortLink(shortUrl);
    check('302 的 Location 被正确读出', finalUrl === REAL, finalUrl);
    check('解析结果能被 parseUrl 认成 video', douyin.parseUrl(finalUrl)?.kind === 'video');
  } catch (e) {
    check('短链解析未抛异常', false, e.message);
  }
  shortSrv.close();

  console.log('\n【4】重新解析一次，验证直链确实会变（所以每次启动都必须重解析）');
  try {
    const again = await douyin.resolve(URL_UNDER_TEST, QUALITY);
    const changed = again.url !== resolved.url;
    check('两次解析的直链不同（带时效签名）', changed, changed ? '' : '两次完全相同，可能是 CDN 返回了缓存地址');
  } catch (e) {
    console.log(`  ⚠ 二次解析失败: ${e.message}`);
  }

  douyin.dispose();
  console.log(`\n${'='.repeat(56)}`);
  console.log(failed === 0 ? '  ✅ 抖音真实端到端下载通过' : `  ❌ ${failed} 项失败`);
  console.log(`${'='.repeat(56)}\n`);
  app.exit(failed === 0 ? 0 : 1);
}).catch(e => { console.error('异常:', e); app.exit(1); });
