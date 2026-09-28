// CDown - 抖音真实端到端探针入口（打真实抖音，需要联网）
const { runElectron } = require('./electron-run');
process.exit(runElectron('douyin-e2e.js'));
