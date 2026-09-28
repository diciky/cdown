// CDown - 「打开所在文件夹」与文件命名 回归测试
//
// 覆盖两个用户实际报过的问题：
//   1) 任务成功后点「打开所在文件夹」没有反应 —— 根因是 shell.showItemInFolder()
//      对不存在的路径静默失败，而任务记录的路径与磁盘真实文件经常不一致。
//   2) HLS 合并产物是 MP4，却沿用了 .m3u8 扩展名，导致记录路径永久对不上。
// 另外覆盖文件名按字节截断（中文文件名按字符截断会超出 255 字节上限）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { resolveRevealTarget } = require('../src/main/reveal');
const { filenameFromUrl, classify } = require('../src/engine/queue');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-reveal-'));

  console.log('\n【1】打开所在文件夹 —— 路径解析降级链');

  await t('文件存在 → 精确选中', async () => {
    const f = path.join(root, 'a.mp4');
    fs.writeFileSync(f, 'x');
    const r = await resolveRevealTarget(f);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'select');
    assert.strictEqual(r.path, f);
  });

  await t('记录是 .m3u8、真实文件是 .mp4 → 自动纠正并选中', async () => {
    const real = path.join(root, 'b.mp4');
    fs.writeFileSync(real, 'x');
    const r = await resolveRevealTarget(path.join(root, 'b.m3u8'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, real);
    assert.match(r.note, /已定位到 b\.mp4/);
  });

  await t('记录是 .mp4、真实文件是 .mkv（yt-dlp 自选容器）→ 自动纠正', async () => {
    const real = path.join(root, 'c.mkv');
    fs.writeFileSync(real, 'x');
    const r = await resolveRevealTarget(path.join(root, 'c.mp4'));
    assert.strictEqual(r.path, real);
  });

  await t('文件名被截断 → 按前缀找回', async () => {
    const long = 'RTdujgB6owlgBGeeKqKqeIByTN6hbWRttl6ZiHrnvCKLtKqL4Tz2zDTkLktHdKhyFje22HF';
    const real = path.join(root, long.slice(0, 20) + '_truncated.mp4');
    fs.writeFileSync(real, 'x');
    const r = await resolveRevealTarget(path.join(root, long + '.m3u8'));
    assert.strictEqual(r.path, real);
  });

  await t('前缀匹配不会误命中 CDown 的中间产物', async () => {
    const stem = 'abcdefghijklmnopqrstuvwx';
    // 只留一个 .hlsmeta.json（中间产物）和真正的产物
    fs.writeFileSync(path.join(root, stem + '.hlsmeta.json'), '{}');
    const real = path.join(root, stem + '.mp4');
    fs.writeFileSync(real, 'x');
    const r = await resolveRevealTarget(path.join(root, stem + '.m3u8'));
    assert.strictEqual(r.path, real);
  });

  await t('文件全没了但目录在 → 打开目录并说明', async () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const r = await resolveRevealTarget(path.join(sub, 'gone.mp4'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'open-dir');
    assert.strictEqual(r.path, sub);
    assert.match(r.note, /原文件已不在/);
  });

  await t('目录也不存在 → 返回明确错误（不再静默）', async () => {
    const r = await resolveRevealTarget(path.join(root, 'nope', 'gone.mp4'));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /文件不存在/);
  });

  await t('空路径 → 返回明确错误', async () => {
    assert.strictEqual((await resolveRevealTarget('')).ok, false);
    assert.strictEqual((await resolveRevealTarget(null)).ok, false);
  });

  console.log('\n【2】HLS 产物命名 —— 扩展名必须是 .mp4');

  await t('m3u8 URL → .mp4', () => {
    const u = 'https://cdn.example.com/api/vid/h5/m3u8/JHA-209/tk1/ABCDEF123456.m3u8?token=xyz';
    const n = filenameFromUrl(u, 'hls');
    assert.ok(n.endsWith('.mp4'), `期望 .mp4，实际 ${n}`);
    assert.ok(!n.includes('?'), '不应带 query');
  });

  await t('普通直链 → 保留原扩展名', () => {
    assert.strictEqual(filenameFromUrl('https://a.com/b/c.zip', 'http'), 'c.zip');
  });

  await t('无扩展名的 HLS → 补 .mp4', () => {
    assert.ok(filenameFromUrl('https://a.com/live/stream', 'hls').endsWith('.mp4'));
  });

  await t('classify 能把 m3u8 判成 hls（含 query 形式）', () => {
    assert.strictEqual(classify('https://a.com/x.m3u8'), 'hls');
    assert.strictEqual(classify('https://a.com/play?fmt=m3u8&t=1'), 'hls');
  });

  console.log('\n【3】文件名长度 —— 按字节截断，避免 ENAMETOOLONG');

  await t('超长中文名被压到 255 字节以内且保留扩展名', () => {
    const n = filenameFromUrl('https://a.com/' + encodeURIComponent('测试'.repeat(120)) + '.zip', 'http');
    assert.ok(Buffer.byteLength(n, 'utf8') <= 255, `实际 ${Buffer.byteLength(n, 'utf8')} 字节`);
    assert.ok(n.endsWith('.zip'), '扩展名必须保留');
    assert.ok(!n.includes('\ufffd'), '不应出现替换字符（说明多字节字符被截断）');
  });

  await t('超长 hash 名被截断', () => {
    const n = filenameFromUrl('https://a.com/' + 'a'.repeat(300) + '.mp4', 'http');
    assert.ok(Buffer.byteLength(n, 'utf8') <= 255);
    assert.ok(n.endsWith('.mp4'));
  });

  await t('正常短名不被改动', () => {
    assert.strictEqual(filenameFromUrl('https://a.com/setup.dmg', 'http'), 'setup.dmg');
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'} — ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
