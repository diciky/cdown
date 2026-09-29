// CDown - 界面渲染冒烟测试入口（test-all.js 以纯 node 调用本文件）
const { runElectron } = require('./electron-run');
process.exit(runElectron('ui-shot.js'));
