// CDown - 统一测试入口
// 依次跑所有回归套件，任一失败则整体失败。
// 用法: npm test   （或 node scripts/test-all.js）
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SUITES = [
  ['引擎回归（HTTP Range / 无 Content-Length / HLS 失败处理）', 'mac-regression.js'],
  ['打开所在文件夹与文件命名', 'reveal-naming-test.js'],
  ['BT 本地链路（tracker + 做种 + 下载）', 'bt-local-test.js'],
  ['BT 全链路集成（经 queue + aria2c）', 'bt-queue-test.js']
];

// 打包版验证依赖构建产物，存在才跑（源码环境下跳过）
const PACKAGED = path.join(__dirname, '..', 'dist', 'mac-arm64', 'CDown.app');
if (fs.existsSync(PACKAGED)) {
  SUITES.push(['打包应用端到端（HTTP + BT，走随包 aria2c）', 'packaged-e2e.js']);
} else {
  console.log(`（跳过打包版验证：未找到 ${PACKAGED}，先执行 npm run dist:mac:unsigned）`);
}

const node = process.execPath;
let failed = 0;
const results = [];

for (const [label, file] of SUITES) {
  console.log(`\n${'='.repeat(66)}\n▶ ${label}\n  ${file}\n${'='.repeat(66)}`);
  const r = spawnSync(node, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: process.env
  });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push([ok, label, r.status]);
}

console.log(`\n${'='.repeat(66)}\n汇总\n${'='.repeat(66)}`);
for (const [ok, label, code] of results) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  (退出码 ${code})`}`);
}
console.log(`\n${failed === 0 ? '✅ 全部套件通过' : `❌ ${failed} 个套件失败`}`);
process.exit(failed === 0 ? 0 : 1);
