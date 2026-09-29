// 诊断脚本：定位「本机双 aria2 实例互传失败」的根因。
//
// 核心待验证假设：aria2 会过滤掉「属于本机网络接口」的 peer 地址（防自连），
// 因此 tracker 广播本机 LAN IP（192.168.1.x）或 127.0.0.1 时，
// 两个实例永远连不上 —— 这与代码无关，纯属测试环境构造问题。
//
// 判定方法：让 tracker 广播一个「非本机」的可路由地址（10.99.99.99），
// 看 aria2 是否仍然打印 "Not considered"。若不打印，则假设成立。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { makePayload, makeTorrent, startTracker } = require('./bt-testkit');

const ARIA2 = process.env.ARIA2 || '/opt/homebrew/bin/aria2c';
const SIZE = 2 * 1024 * 1024;

function localAddrs() {
  const out = ['127.0.0.1'];
  for (const n of Object.keys(os.networkInterfaces())) {
    for (const ni of os.networkInterfaces()[n] || []) if (ni.family === 'IPv4') out.push(ni.address);
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCase(label, advertiseIP) {
  console.log(`\n${'='.repeat(70)}\n案例：${label}  (tracker 广播 ${advertiseIP})\n${'='.repeat(70)}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-diag-'));
  const seedDir = path.join(root, 'seed');
  const leechDir = path.join(root, 'leech');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(leechDir, { recursive: true });
  const payload = path.join(seedDir, 'payload.bin');
  makePayload(payload, SIZE);

  const announces = [];
  const { server, port: trackerPort } = await startTracker(a => announces.push(a), advertiseIP);
  const announce = `http://127.0.0.1:${trackerPort}/announce`;
  const { raw, infoHash } = makeTorrent({ file: payload, name: 'payload.bin', announce });
  const torrentPath = path.join(root, 'payload.torrent');
  fs.writeFileSync(torrentPath, raw);

  const common = ['--enable-dht=false', '--bt-tracker=' + announce, '--seed-time=0', '--bt-max-peers=10'];

  // ---- 做种端：真实监听 55555，并强制 --bt-external-ip 让 tracker 收到期望地址 ----
  const seeder = spawn(ARIA2, [
    '-d', seedDir, torrentPath, ...common,
    '--listen-port=55555', '--seed-time=600',
    '--check-integrity=true',
    '--console-log-level=info', '--summary-interval=0', '--log-level=info'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let seedOut = '';
  seeder.stdout.on('data', d => { seedOut += d; });
  seeder.stderr.on('data', d => { seedOut += d; });
  await sleep(6000);

  // 做种端到底监听在哪个端口？
  const { execSync } = require('child_process');
  let listening = '';
  try {
    const pid = seeder.pid;
    listening = execSync(`lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null || true`).toString().trim();
  } catch { /* ignore */ }
  console.log(`做种端 PID=${seeder.pid} 监听:\n${listening || '  (lsof 无输出)'}`);
  console.log(`tracker 收到的 announce: ${JSON.stringify(announces)}`);

  // ---- 下载端 ----
  const leecher = spawn(ARIA2, [
    '-d', leechDir, torrentPath, ...common,
    '--listen-port=55556',
    '--summary-interval=1', '--console-log-level=info', '--log-level=info'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let leechOut = '';
  leecher.stdout.on('data', d => { leechOut += d; });
  leecher.stderr.on('data', d => { leechOut += d; });
  await sleep(15000);
  leecher.kill('SIGKILL');
  seeder.kill('SIGKILL');
  await sleep(500);
  server.close();

  const got = path.join(leechDir, 'payload.bin');
  const gotSize = fs.existsSync(got) ? fs.statSync(got).size : 0;

  const notConsidered = [...new Set((leechOut.match(/Not considered: [\d.]+/g) || []))];
  const progressLines = [...new Set((leechOut.match(/\[#[0-9a-f]+ [^\]]*\]/g) || []))].slice(-4);

  console.log(`\n下载端最终: ${gotSize}/${SIZE} 字节  完整=${gotSize === SIZE}`);
  console.log(`下载端进度行:\n  ${progressLines.join('\n  ') || '(无)'}`);
  console.log(`"Not considered" 命中: ${notConsidered.length ? notConsidered.join(', ') : '无'}`);
  const handshake = (leechOut.match(/handshake peerId=[^,]*/g) || []).length;
  console.log(`握手尝试次数: ${handshake}`);

  const relevant = leechOut.split('\n').filter(l => /Not considered|handshake|No peers|tracker|Announce|rejected|drop/i.test(l)).slice(0, 12);
  console.log(`下载端关键日志:\n  ${relevant.join('\n  ') || '(无)'}`);
  return { advertiseIP, notConsidered, gotSize, complete: gotSize === SIZE };
}

(async () => {
  console.log(`本机地址: ${localAddrs().join(', ')}`);
  const results = [];
  // 案例 A：广播本机 LAN IP（之前失败的配置）
  results.push(await runCase('广播本机 LAN IP', localAddrs().find(a => a !== '127.0.0.1')));
  // 案例 B：广播非本机地址 —— 若 aria2 不再打印 "Not considered"，则证实是「本地地址过滤」
  results.push(await runCase('广播非本机地址（判定用）', '10.99.99.99'));

  console.log(`\n${'='.repeat(70)}\n结论\n${'='.repeat(70)}`);
  for (const r of results) {
    console.log(`广播 ${r.advertiseIP.padEnd(15)} -> 传输 ${r.gotSize}/${SIZE} 字节, Not considered: ${r.notConsidered.length ? r.notConsidered.join(',') : '无'}`);
  }
  process.exit(0);
})();
