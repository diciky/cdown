// TDM Fast - 引擎独立冒烟测试（无需 Electron）
// 用法: node scripts/engine-cli.js <url> [--threads 16] [--out <dir>] [--pause-after 3]
const { HttpDownloader } = require('../src/engine/downloader');
const config = require('../src/engine/config');
const path = require('path');

const args = process.argv.slice(2);
const url = args[0];
if (!url) { console.log('用法: node scripts/engine-cli.js <url> [--threads 16] [--out dir] [--pause-after 秒]'); process.exit(1); }

function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const threads = Number(argOf('--threads', 16));
const outDir = argOf('--out', config.load().downloadDir);
const pauseAfter = Number(argOf('--pause-after', 0));

(async () => {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download.bin');
  const filePath = path.join(outDir, name);
  console.log(`▶ 下载: ${url}\n  -> ${filePath}\n  线程: ${threads}\n`);

  const d = new HttpDownloader({ id: 1, url, filePath, threads });
  d.on('progress', s => {
    process.stdout.write(`\r  ${s.progress}%  ${s.sizeText}  ${s.speedText}  活跃线程 ${s.activeThreads}/${s.segments}   `);
    if (pauseAfter > 0 && Date.now() - t0 > pauseAfter * 1000 && !d._testPaused) {
      d._testPaused = true;
      console.log('\n⏸ 测试断点续传：暂停 2 秒后恢复…');
      d.pause();
      setTimeout(() => d.start(), 2000);
    }
  });
  d.on('done', s => { console.log(`\n\n✔ 完成: ${s.filePath} (${s.sizeText})`); process.exit(0); });
  d.on('error', s => { console.error(`\n\n✖ 出错: ${s.error}`); process.exit(1); });

  const t0 = Date.now();
  await d.start();
})();
