// 不稳定网络下的引擎测试：A=随机断流应自动重试完成；B=持续故障应快速整体失败并停止所有线程
const { HttpDownloader } = require('../src/engine/downloader');
const fs = require('fs');

const BASE = 'C:/Users/Administrator/WorkBuddy/2026-09-26-18-52-30/tdm-fast';
const ORIGIN = fs.readFileSync(BASE + '/scripts/testfile.bin');

async function testA() {
  return new Promise(resolve => {
    const d = new HttpDownloader({ id: 1, url: 'http://127.0.0.1:18766/testfile.bin', filePath: BASE + '/data/downloads/flaky-a.bin', threads: 8 });
    d.on('done', () => {
      const a = fs.readFileSync(BASE + '/data/downloads/flaky-a.bin');
      const retries = d.logs.filter(l => l.includes('重试')).length;
      console.log(`测试A(随机断流25%): 完成 | 触发重试 ${retries} 次 | 一致性: ${a.equals(ORIGIN) ? 'PASS ✔' : 'FAIL ✘'}`);
      fs.rmSync(BASE + '/data/downloads/flaky-a.bin', { force: true });
      resolve();
    });
    d.on('error', s => { console.log('测试A日志尾部:\n' + d.logs.slice(-6).join('\n')); console.log(`测试A: FAIL ✘ (${s.error})`); resolve(); });
    d.start();
  });
}

async function testB() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const d = new HttpDownloader({ id: 2, url: 'http://127.0.0.1:18766/testfile.bin', filePath: BASE + '/data/downloads/flaky-b.bin', threads: 8 });
    d.on('error', s => {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`测试B(持续故障): 报错状态 ✔ | 耗时 ${dt}s | 残留活动线程: ${s.activeThreads}（应为0）| 错误信息: ${s.error}`);
      console.log(`   线程是否全部停止: ${s.activeThreads === 0 ? 'PASS ✔' : 'FAIL ✘'}`);
      fs.rmSync(BASE + '/data/downloads/flaky-b.bin.part', { force: true });
      resolve();
    });
    d.on('done', () => { console.log('测试B: 意外完成（FAIL ✘）'); resolve(); });
    d.start();
  });
}

(async () => {
  console.log('—— 测试A：25% 随机断流 ——');
  await testA();
  console.log('—— 测试B：部分分段持续故障 ——');
  await testB();
  process.exit(0);
})();
