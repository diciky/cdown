// 打包后应用的端到端验证（BT + HTTP）
//
// 目的：验证「装好的 .app」本身能跑通下载，而不是只在源码环境里能跑。
// 重点验证随包分发的 aria2c 能被找到并真正用于 BT 下载 —— 这条路径依赖
// process.resourcesPath，只有在打包后才能验证。
//
// 做法：本地起 tracker + 做种端 + HTTP 文件服务，然后通过应用自带的
// 本地 API（POST /add）投递任务，最后校验落盘文件与 SHA-256。
//
// 用法: node scripts/packaged-e2e.js <CDown.app 路径>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { makePayload, makeTorrent, startTracker, freePort } = require('./bt-testkit');

const APP = process.argv[2] || '/Volumes/000/agent/cdwon/dist/mac-arm64/CDown.app';
const BIN = path.join(APP, 'Contents', 'MacOS', 'CDown');
const ARIA2 = process.env.ARIA2 || '/opt/homebrew/bin/aria2c';
const API_PORT = Number(process.env.API_PORT || 8791);
const SIZE = 3 * 1024 * 1024;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  if (!fs.existsSync(BIN)) { console.error(`找不到可执行文件: ${BIN}`); process.exit(1); }
  console.log(`被测应用: ${APP}`);
  console.log(`可执行文件: ${BIN}\n`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-pkg-'));
  const seedDir = path.join(root, 'seed');
  const leechDir = path.join(root, 'leech');
  const dataDir = path.join(root, 'appdata');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(leechDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // 隔离的应用数据目录：让下载目录落在临时区，绝不碰用户真实的 ~/Downloads
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    downloadDir: leechDir, maxConcurrent: 2, btDht: false, btSeedTime: 0,
    clipboardMonitor: false, serverPort: API_PORT, aria2Bin: ''
  }, null, 2));

  const payload = path.join(seedDir, 'payload.bin');
  makePayload(payload, SIZE);
  const srcSha = sha256(payload);

  const { server: tracker, port: trackerPort } = await startTracker(null, '127.0.0.1');
  const announce = `http://127.0.0.1:${trackerPort}/announce`;
  const { raw, infoHash } = makeTorrent({ file: payload, name: 'payload.bin', announce });
  const torrentPath = path.join(root, 'payload.torrent');
  fs.writeFileSync(torrentPath, raw);

  // 同时提供 .torrent 与一个普通二进制文件，覆盖 BT 与 HTTP 两条路径
  const httpBin = path.join(seedDir, 'plain.bin');
  makePayload(httpBin, 512 * 1024);
  const httpBinSha = sha256(httpBin);
  const fileServer = http.createServer((req, res) => {
    const u = (req.url || '').split('?')[0];
    const map = { '/payload.torrent': [torrentPath, 'application/x-bittorrent'], '/plain.bin': [httpBin, 'application/octet-stream'] };
    const hit = map[u];
    if (!hit) { res.writeHead(404); return res.end(); }
    const b = fs.readFileSync(hit[0]);
    res.writeHead(200, { 'Content-Type': hit[1], 'Content-Length': b.length, 'Accept-Ranges': 'bytes' });
    res.end(b);
  });
  await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
  const fsPort = fileServer.address().port;

  const seedPort = await freePort();
  const seeder = spawn(ARIA2, ['-d', seedDir, torrentPath,
    '--enable-dht=false', '--bt-enable-lpd=false', `--listen-port=${seedPort}`,
    '--check-integrity=true', '--bt-hash-check-seed=true', '--seed-time=600',
    '--bt-tracker=' + announce, '--console-log-level=notice', '--summary-interval=0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let seedOut = '';
  seeder.stdout.on('data', d => { seedOut += d; });
  seeder.stderr.on('data', d => { seedOut += d; });
  let t0 = Date.now();
  while (!/Verification finished successfully/.test(seedOut) && Date.now() - t0 < 20000) await sleep(200);
  console.log(`做种端: ${/Verification finished successfully/.test(seedOut) ? '✅ 校验通过' : '❌ 校验失败'} (infoHash ${infoHash.toString('hex').slice(0, 12)}…, ${SIZE} 字节)\n`);

  // ---- 启动被测应用 ----
  // 注意：本环境预设了 ELECTRON_RUN_AS_NODE=1，会让 Electron 二进制退化成纯 Node，
  // 从而拒绝 --no-sandbox 并报 "bad option"。必须显式移除。
  const appEnv = { ...process.env, TDM_DATA_DIR: dataDir, CDOWN_DISABLE_GPU: '1' };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.NODE_OPTIONS;
  const app = spawn(BIN, ['--no-sandbox'], {
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appOut = '';
  app.stdout.on('data', d => { appOut += d; });
  app.stderr.on('data', d => { appOut += d; });

  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    if (ok) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}${extra ? '\n     ' + extra : ''}`); fail++; }
  };

  // 等本地 API 起来
  let up = false;
  t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const r = await new Promise((res, rej) => {
        const rq = http.get({ host: '127.0.0.1', port: API_PORT, path: '/status', timeout: 1000 }, x => {
          let b = ''; x.on('data', c => { b += c; }); x.on('end', () => res(b));
        });
        rq.on('error', rej); rq.on('timeout', () => { rq.destroy(); rej(new Error('timeout')); });
      });
      const j = JSON.parse(r);
      if (j.ok) { up = true; console.log(`应用已启动，本地 API 报告版本 v${j.version}\n`); break; }
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  check('打包后的应用能启动并监听本地 API', up, appOut.slice(-600));
  if (!up) { app.kill('SIGKILL'); seeder.kill('SIGKILL'); fileServer.close(); tracker.close(); process.exit(1); }

  // ---- 投递任务 ----
  console.log('\n【1】HTTP 直链下载');
  await postJson(API_PORT, '/add', { url: `http://127.0.0.1:${fsPort}/plain.bin`, threads: 4 });
  t0 = Date.now();
  const httpOut = path.join(leechDir, 'plain.bin');
  while (!fs.existsSync(httpOut) && Date.now() - t0 < 30000) await sleep(300);
  check('HTTP 文件落盘且内容一致', fs.existsSync(httpOut) && sha256(httpOut) === httpBinSha);

  console.log('\n【2】BT 下载（.torrent，走随包 aria2c）');
  await postJson(API_PORT, '/add', { url: `http://127.0.0.1:${fsPort}/payload.torrent` });
  const btOut = path.join(leechDir, 'payload.bin');
  // 不能只等「文件存在」：aria2 会先预分配出完整大小的文件再填充内容，
  // 此时读到的是一堆 0，SHA 必然不一致。必须等任务真正走到 completed。
  const readTasks = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8')); } catch { return []; } };
  t0 = Date.now();
  let btTaskRec = null;
  while (Date.now() - t0 < 90000) {
    btTaskRec = readTasks().find(x => x.type === 'bt') || null;
    if (btTaskRec && (btTaskRec.status === 'completed' || btTaskRec.status === 'error')) break;
    await sleep(500);
  }
  check('BT 任务完成（非报错）', !!btTaskRec && btTaskRec.status === 'completed',
    btTaskRec ? `状态: ${btTaskRec.status}${btTaskRec.error ? ' / ' + btTaskRec.error : ''}` : '未找到 bt 任务');
  check('BT 文件落盘且大小正确', fs.existsSync(btOut) && fs.statSync(btOut).size === SIZE,
    `目录内容: ${fs.readdirSync(leechDir).join(', ')}`);
  check('BT 内容与源文件 SHA-256 一致（分片校验生效）', fs.existsSync(btOut) && sha256(btOut) === srcSha);
  check('bt 任务的 filePath 指向真实文件（「打开所在文件夹」才可用）',
    !!btTaskRec && btTaskRec.filePath === btOut, btTaskRec ? `记录: ${btTaskRec.filePath}` : '');

  app.kill('SIGKILL');
  seeder.kill('SIGKILL');
  fileServer.close();
  tracker.close();
  await sleep(500);
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'} — ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e); process.exit(1); });
