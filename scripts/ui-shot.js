// CDown - 界面渲染冒烟测试（抖音解析弹窗 + 任务卡片）
//
// 为什么需要它：抖音弹窗的样式要压过 `.modal-body label`（优先级 0,1,1），
// 这类「样式没生效」的问题在代码里看不出来，必须真的渲染一次并截图。
// 用一个假 preload 顶掉真实 IPC，加载真实的 index.html / style.css / app.js，
// 然后驱动界面并截图到 dist/ui-shot/。
//
// 运行:
//   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron --no-sandbox scripts/ui-shot.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'ui-shot');
app.commandLine.appendSwitch('disable-gpu');

const FAKE_TASKS = [
  {
    id: 1, kind: 'douyin', source: '抖音', status: 'downloading', filename: '杨超越 - #杨超越  小小水手带你去远航❤️.mp4',
    filePath: '/Users/me/Downloads/杨超越 - 小小水手.mp4', url: 'https://www.douyin.com/video/6961737553342991651',
    size: 6281768, sizeText: '6.0 MB', downloaded: 3900000, speed: 1200000, speedText: '1.1 MB/s',
    progress: 62.1, threads: 32, activeThreads: 28, segments: 32, segDetail: [], logs: [], error: null,
    meta: { author: '杨超越', desc: '#杨超越  小小水手带你去远航❤️', durationMs: 19782, quality: '1080P', width: 1080, height: 1920, variantCount: 4 }
  },
  {
    id: 2, kind: 'bt', source: 'BT', status: 'downloading', filename: 'ubuntu-24.04.iso',
    filePath: '/Users/me/Downloads/ubuntu-24.04.iso', url: 'magnet:?xt=urn:btih:abc',
    size: 5e9, sizeText: '4.7 GB', downloaded: 1.2e9, speed: 8e6, speedText: '7.6 MB/s',
    progress: 24, threads: 0, connections: 42, seeders: 18, activeThreads: 0, segments: 0, segDetail: [], logs: [], error: null
  },
  {
    id: 3, kind: 'http', source: 'GitHub', status: 'completed', filename: 'model.safetensors',
    filePath: '/Users/me/Downloads/model.safetensors', url: 'https://github.com/x/y',
    size: 1048576, sizeText: '1.0 MB', downloaded: 1048576, speed: 0, speedText: '-',
    progress: 100, threads: 32, activeThreads: 0, segments: 4, segDetail: [], logs: [], error: null
  }
];

// 档位形状对齐真实长视频：去重后 7 档，含 H.265 与「流畅」档
const FAKE_DETAIL = {
  ok: true, id: '7689058205258779914', author: '陈龙科普',
  desc: '仅用一个视频，便能让你了解长江完整的水系分布，你信吗？ #长江 #地理科普', durationMs: 1855100, music: '轻音乐',
  cover: '', isImages: false, imageCount: 0,
  variants: [
    { label: '1080P', width: 1920, height: 1080, size: 900431812, codec: 'h264' },
    { label: '1080P · H.265', width: 1920, height: 1080, size: 389624718, codec: 'h265' },
    { label: '720P', width: 1280, height: 720, size: 574619648, codec: 'h264' },
    { label: '720P · H.265', width: 1280, height: 720, size: 227426683, codec: 'h265' },
    { label: '540P', width: 1024, height: 576, size: 498397307, codec: 'h264' },
    { label: '540P（流畅）', width: 1024, height: 576, size: 301971237, codec: 'h264' },
    { label: '540P · H.265', width: 1024, height: 576, size: 119523119, codec: 'h265' }
  ]
};

