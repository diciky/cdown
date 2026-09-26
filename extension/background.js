// CDown 助手 - Service Worker：右键菜单 + 页面媒体嗅探 + 发送到 CDown
const DEFAULT_PORT = 8780;

async function getPort() {
  const { port } = await chrome.storage.local.get('port');
  return Number(port) || DEFAULT_PORT;
}

async function api(path, body) {
  const port = await getPort();
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return resp.json();
}

async function sendToCDown(url, source) {
  try {
    const r = await api('/add', { url });
    if (r.ok) {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icon.png',
        title: '已添加到 CDown',
        message: `来源: ${source || '-'}\n${url.slice(0, 120)}`
      });
    } else {
      throw new Error(r.error || '未知错误');
    }
  } catch (e) {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icon.png',
      title: '发送失败',
      message: `CDown 未运行或端口不对（${e.message}）。请启动 CDown 桌面程序。`
    });
  }
}

// ---------- 右键菜单 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'cdown-link', title: '用 CDown 下载链接', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'cdown-media', title: '用 CDown 下载此媒体', contexts: ['video', 'audio', 'media'] });
  chrome.contextMenus.create({ id: 'cdown-selection', title: '用 CDown 下载选中链接', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'cdown-page', title: '用 CDown 下载页面视频/音频', contexts: ['page', 'frame'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'cdown-link') return sendToCDown(info.linkUrl, '右键链接');
  if (info.menuItemId === 'cdown-media') return sendToCDown(info.srcUrl, '右键媒体');
  if (info.menuItemId === 'cdown-selection') {
    const text = (info.selectionText || '').trim();
    if (/^https?:\/\//i.test(text)) return sendToCDown(text, '选中文本');
    return sendToCDown(tab?.url || '', '选中页面');
  }
  if (info.menuItemId === 'cdown-page') {
    // 使用嗅探缓存的本页媒体
    const found = await getTabMedia(tab?.id ?? -1);
    if (found.length === 0) {
      return chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: '未发现媒体', message: '页面上没有检测到可下载的视频/音频，先播放一下视频再试' });
    }
    for (const u of found.slice(0, 10)) await sendToCDown(u, '页面嗅探');
  }
});

// ---------- 页面媒体嗅探（webRequest 被动捕获） ----------
const MEDIA_RE = /\.(m3u8|mpd|mp4|m4s|ts|flv|webm|mkv|mp3|m4a|aac|flac|ogg|wav)(\?|$)/i;
// tabId -> Set<url>
const tabMedia = new Map();

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  const u = details.url;
  const isMedia = MEDIA_RE.test(u) ||
    (details.type === 'media') ||
    (details.type === 'xmlhttprequest' && /m3u8|mpd|manifest|format=mpd/i.test(u) && MEDIA_RE.test(u));
  if (!isMedia) return;
  if (!tabMedia.has(details.tabId)) tabMedia.set(details.tabId, new Set());
  const set = tabMedia.get(details.tabId);
  if (set.size < 100) set.add(u);
}, { urls: ['<all_urls>'] });

chrome.tabs.onRemoved.addListener(tabId => tabMedia.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') tabMedia.delete(tabId); });

async function getTabMedia(tabId) {
  return [...(tabMedia.get(tabId) || [])];
}

// ---------- 消息通道 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'get-tab-media') {
      const list = await getTabMedia(msg.tabId);
      sendResponse({ media: list });
    } else if (msg.type === 'send-url') {
      await sendToCDown(msg.url, msg.source || '弹窗');
      sendResponse({ ok: true });
    } else if (msg.type === 'ping') {
      try { const r = await api('/status'); sendResponse({ online: !!r.ok, name: r.name, version: r.version }); }
      catch { sendResponse({ online: false }); }
    }
  })();
  return true; // 异步响应
});
