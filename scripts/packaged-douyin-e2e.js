// CDown - 打包版抖音端到端验证
//
// 这是交付前的最后一道关：不是跑源码，而是启动**真正要发给用户的那个 .app**，
// 通过它的本地 API 添加一条真实抖音链接，然后盯任务记录直到落盘。
// 它能同时证明三件事：
//   1) 抖音模块被打进了 asar（不是只有源码目录里能跑）；
//   2) 打包版里隐藏 BrowserWindow 的验证挑战能跑（sandbox / 分区都正常）；
//   3) 队列 → 解析 → 多线程下载 在打包环境下链路完整。
//
// 运行: node scripts/packaged-douyin-e2e.js
// 前置: npm run dist:mac:unsigned
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..', 'dist', 'mac-arm64', 'CDown.app');
const BIN = path.join(APP, 'Contents', 'MacOS', 'CDown');
const PORT = Number(process.env.CDOWN_PORT || 8791);
const DOUYIN_URL = process.env.DOUYIN_URL || 'https://www.douyin.com/video/6961737553342991651';
// 长视频的 1080P 有 800MB+，验证链路没必要下这么大；用环境变量指定一档小的
const QUALITY = process.env.DOUYIN_QUALITY || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}
function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end(data);
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  cond ? pass++ : fail++;
};

(async () => {
  if (!fs.existsSync(BIN)) {
    console.error(`❌ 未找到打包产物: ${BIN}\n   先执行 npm run dist:mac:unsigned`);
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-pkg-dy-'));
  const dataDir = path.join(root, 'data');
  const dlDir = path.join(root, 'dl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });
  // 预置配置：把下载目录指向临时目录，别污染用户真实的 ~/Downloads
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    downloadDir: dlDir, maxThreads: 8, maxConcurrent: 1, serverPort: PORT, clipboardMonitor: false,
    ...(QUALITY ? { douyinQuality: QUALITY } : {})
  }, null, 2));

  const appEnv = { ...process.env, TDM_DATA_DIR: dataDir };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.NODE_OPTIONS;
  delete appEnv.CODEUDDY_BROKERED_SHELL_ENV;
  delete appEnv.BASH_ENV;

  console.log(`被测应用: ${APP}`);
  console.log(`抖音链接: ${DOUYIN_URL}`);
  console.log(`清晰度  : ${QUALITY || '（全局默认 best）'}\n`);

  const app = spawn(BIN, ['--no-sandbox'], { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const appLog = [];
  app.stdout.on('data', d => appLog.push(String(d)));
  app.stderr.on('data', d => appLog.push(String(d)));

  let exited = false;
  app.on('exit', () => { exited = true; });

  try {
    // 等本地 API 起来
    let version = null;
    for (let i = 0; i < 40 && !version; i++) {
      await sleep(500);
      if (exited) break;
      try { version = JSON.parse((await get(`http://127.0.0.1:${PORT}/status`)).body).version; } catch { /* 还没起来 */ }
    }
    check('打包应用启动并监听本地 API', !!version, version ? `v${version}` : appLog.join('').slice(-300));
    if (!version) throw new Error('应用未能启动');

    console.log('\n【1】通过本地 API 添加抖音任务（这一步会跑抖音的 JS 验证挑战）');
    const t0 = Date.now();
    const r = await post(`http://127.0.0.1:${PORT}/add`, { url: DOUYIN_URL });
    const added = JSON.parse(r.body);
    check('API 接受抖音链接并建出任务', r.status === 200 && added.ok === true, r.body.slice(0, 200));
    if (!added.ok) throw new Error('添加失败');

    console.log('\n【2】盯任务记录直到落盘');
    const tasksFile = path.join(dataDir, 'tasks.json');
    let task = null;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const arr = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        task = arr.find(t => t.id === added.id) || null;
      } catch { /* 还没写 */ }
      if (task && (task.status === 'completed' || task.status === 'error')) break;
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`\r  已等待 ${secs}s  状态: ${task ? task.status : '排队中'}          `);
    }
    process.stdout.write('\r');

    check('任务状态为已完成', task && task.status === 'completed', task ? (task.error || task.status) : '无记录');
    if (!task || task.status !== 'completed') throw new Error('下载未完成');

    check('任务被标记为 douyin（界面显示抖音标签）', task.kind === 'douyin', String(task.kind));
    check('来源记为抖音', task.source === '抖音', String(task.source));
    check('解析出的清晰度被持久化', !!task.quality || !!(task.meta && task.meta.quality), JSON.stringify(task.meta || {}).slice(0, 120));
    check('作者写进了任务记录', !!(task.meta && task.meta.author), task.meta && task.meta.author);

    const st = fs.statSync(task.filePath);
    check('文件落盘且非空', st.size > 0, `${(st.size / 1024 / 1024).toFixed(2)} MB`);
    check('文件名是「作者 - 文案.mp4」', / - .+\.mp4$/.test(path.basename(task.filePath)), path.basename(task.filePath));

    const head = Buffer.alloc(12);
    const fd = fs.openSync(task.filePath, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    check('文件头是合法 MP4（不是错误页）', head.subarray(4, 8).toString('latin1') === 'ftyp', head.toString('hex'));

    console.log(`\n  落盘: ${task.filePath}`);
    console.log(`  耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`\n  ⚠ ${e.message}`);
  } finally {
    app.kill('SIGTERM');
    await sleep(800);
    if (!exited) app.kill('SIGKILL');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(fail === 0 ? `  ✅ 打包版抖音下载通过 — ${pass} 项` : `  ❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  console.log(`${'='.repeat(56)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
