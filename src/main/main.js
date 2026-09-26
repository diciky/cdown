// TDM Fast - Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// 兼容远程桌面/虚拟机等无 GPU 环境
app.disableHardwareAcceleration();

// 打包后数据目录放到 AppData（asar 内不可写）
if (app.isPackaged) {
  process.env.TDM_DATA_DIR = path.join(app.getPath('appData'), 'CDown');
}

const { Queue } = require('../engine/queue');
const config = require('../engine/config');
const sniffer = require('../engine/sniffer');

let win = null;
const queue = new Queue();

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
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 进度推送：前沿+尾沿节流（400ms）。尾沿保证最后一次状态（如暂停）必达界面，
// 否则暂停事件被节流丢弃后界面会永远停留在「下载中」，只剩暂停按钮。
const PUSH_INTERVAL = 400;
let lastPush = 0;
let pendingPush = null;
function push() {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (now - lastPush >= PUSH_INTERVAL) {
    lastPush = now;
    win.webContents.send('tasks-updated', queue.snapshotAll());
  } else if (!pendingPush) {
    pendingPush = setTimeout(() => {
      pendingPush = null;
      lastPush = Date.now();
      if (win && !win.isDestroyed()) win.webContents.send('tasks-updated', queue.snapshotAll());
    }, PUSH_INTERVAL - (now - lastPush));
  }
}
queue.on('progress', push);
queue.on('done', s => { push(); if (win && !win.isDestroyed()) win.webContents.send('task-done', s); win?.setTitle(`✔ ${s.filename} - TDM Fast`); });
queue.on('error', s => { push(); if (win && !win.isDestroyed()) win.webContents.send('task-error', s); });
queue.on('add-failed', s => { if (win && !win.isDestroyed()) win.webContents.send('add-failed', s); });

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
  const r = await dialog.showSaveDialog(win, {
    title: '导出任务链接',
    defaultPath: 'cdown-links.txt',
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  });
  if (r.canceled || !r.filePath) return null;
  const lines = queue.snapshotAll().map(t => t.url).join('\n');
  fs.writeFileSync(r.filePath, lines, 'utf8');
  return r.filePath;
});

ipcMain.handle('config:get', () => config.load());
ipcMain.handle('config:set', (_e, patch) => {
  const cfg = config.save(patch);
  if ('clipboardMonitor' in patch) startClipboardMonitor();
  if ('serverPort' in patch) startApiServer();
  return cfg;
});
ipcMain.handle('dialog:chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:showItem', (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.handle('clipboard:markHandled', () => { lastClipboard = clipboard.readText(); });
ipcMain.handle('clipboard:copyText', (_e, text) => clipboard.writeText(String(text || '')));

// ---------- 剪贴板监听 ----------
let lastClipboard = '';
let clipboardTimer = null;
function isDownloadableUrl(text) {
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
    if (!win || win.isDestroyed()) return;
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
          if (win && !win.isDestroyed()) win.webContents.send('task-added-external', { id, url });
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
  createWindow();
  startClipboardMonitor();
  startApiServer();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { queue.pauseAll(); app.quit(); });
