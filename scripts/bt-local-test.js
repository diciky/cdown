// CDown - BitTorrent 本地端到端测试（全离线、确定性）
//
// 链路：Node tracker（BEP-3 announce） + aria2c 做种 + aria2c 下载 → 校验字节一致。
// 同时把 aria2 的进度行格式打出来，作为进度解析器的规格依据。
//
// 踩过的坑（写在这里避免后人重踩）：
//   1) 端口必须动态申请。本沙箱对个别端口（实测 55555）恒返回 EADDRINUSE，
//      即使 lsof 查不到任何占用 —— 硬编码端口会产生"绑定失败 → 不监听 →
//      下载端 0 字节"的假故障，且报错信息完全不指向真因。
//   2) tracker 解析 query 必须 charCodeAt(j)，写成 charCodeAt(0) 会把
//      port=51413 解析成 55555。
//   3) 做种端必须等校验完成（"Verification finished successfully"）再起下载端。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { makePayload, makeTorrent, startTracker, freePort } = require('./bt-testkit');

const ARIA2 = process.env.ARIA2 || '/opt/homebrew/bin/aria2c';
const SIZE = 4 * 1024 * 1024;
const LOG_DIR = process.env.BT_LOG_DIR || '/tmp';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

function spawnAria(args) {
  const p = spawn(ARIA2, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', d => { p.out += d; });
  p.stderr.on('data', d => { p.out += d; });
  return p;
}

// 等到 aria2 打印某段文字，或超时
async function waitFor(proc, re, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(proc.out)) return true;
    await sleep(250);
  }
  console.log(`  ! 等待「${label}」超时（${timeoutMs}ms）`);
  return false;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-bt-'));
  const seedDir = path.join(root, 'seed');
  const leechDir = path.join(root, 'leech');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(leechDir, { recursive: true });

  const payload = path.join(seedDir, 'payload.bin');
  makePayload(payload, SIZE);
  const srcSha = sha256(payload);

  const announces = [];
  const { server, port: trackerPort } = await startTracker(a => announces.push(a), '127.0.0.1');
  const announce = `http://127.0.0.1:${trackerPort}/announce`;
  const { raw, infoHash } = makeTorrent({ file: payload, name: 'payload.bin', announce });
  const torrentPath = path.join(root, 'payload.torrent');
  fs.writeFileSync(torrentPath, raw);

  const seedPort = await freePort();
  const leechPort = await freePort();
  console.log(`测试目录 : ${root}`);
  console.log(`infoHash : ${infoHash.toString('hex')}`);
  console.log(`tracker  : ${announce}`);
  console.log(`做种端口 : ${seedPort}   下载端口: ${leechPort}   文件: ${SIZE} 字节`);
  console.log(`源文件SHA: ${srcSha}`);

  // ---------- 1. 做种端 ----------
  // 注意选项名：aria2 对「未知选项」是立即退出，不会警告后继续。
  // 例如写成 --enable-lpd 而不是 --bt-enable-lpd，进程会直接死掉，
  // 表现为「不校验、不监听、不 announce」，极难从现象反推原因。
  const seeder = spawnAria([
    '-d', seedDir, torrentPath,
    '--enable-dht=false', '--bt-enable-lpd=false',
    `--listen-port=${seedPort}`,
    '--check-integrity=true', '--bt-hash-check-seed=true',
    '--seed-time=600', '--bt-tracker=' + announce,
    '--console-log-level=notice', '--summary-interval=0'
  ]);
  const badOpt = /unrecognized option/i.exec(seeder.out);
  const okSeed = await waitFor(seeder, /Verification finished successfully/, 20000, '做种端校验完成');
  const bindErr = /failed to bind TCP port/.test(seeder.out);
  let listening = '';
  try { listening = execSync(`lsof -nP -a -p ${seeder.pid} -iTCP -sTCP:LISTEN 2>/dev/null || true`).toString().trim(); } catch { /* ignore */ }
  console.log(`\n做种端: 校验通过=${okSeed} 绑定失败=${bindErr} 监听端口=${listening ? listening.split('\n').slice(1).map(l => l.split(/\s+/)[8]).join(',') : '(无)'}`);
  if (badOpt) {
    console.log(`  ⚠ 未知选项，aria2 已直接退出: ${badOpt[0]}`);
    console.log('  ' + seeder.out.split('\n').slice(0, 3).join('\n  '));
  }
  if (bindErr) {
    console.log('  做种端原始错误:');
    console.log('  ' + seeder.out.split('\n').filter(l => /ERROR|Exception/.test(l)).slice(0, 4).join('\n  '));
  }
  await sleep(3000); // 等 announce 上报完成态

  // ---------- 2. 下载端 ----------
  const leecher = spawnAria([
    '-d', leechDir, torrentPath,
    '--enable-dht=false', '--bt-enable-lpd=false',
    `--listen-port=${leechPort}`,
    '--seed-time=0', '--bt-tracker=' + announce,
    '--summary-interval=1', '--console-log-level=info'
  ]);

  const t0 = Date.now();
  let lastLine = '';
  while (Date.now() - t0 < 60000) {
    const m = leecher.out.match(/\[#[0-9a-f]+ [^\]]*\]/g);
    if (m) lastLine = m[m.length - 1];
    if (/Download complete|download completed/i.test(leecher.out)) break;
    await sleep(500);
  }
  leecher.kill('SIGKILL');
  seeder.kill('SIGKILL');
  await sleep(300);
  server.close();

  fs.writeFileSync(path.join(LOG_DIR, 'cdown-bt-leech.log'), leecher.out);

  // ---------- 3. 校验 ----------
  const got = path.join(leechDir, 'payload.bin');
  const gotSize = fs.existsSync(got) ? fs.statSync(got).size : 0;
  const gotSha = gotSize === SIZE ? sha256(got) : '(未完整下载)';

  console.log(`\n下载端进度行样本: ${lastLine || '(无)'}`);
  console.log(`tracker 收到 announce ${announces.length} 次；最后一次: ${JSON.stringify(announces[announces.length - 1] || null)}`);
  console.log(`\n结果: ${gotSize}/${SIZE} 字节`);
  console.log(`SHA 一致: ${gotSha === srcSha}  (${gotSha.slice(0, 16)}…)`);

  const pass = gotSize === SIZE && gotSha === srcSha;
  console.log(`\n${pass ? '✅ 通过' : '❌ 失败'} — 本地 BT 链路`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('异常:', e); process.exit(1); });
