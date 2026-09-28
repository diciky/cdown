// CDown - Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const IS_MAC = process.platform === 'darwin';

// 应用名：决定 macOS 菜单栏名称与 userData 目录名，必须在任何 getPath 之前设置，
// 否则开发模式下菜单栏显示 "Electron"、数据会落到 Application Support/Electron。
app.setName('CDown');

// 仅按需关闭硬件加速（远程桌面 / 虚拟机等无 GPU 环境）。
// 原来是无条件调用，会让 macOS 上界面掉帧、滚动发虚、动画卡顿。
if (process.env.CDOWN_DISABLE_GPU === '1') app.disableHardwareAcceleration();

// 打包后数据目录放到用户数据目录（asar 内不可写）
// macOS → ~/Library/Application Support/CDown，Windows → %APPDATA%/CDown
// 已经显式设置了 TDM_DATA_DIR 就不覆盖：便于做便携版、多实例，以及隔离测试。
if (app.isPackaged && !process.env.TDM_DATA_DIR) {
  process.env.TDM_DATA_DIR = path.join(app.getPath('appData'), 'CDown');
}

const { Queue } = require('../engine/queue');
const config = require('../engine/config');
const sniffer = require('../engine/sniffer');
const { resolveRevealTarget } = require('./reveal');

let win = null;
const queue = new Queue();

// 统一的安全发送：窗口可能已被关闭（macOS 关窗后应用仍在运行）
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function isWinAlive() {
  return !!win && !win.isDestroyed();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'CDown - 极速多线程下载器',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // macOS 的菜单栏是全局菜单，setMenuBarVisibility 无效，且隐藏会破坏 Cmd+C/V 等标准快捷键
  if (!IS_MAC) win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

// macOS 需要显式的应用菜单，否则 Cmd+Q / Cmd+C / Cmd+V / Cmd+W 等标准行为缺失
function buildMenu() {
  if (!IS_MAC) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]));
}

// 进度推送：前沿+尾沿节流（400ms）。尾沿保证最后一次状态（如暂停）必达界面，
// 否则暂停事件被节流丢弃后界面会永远停留在「下载中」，只剩暂停按钮。
const PUSH_INTERVAL = 400;
let lastPush = 0;
let pendingPush = null;
function push() {
  if (!isWinAlive()) return;
  const now = Date.now();
  if (now - lastPush >= PUSH_INTERVAL) {
    lastPush = now;
    win.webContents.send('tasks-updated', queue.snapshotAll());
  } else if (!pendingPush) {
    pendingPush = setTimeout(() => {
      pendingPush = null;
      lastPush = Date.now();
      send('tasks-updated', queue.snapshotAll());
    }, PUSH_INTERVAL - (now - lastPush));
  }
}
queue.on('progress', push);
queue.on('done', s => {
  push();
  send('task-done', s);
  // 窗口可能已关闭，setTitle 前必须判活，否则抛 "Object has been destroyed"
  if (isWinAlive()) win.setTitle(`✔ ${s.filename} - CDown`);
});
queue.on('error', s => { push(); send('task-error', s); });
queue.on('add-failed', s => { send('add-failed', s); });

ipcMain.handle('tasks:list', async () => { await queue.loadPersisted(); return queue.snapshotAll(); });
ipcMain.handle('tasks:add', async (_e, { url, threads, filename, format, formatExt }) => { const id = await queue.add(url, { threads, filename, format, formatExt }); push(); return id; });
ipcMain.handle('tasks:pause', async (_e, id) => { await queue.pause(id); push(); });
ipcMain.handle('tasks:resume', async (_e, id) => { await queue.resume(id); push(); });
ipcMain.handle('tasks:remove', async (_e, id) => { await queue.remove(id); push(); });
ipcMain.handle('tasks:pauseAll', async () => { await queue.pauseAll(); push(); });
ipcMain.handle('tasks:clearCompleted', async () => { await queue.clearCompleted(); push(); });
ipcMain.handle('tasks:restart', async (_e, id) => { await queue.restart(id); push(); });
ipcMain.handle('sniff:url', async (_e, url) => sniffer.sniff(url));
ipcMain.handle('tasks:exportLinks', async () => {
  const opts = {
    title: '导出任务链接',
    defaultPath: 'cdown-links.txt',
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  };
  // 无窗口时（macOS 关窗后应用仍在运行）不传父窗口，避免抛错
  const r = isWinAlive() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  const lines = queue.snapshotAll().map(t => t.url).join('\n');
  fs.writeFileSync(r.filePath, lines, 'utf8');
  return r.filePath;
});