// 假 preload：把 app.js 用到的 tdm API 全部顶掉
const PRELOAD = `
const { contextBridge } = require('electron');
const noop = () => {};
contextBridge.exposeInMainWorld('tdm', {
  listTasks: async () => ${JSON.stringify(FAKE_TASKS)},
  addTask: async () => 1,
  pause: noop, resume: noop, remove: noop, pauseAll: noop, clearCompleted: noop, restart: noop,
  sniffUrl: async () => ({ items: [] }),
  douyinExtract: async () => (${JSON.stringify(FAKE_DETAIL)}),
  exportLinks: async () => null,
  getConfig: async () => ({ downloadDir: '/Users/me/Downloads', maxThreads: 32, maxConcurrent: 3, clipboardMonitor: true, btSeedTime: 0, btTrackers: '', douyinQuality: 'best' }),
  appVersion: async () => '0.4.0',
  setConfig: async () => ({}), chooseDir: async () => null, showItem: async () => ({ ok: true }),
  onTasksUpdated: noop, onTaskDone: noop, onTaskError: noop, onAddFailed: noop, onClipboardUrl: noop,
  markClipboardHandled: noop, copyText: noop
});
`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const preloadPath = path.join(OUT, '_fake-preload.js');
  fs.writeFileSync(preloadPath, PRELOAD);

  const win = new BrowserWindow({
    width: 1080, height: 720, show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true, nodeIntegration: false,
      // 让 executeJavaScript 能直接操作页面 DOM
      worldSafeExecuteJavaScript: true
    }
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) { errors.push(msg); console.log(`  [renderer:${level}] ${msg}  (${path.basename(src)}:${line})`); }
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('  [preload-error]', p, err.message));

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 900)); // 等 listTasks 渲染完

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, img.toPNG());
    console.log(`  📷 ${f}`);
    return f;
  };

  console.log('【1】任务列表（含抖音 / BT 标签）');
  await shot('01-task-list');

  // 展开抖音任务看详情卡
  await win.webContents.executeJavaScript(`
    document.querySelector('.task[data-id="1"] .row1').click();
  `);
  await new Promise(r => setTimeout(r, 300));
  console.log('【2】抖音任务展开详情');
  await shot('02-douyin-detail');

  console.log('【3】抖音解析弹窗（清晰度档位）');
  await win.webContents.executeJavaScript(`
    document.querySelector('.task[data-id="1"] .row1').click();  // 收起
    document.querySelector('#url-input').value = 'https://www.douyin.com/video/6961737553342991651';
    document.querySelector('#btn-add').click();
  `);
  await new Promise(r => setTimeout(r, 800));
  await shot('03-douyin-modal');

  // 用真实计算样式断言，而不是靠肉眼看截图
  const checks = await win.webContents.executeJavaScript(`
    (() => {
      const modal = document.querySelector('#douyin-modal');
      const variant = document.querySelector('.dy-variant');
      const label = document.querySelector('.dy-q-label');
      const kindDy = document.querySelector('.kind-douyin');
      const cs = el => el ? getComputedStyle(el) : null;
      return {
        modalVisible: !modal.classList.contains('hidden'),
        variantCount: document.querySelectorAll('.dy-variant').length,
        addEnabled: !document.querySelector('#btn-dy-add').disabled,
        variantFontSize: cs(variant) && cs(variant).fontSize,
        variantMarginTop: cs(variant) && cs(variant).marginTop,
        labelColor: cs(label) && cs(label).color,
        radioWidth: document.querySelector('.dy-variant input').getBoundingClientRect().width,
        radioLeft: document.querySelector('.dy-variant input').getBoundingClientRect().left,
        variantLeft: variant.getBoundingClientRect().left,
        sizeWhiteSpace: cs(document.querySelector('.dy-q-size')).whiteSpace,
        kindBg: cs(kindDy) && cs(kindDy).backgroundColor,
        kindText: kindDy && kindDy.textContent,
        authorText: document.querySelector('#dy-author').textContent,
        statsText: document.querySelector('#dy-stats').textContent,
        statusText: document.querySelector('#dy-status').textContent,
        modalScrollable: (() => {
          const b = document.querySelector('.dy-body');
          return getComputedStyle(b).overflowY === 'auto' && b.scrollHeight >= b.clientHeight;
        })(),
        modalSize: (() => {
          const b = document.querySelector('.dy-body');
          return { scrollH: b.scrollHeight, clientH: b.clientHeight, maxH: getComputedStyle(b).maxHeight };
        })(),
        addBtnVisible: (() => {
          const r = document.querySelector('#btn-dy-add').getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0;
        })(),
        addBtnRect: (() => {
          const r = document.querySelector('#btn-dy-add').getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), winH: window.innerHeight };
        })()
      };
    })()
  `);
  console.log('  计算样式:', JSON.stringify(checks, null, 2));

  console.log('【4】设置弹窗');
  await win.webContents.executeJavaScript(`
    document.querySelector('#btn-dy-cancel').click();
    document.querySelector('#btn-settings').click();
  `);
  await new Promise(r => setTimeout(r, 400));
  await shot('04-settings');

  console.log('【5】粘贴「文案 + 链接」整段分享文本也要能触发解析');
  const shareCheck = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('#btn-settings-cancel').click();
      const input = document.querySelector('#url-input');
      input.value = '7.65 复制打开抖音，看看【杨超越】的作品 https://v.douyin.com/iRNBho6u/ 一起看吧！';
      document.querySelector('#btn-add').click();
      await new Promise(r => setTimeout(r, 600));
      return {
        modalVisible: !document.querySelector('#douyin-modal').classList.contains('hidden'),
        variantCount: document.querySelectorAll('.dy-variant').length
      };
    })()
  `);
  await shot('05-share-text');
  console.log('  ' + JSON.stringify(shareCheck));

  let failed = 0;
  const check = (n, c) => { console.log(`  ${c ? '✅' : '❌'} ${n}`); if (!c) failed++; };
  console.log('\n断言:');
  check('弹窗已打开', checks.modalVisible);
  check('列出 7 档清晰度（去重后）', checks.variantCount === 7, `实际 ${checks.variantCount}`);
  check('「添加下载」按钮可用', checks.addEnabled);
  check('档位字号是 13px（未被 .modal-body label 的 12px 覆盖）', checks.variantFontSize === '13px');
  check('档位 margin-top 归零（未被 .modal-body label 的 8px 覆盖）', checks.variantMarginTop === '0px');
  check('档位文字是深色（未被 .modal-body label 的灰字覆盖）', checks.labelColor === 'rgb(28, 35, 48)');
  check('单选钮没被 .modal-body input 的 width:100% 拉宽', checks.radioWidth < 30, `实际 ${checks.radioWidth}px`);
  check('单选钮贴在行首（不是被推到中间）', checks.radioLeft - checks.variantLeft < 20, `偏移 ${(checks.radioLeft - checks.variantLeft).toFixed(1)}px`);
  check('档位大小不换行', checks.sizeWhiteSpace === 'nowrap');
  check('抖音标签渲染成粉色底', checks.kindBg === 'rgb(255, 233, 242)');
  check('抖音标签文字为「抖音」', checks.kindText === '抖音');
  check('作者名已显示', checks.authorText === FAKE_DETAIL.author, checks.authorText);
  check('时长+音乐已显示', /3:18|19\.8|0:19/.test(checks.statsText) || checks.statsText.length > 0, checks.statsText);
  check('渲染无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('粘贴「文案 + 链接」整段分享文本也会触发解析弹窗', shareCheck.modalVisible && shareCheck.variantCount === 7, JSON.stringify(shareCheck));
  // 档位数多时弹窗必须能滚，否则「添加下载」按钮会被挤出视口点不到
  check('弹窗内容超出时可滚动（按钮不会被挤出视口）', checks.modalScrollable, JSON.stringify(checks.modalSize));
  check('「添加下载」按钮在视口内可见', checks.addBtnVisible, JSON.stringify(checks.addBtnRect));

  console.log(`\n${failed === 0 ? '✅ 界面冒烟测试通过' : `❌ ${failed} 项失败`}`);
  app.exit(failed === 0 ? 0 : 1);
}).catch(e => { console.error('异常:', e); app.exit(1); });
