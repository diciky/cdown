// CDown - 用 Electron 跑某个脚本的公共包装
//
// 为什么不能直接 `electron scripts/xxx.js`：
//   1) 本环境预设 ELECTRON_RUN_AS_NODE=1，会让 Electron 二进制退化成纯 Node
//      （BrowserWindow / session 全都不存在，报错信息还很难懂）；
//   2) NODE_OPTIONS 里被注入了沙箱的 fs shim，会干扰 Electron 启动；
//   3) macOS 上还必须加 --no-sandbox，否则 Chromium 沙箱初始化失败。
const { spawnSync } = require('child_process');
const path = require('path');

function runElectron(scriptRelPath, extraArgs = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.CODEUDDY_BROKERED_SHELL_ENV;
  delete env.BASH_ENV;

  // 在纯 Node 下 require('electron') 返回的是可执行文件路径
  const bin = require('electron');
  const script = path.isAbsolute(scriptRelPath) ? scriptRelPath : path.join(__dirname, scriptRelPath);
  const r = spawnSync(bin, ['--no-sandbox', script, ...extraArgs], { stdio: 'inherit', env });
  return r.status === 0 ? 0 : (r.status ?? 1);
}

module.exports = { runElectron };

// 直接执行时：node scripts/electron-run.js <脚本路径> [参数…]
if (require.main === module) {
  const [script, ...rest] = process.argv.slice(2);
  if (!script) { console.error('用法: node scripts/electron-run.js <脚本路径> [参数…]'); process.exit(2); }
  process.exit(runElectron(script, rest));
}
