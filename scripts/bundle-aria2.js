// 把 aria2c 及其非系统动态库打包进 bin/aria2/，使应用无需用户预装 aria2 即可下载 BT。
//
// 为什么不能直接 cp：
//   Homebrew 的 aria2c 链接了 /opt/homebrew/opt/* 下的 6 个库，直接拷进 .app 后
//   在用户机器上必然 dyld 报错。所以必须：
//     1) 递归收集非系统依赖；
//     2) 拷贝到达一个自洽的目录结构；
//     3) 用 install_name_tool 把绝对路径改成 @executable_path / @loader_path 相对引用；
//     4) **重新做 ad-hoc 签名** —— Apple Silicon 上任何 Mach-O 被修改后签名即失效，
//        未签名的二进制会被内核直接拒绝执行（报 "killed"）。
//
// 用法: node scripts/bundle-aria2.js [aria2c路径]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = process.argv[2] || '/opt/homebrew/bin/aria2c';
const OUT = path.join(__dirname, '..', 'bin', 'aria2');
const LIBDIR = path.join(OUT, 'lib');
const IS_SYSTEM = p => p.startsWith('/usr/lib/') || p.startsWith('/System/');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();
}
function depsOf(file) {
  try {
    return sh(`otool -L "${file}"`).split('\n').slice(1)
      .map(l => l.trim().split(' (')[0].trim())
      .filter(p => p && !p.startsWith('@') && !IS_SYSTEM(p));
  } catch { return []; }
}
function realPath(p) { try { return sh(`readlink -f "${p}"`).trim(); } catch { return p; } }
function sign(file) {
  // 先移除可能存在的旧签名，再 ad-hoc 重签，避免 "code signature invalid"
  try { sh(`codesign --remove-signature "${file}" 2>/dev/null`); } catch { /* 本来就没签名 */ }
  sh(`codesign --force --sign - "${file}"`);
}

// ---- 1. 递归收集依赖闭包 ----
const collected = new Map(); // 基名 -> 真实文件路径
const queue = [realPath(SRC)];
const seen = new Set();
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  for (const d of depsOf(f)) {
    const real = realPath(d);
    collected.set(path.basename(real), real);
    queue.push(real);
  }
}
console.log(`收集到 ${collected.size} 个非系统动态库：`);
for (const [n, p] of collected) console.log(`  ${n}  ←  ${p}`);

// ---- 2. 拷贝 ----
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(LIBDIR, { recursive: true });
const binName = path.basename(SRC);
const outBin = path.join(OUT, binName);
fs.copyFileSync(realPath(SRC), outBin);
fs.chmodSync(outBin, 0o755);
for (const [name, src] of collected) {
  const dst = path.join(LIBDIR, name);
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
}

// ---- 3. 重写 install name ----
// 可执行文件引用库 → @executable_path/lib/<name>（executable_path = bin/aria2/）
// 库引用库       → @loader_path/<name>        （loader_path = bin/aria2/lib/）
function rewrite(file, replacer) {
  const args = depsOf(file)
    .map(d => {
      const base = path.basename(realPath(d));
      if (!collected.has(base)) return null;
      const target = replacer(base);
      if (target === d) return null;
      return `-change "${d}" "${target}"`;
    })
    .filter(Boolean);
  if (args.length) sh(`install_name_tool ${args.join(' ')} "${file}"`);
  return args.length;
}

let changed = rewrite(outBin, b => `@executable_path/lib/${b}`);
console.log(`\naria2c: 改写 ${changed} 个依赖引用`);

let totalChanged = changed;
for (const [name] of collected) {
  const f = path.join(LIBDIR, name);
  // 库自身的 install name 也要改，否则别的库按绝对路径找它
  try { sh(`install_name_tool -id "@loader_path/${name}" "${f}"`); } catch { /* 无 id 的库 */ }
  totalChanged += rewrite(f, b => `@loader_path/${b}`);
}
console.log(`库: 共改写 ${totalChanged - changed} 个依赖引用`);

// ---- 4. 重签 ----
// 顺序：先签所有库，再签可执行文件（可执行文件依赖的签名必须已就绪）
for (const [name] of collected) sign(path.join(LIBDIR, name));
sign(outBin);
console.log('已完成 ad-hoc 签名');

// ---- 5. 校验 ----
console.log('\n--- 校验：不应再出现 /opt/homebrew ---');
let bad = 0;
for (const f of [outBin, ...[...collected.keys()].map(n => path.join(LIBDIR, n))]) {
  const left = sh(`otool -L "${f}"`).split('\n').slice(1).map(l => l.trim().split(' (')[0])
    .filter(p => (p.startsWith('/opt/homebrew') || p.startsWith('/usr/local')));
  if (left.length) { console.log(`  ✗ ${path.basename(f)} 仍引用: ${left.join(', ')}`); bad += left.length; }
}
console.log(bad === 0 ? '  ✓ 全部为相对引用或系统库' : `  ✗ 还有 ${bad} 处绝对引用`);

console.log('\n--- 校验：实际执行 ---');
try {
  const v = sh(`"${outBin}" --version | head -1`);
  console.log(`  ✓ ${v.trim()}`);
  const bt = sh(`"${outBin}" --version | grep -o BitTorrent`);
  console.log(`  ✓ 编译特性包含 ${bt.trim()}`);
} catch (e) {
  console.log(`  ✗ 执行失败: ${e.message}`);
  console.log(e.stderr ? e.stderr.toString().slice(0, 400) : '');
  process.exit(1);
}

const du = sh(`du -sh "${OUT}"`).split('\t')[0];
console.log(`\n产物: ${OUT}  (${du})`);
process.exit(bad === 0 ? 0 : 1);