ipcMain.handle('config:get', () => config.load());
// 版本号由主进程提供，避免界面里写死的版本号和 package.json 长期漂移
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('config:set', (_e, patch) => {
  const cfg = config.save(patch);
  if ('clipboardMonitor' in patch) startClipboardMonitor();
  if ('serverPort' in patch) startApiServer();
  return cfg;
});
ipcMain.handle('dialog:chooseDir', async () => {
  const opts = { properties: ['openDirectory'] };
  const r = isWinAlive() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0];
});
// 在访达/资源管理器里定位任务文件。
//
// 原实现只有一行 shell.showItemInFolder(p)，而该 API 对「不存在的路径」是**静默无反应**的
// —— 用户点了图标什么都不会发生，也没有任何提示。路径解析的三级降级逻辑放在
// ./reveal.js 里（不依赖 Electron，可单测），这里只负责调用系统 API 并把结果回传界面。
ipcMain.handle('shell:showItem', async (_e, p) => {
  const r = await resolveRevealTarget(p);
  if (!r.ok) return r;
  if (r.mode === 'open-dir') {
    const err = await shell.openPath(r.path);
    if (err) return { ok: false, error: `打开目录失败：${err}` };
  } else {
    shell.showItemInFolder(r.path);
  }
  return r;
});
ipcMain.handle('clipboard:markHandled', () => { lastClipboard = clipboard.readText(); });
ipcMain.handle('clipboard:copyText', (_e, text) => clipboard.writeText(String(text || '')));

// ---------- 剪贴板监听 ----------
let lastClipboard = '';
let clipboardTimer = null;
function isDownloadableUrl(text) {
  // 磁力链里不能有空白（含换行），但长度通常远超普通 URL，所以先单独放行再限长
  if (/^magnet:\?/i.test(text.trim())) return text.trim().length <= 4000;
  if (!text || text.length > 2000 || /\s/.test(text.trim())) return false;
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
function startClipboardMonitor() {
  clearInterval(clipboardTimer);
  if (!config.load().clipboardMonitor) return;
  clipboardTimer = setInterval(() => {
    if (!isWinAlive()) return;
    const text = (clipboard.readText() || '').trim();
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (!isDownloadableUrl(text)) return;
    // 已存在相同 URL 的任务则不重复询问
    const exists = queue.snapshotAll().some(t => t.url === text);
    if (exists) return;
    win.webContents.send('clipboard-url', text);
  }, 1200);
}

// ---------- 本地 API 服务（浏览器扩展通信，仅监听 127.0.0.1） ----------
const http = require('http');
let apiServer = null;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
}
function startApiServer() {
  if (apiServer) { try { apiServer.close(); } catch { /* 忽略 */ } apiServer = null; }
  const port = config.load().serverPort || 8780;
  apiServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/status') {
      return json(res, 200, { ok: true, name: 'CDown', version: app.getVersion() });
    }
    if (req.method === 'POST' && urlPath === '/add') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const { url, threads, filename } = JSON.parse(body || '{}');
          if (!url || !/^https?:\/\//i.test(url)) return json(res, 400, { ok: false, error: '无效的 URL' });
          const id = await queue.add(url, { threads: threads ? Number(threads) : undefined, filename });
          push();
          send('task-added-external', { id, url });
          json(res, 200, { ok: true, id });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
      });
      return;
    }
    json(res, 404, { ok: false, error: 'Not Found' });
  });
  apiServer.on('error', e => console.error(`[api] 本地服务启动失败 (端口 ${port}):`, e.code));
  apiServer.listen(port, '127.0.0.1', () => console.log(`[api] 本地服务: http://127.0.0.1:${port}`));
}

app.whenReady().then(async () => {
  await queue.loadPersisted();
  buildMenu();
  // 开发模式下 Dock 显示 Electron 图标，用项目图标替换
  if (IS_MAC && !app.isPackaged && app.dock) {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(iconPath)) {
      try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch { /* 忽略图标设置失败 */ }
    }
  }
  createWindow();
  startClipboardMonitor();
  startApiServer();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// macOS 惯例：关闭窗口不退出应用，下载任务继续后台跑，点 Dock 图标可重新唤起窗口。
// Windows / Linux 保持原行为（关窗即退出并暂停任务）。
app.on('window-all-closed', () => {
  if (IS_MAC) return;
  queue.pauseAll();
  app.quit();
});

// 真正退出前统一暂停，保证断点元数据落盘
app.on('before-quit', () => { queue.pauseAll(); });
