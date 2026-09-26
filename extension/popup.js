// CDown 助手 - 弹窗逻辑
const $ = s => document.querySelector(s);
let currentTab = null;

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.style.display = 'block';
  clearTimeout(t._tm);
  t._tm = setTimeout(() => (t.style.display = 'none'), 2200);
}

function renderList(items) {
  const ul = $('#media-list');
  $('#empty').style.display = items.length ? 'none' : 'block';
  ul.innerHTML = items.map(u => {
    const ext = (u.match(/\.(m3u8|mpd|mp4|m4s|ts|flv|webm|mkv|mp3|m4a|aac|flac|ogg|wav)/i) || [])[1] || 'media';
    const short = u.length > 76 ? u.slice(0, 76) + '…' : u;
    return `<li><span class="tag">${ext.toUpperCase()}</span><span class="u" title="${u.replace(/"/g, '&quot;')}">${short}</span><button data-url="${u.replace(/"/g, '&quot;')}">下载</button></li>`;
  }).join('');
  ul.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'send-url', url: b.dataset.url, source: '页面嗅探' }, r => {
      if (chrome.runtime.lastError) return toast(chrome.runtime.lastError.message, true);
      if (r && r.ok) toast('已发送到 CDown');
    });
  }));
}

async function loadMedia() {
  if (!currentTab) return;
  chrome.runtime.sendMessage({ type: 'get-tab-media', tabId: currentTab.id }, r => {
    if (chrome.runtime.lastError) return;
    renderList((r && r.media) || []);
  });
}

async function checkStatus() {
  chrome.runtime.sendMessage({ type: 'ping' }, r => {
    if (chrome.runtime.lastError) return;
    const el = $('#status');
    if (r && r.online) { el.textContent = `CDown 在线 v${r.version || ''}`; el.classList.add('on'); }
    else { el.textContent = 'CDown 未运行'; el.classList.remove('on'); }
  });
}

$('#send').addEventListener('click', () => {
  const url = $('#url').value.trim();
  if (!url) return toast('请输入链接', true);
  chrome.runtime.sendMessage({ type: 'send-url', url, source: '手动输入' }, r => {
    if (chrome.runtime.lastError) return toast(chrome.runtime.lastError.message, true);
    if (r && r.ok) { toast('已发送到 CDown'); $('#url').value = ''; }
  });
});
$('#url').addEventListener('keydown', e => { if (e.key === 'Enter') $('#send').click(); });
$('#refresh').addEventListener('click', loadMedia);
// 本页视频：直接把页面 URL 发给 CDown（视频站自动走 yt-dlp 全站解析）
$('#send-page').addEventListener('click', () => {
  if (!currentTab || !/^https?:/i.test(currentTab.url || '')) return toast('当前页面无法下载', true);
  chrome.runtime.sendMessage({ type: 'send-url', url: currentTab.url, source: '页面视频' }, r => {
    if (chrome.runtime.lastError) return toast(chrome.runtime.lastError.message, true);
    if (r && r.ok) toast('已发送页面到 CDown 解析');
  });
});
$('#port').addEventListener('change', () => {
  const port = Math.min(65535, Math.max(1024, Number($('#port').value) || 8780));
  chrome.storage.local.set({ port }, () => { toast('端口已保存: ' + port); checkStatus(); });
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const { port } = await chrome.storage.local.get('port');
  if (port) $('#port').value = port;
  checkStatus();
  loadMedia();
})();
