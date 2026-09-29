// CDown - BT 任务全链路集成测试
//
// 走的路径与真实应用完全一致：
//   queue.add(种子 URL) → classify 判为 bt → TorrentDownloader(aria2c)
//   → 进度事件 → 完成事件 → 落盘文件校验
// 本地起 tracker + 做种端，不依赖公网。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const { makePayload, makeTorrent, startTracker, freePort } = require('./bt-testkit');

const ARIA2 = process.env.ARIA2 || '/opt/homebrew/bin/aria2c';
const SIZE = 3 * 1024 * 1024;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-btq-'));
  const seedDir = path.join(root, 'seed');
  const leechDir = path.join(root, 'leech');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(leechDir, { recursive: true });

  // 隔离 CDown 的数据目录，避免污染用户真实任务列表
  process.env.TDM_DATA_DIR = path.join(root, 'data');
  const config = require('../src/engine/config');
  const { Queue, classify } = require('../src/engine/queue');
  const { parseProgressLine, parseSize, findAria2 } = require('../src/engine/torrent');

  const payload = path.join(seedDir, 'payload.bin');
  makePayload(payload, SIZE);
  const srcSha = sha256(payload);

  const { server: tracker, port: trackerPort } = await startTracker(null, '127.0.0.1');
  const announce = `http://127.0.0.1:${trackerPort}/announce`;
  const { raw, infoHash } = makeTorrent({ file: payload, name: 'payload.bin', announce });
  const torrentPath = path.join(root, 'payload.torrent');
  fs.writeFileSync(torrentPath, raw);

  // 把种子文件通过本地 HTTP 提供出去，模拟「http://.../x.torrent」
  const fileServer = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/payload.torrent')) {
      const b = fs.readFileSync(torrentPath);
      res.writeHead(200, { 'Content-Type': 'application/x-bittorrent', 'Content-Length': b.length });
      return res.end(b);
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const torrentUrl = `http://127.0.0.1:${fileServer.address().port}/payload.torrent`;

  const seedPort = await freePort();
  const seeder = spawn(ARIA2, [
    '-d', seedDir, torrentPath,
    '--enable-dht=false', '--bt-enable-lpd=false',
    `--listen-port=${seedPort}`,
    '--check-integrity=true', '--bt-hash-check-seed=true',
    '--seed-time=600', '--bt-tracker=' + announce,
    '--console-log-level=notice', '--summary-interval=0'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let seedOut = '';
  seeder.stdout.on('data', d => { seedOut += d; });
  seeder.stderr.on('data', d => { seedOut += d; });
  const t0 = Date.now();
  while (!/Verification finished successfully/.test(seedOut) && Date.now() - t0 < 20000) await sleep(200);
  await sleep(2500); // 等做种端 announce 完成态

  console.log('CDown BT 集成测试');
  console.log('='.repeat(60));
  console.log(`种子: ${torrentUrl}`);
  console.log(`infoHash: ${infoHash.toString('hex')}   大小: ${SIZE} 字节`);
  console.log(`做种端: ${/Verification finished successfully/.test(seedOut) ? '校验通过' : '校验失败'}，端口 ${seedPort}\n`);

  console.log('【1】进度行解析（按实测格式）');
  await t('下载中的进度行', () => {
    const p = parseProgressLine('[#7a6adc 1.2MiB/4.0MiB(30%) CN:5 SD:2 DL:512KiB]');
    assert.strictEqual(p.size, 4 * 1024 * 1024);
    assert.strictEqual(p.downloaded, Math.round(1.2 * 1024 * 1024));
    assert.strictEqual(p.progress, 30);
    assert.strictEqual(p.connections, 5);
    assert.strictEqual(p.seeders, 2);
    assert.strictEqual(p.seeding, false);
  });
  await t('做种中的进度行 SEED(ratio)', () => {
    const p = parseProgressLine('[#7a6adc SEED(0.0) CN:0 SD:0]');
    assert.strictEqual(p.progress, 100);
    assert.strictEqual(p.seeding, true);
  });
  await t('容量单位换算（二进制后缀）', () => {
    assert.strictEqual(parseSize('0B'), 0);
    assert.strictEqual(parseSize('512KiB'), 512 * 1024);
    assert.strictEqual(parseSize('4.0MiB'), 4 * 1024 * 1024);
    assert.strictEqual(parseSize('1.5GiB'), Math.round(1.5 * 1024 ** 3));
    assert.strictEqual(parseSize(''), -1);
  });
  await t('无关文本不会被误判为进度行', () => {
    assert.strictEqual(parseProgressLine('[NOTICE] Download complete: /x/y'), null);
    assert.strictEqual(parseProgressLine('random log line'), null);
  });

  console.log('\n【2】任务分类');
  await t('magnet / .torrent 判为 bt', () => {
    assert.strictEqual(classify('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=x'), 'bt');
    assert.strictEqual(classify('https://a.com/x.torrent'), 'bt');
    assert.strictEqual(classify('https://a.com/x.torrent?token=1'), 'bt');
    assert.strictEqual(classify('https://a.com/x.zip'), 'http');
  });

  console.log('\n【3】aria2c 探测');
  await t('能找到 aria2c 可执行文件', () => {
    const bin = findAria2({});
    assert.ok(bin, 'findAria2 返回空');
    assert.ok(fs.existsSync(bin));
  });
  await t('配置里指定的路径优先', () => {
    assert.strictEqual(findAria2({ aria2Bin: ARIA2 }), ARIA2);
  });

  console.log('\n【4】通过 queue 跑真实 BT 下载');
  const queue = new Queue();
  config.save({ downloadDir: leechDir, aria2Bin: ARIA2, btDht: false, btSeedTime: 0, maxConcurrent: 1 });

  const progressSeen = [];
  let donePayload = null;
  let errorPayload = null;
  queue.on('progress', s => { if (s) progressSeen.push(s); });
  queue.on('done', s => { donePayload = s; });
  queue.on('error', s => { errorPayload = s; });

  await queue.loadPersisted();
  const id = await queue.add(torrentUrl);
  const task = queue.tasks.get(id);
  await t('任务被识别为 bt 类型', () => assert.strictEqual(task.type, 'bt'));
  await t('未报错', () => assert.strictEqual(errorPayload && errorPayload.error, null, errorPayload ? errorPayload.error : ''));

  // 等完成（本地环回，通常几秒）
  const tw = Date.now();
  while (!donePayload && !errorPayload && Date.now() - tw < 60000) await sleep(300);

  await t('任务完成且无错误', () => {
    if (errorPayload) throw new Error('下载报错: ' + errorPayload.error);
    assert.ok(donePayload, '60s 内未收到完成事件');
  });
  await t('有进度事件上报（界面才能动）', () => {
    assert.ok(progressSeen.length > 0, '没有收到任何 progress 事件');
    assert.ok(progressSeen.some(s => s.kind === 'bt'), '没有 kind=bt 的进度');
  });
  await t('进度里带 connections / seeders 字段', () => {
    const s = progressSeen.find(x => x.kind === 'bt');
    assert.ok('connections' in s && 'seeders' in s);
  });
  await t('最终状态为 completed 且进度 100%', () => {
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.worker.snapshot().progress, 100);
  });

  const got = path.join(leechDir, 'payload.bin');
  await t('文件落盘到配置的下载目录', () => {
    assert.ok(fs.existsSync(got), `未找到 ${got}；目录内容: ${fs.readdirSync(leechDir).join(', ')}`);
    assert.strictEqual(fs.statSync(got).size, SIZE);
  });
  await t('内容与源文件 SHA-256 一致（分片校验真的生效）', () => {
    assert.strictEqual(sha256(got), srcSha);
  });
  await t('任务的 filePath 指向真实文件（「打开所在文件夹」才可用）', () => {
    assert.strictEqual(task.filePath, got);
  });

  console.log('\n【5】暂停 / 删除');
  await t('删除任务会清掉 aria2 断点文件', async () => {
    const aria2File = got + '.aria2';
    fs.writeFileSync(aria2File, 'x'); // 造一个残留
    await queue.remove(id);
    assert.ok(!fs.existsSync(aria2File), '.aria2 残留未清理');
    assert.strictEqual(queue.tasks.has(id), false);
  });

  seeder.kill('SIGKILL');
  fileServer.close();
  tracker.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'} — ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e); process.exit(1); });
