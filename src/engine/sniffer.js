// CDown - 网址嗅探引擎：输入任意网址 → 解析页面 → 列出可下载的文件/视频
// 三条通道：
//   1) 输入本身是直链文件 → 直接返回
//   2) 视频站点 / 普通页面兜底 → yt-dlp -J 全站解析（覆盖 1800+ 站点）
//   3) 普通网页 → 抓取 HTML，解析 <video>/<audio>/<source>/og:video 标签
//      + 全文扫描媒体/文件直链（含内嵌 JS）+ 相对路径资源
const { UA } = require('./downloader');

const MEDIA_EXTS = ['m3u8', 'mpd', 'mp4', 'm4s', 'ts', 'flv', 'webm', 'mkv', 'mov', 'avi', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav', 'opus'];
const FILE_EXTS = ['zip', 'rar', '7z', 'gz', 'tar', 'pdf', 'exe', 'msi', 'dmg', 'apk', 'iso', 'torrent', 'epub', 'srt', 'csv', 'xlsx', 'docx', 'pptx'];
const ALL_EXTS = [...MEDIA_EXTS, ...FILE_EXTS];
const ALL_EXT_RE = new RegExp(`\\.(${ALL_EXTS.join('|')})(\\?|#|$)`, 'i');

const VIDEO_SITES = ['youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'x.com', 'twitter.com', 'tiktok.com', 'douyin.com', 'reddit.com',
  'ixigua.com', 'youku.com', 'v.qq.com', 'iqiyi.com', 'weibo.com', 'weibo.cn', 'twitch.tv', 'vimeo.com', 'instagram.com', 'facebook.com'];

function isDirectFile(url) { return ALL_EXT_RE.test(url.split('#')[0]); }
function isVideoSite(url) { const u = url.toLowerCase(); return VIDEO_SITES.some(s => u.includes(s)); }

function extOf(url) { return (url.match(ALL_EXT_RE) || [])[1] || null; }
function typeOfExt(ext) {
  if (!ext) return '文件';
  const e = ext.toLowerCase();
  if (MEDIA_EXTS.includes(e)) return '媒体';
  return '文件';
}

// ---------- 抓取页面（带超时 + GBK/UTF-8 自适应） ----------
async function fetchPage(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ctype = resp.headers.get('content-type') || '';
    // 内容本体不是 HTML（如图片/二进制）就无需解析
    if (ctype && !/text\/html|application\/xhtml|text\/plain|application\/json|xml/i.test(ctype)) {
      return { url: resp.url, html: '', ctype };
    }
    const buf = await resp.arrayBuffer();
    const cap = buf.byteLength > 3 * 1024 * 1024 ? buf.slice(0, 3 * 1024 * 1024) : buf;
    let text = new TextDecoder('utf-8').decode(cap);
    const head = text.slice(0, 2000);
    if (/charset=["']?(gb2312|gbk)/i.test(head) || /charset=["']?(gb2312|gbk)/i.test(ctype)) {
      try { text = new TextDecoder('gbk').decode(cap); } catch { /* 解码器缺失时保持 UTF-8 */ }
    }
    return { url: resp.url, html: text, ctype };
  } finally { clearTimeout(timer); }
}

// ---------- HTML 解析 ----------
function extractFromHtml(pageUrl, html) {
  const results = new Map(); // abs url -> item
  const add = (u, how) => {
    if (!u) return;
    u = u.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').trim();
    if (u.startsWith('//')) u = 'https:' + u;
    try {
      const abs = new URL(u, pageUrl).href;
      if (!/^https?:/i.test(abs)) return;
      if (!results.has(abs)) results.set(abs, { url: abs, how });
    } catch { /* 非法 URL 忽略 */ }
  };

  let m;
  // 1) <video>/<audio>/<source> src
  const tagRe = /<(?:video|audio|source)[^>]+?src=["']([^"']+)["']/gi;
  while ((m = tagRe.exec(html))) add(m[1], '播放器');
  // 2) og:video / og:audio meta
  const metaRe = /<meta[^>]+?property=["'](?:og:video(?::(?:url|secure_url))?|og:audio(?::url)?)["'][^>]+?content=["']([^"']+)["']/gi;
  while ((m = metaRe.exec(html))) add(m[1], '播放器');
  // 3) 全文扫描绝对直链（含内嵌 JS 里的 m3u8/mp4 等）
  const urlRe = /https?:\/\/[^\s"'<>()\\[\]{}]+/gi;
  while ((m = urlRe.exec(html))) {
    const u = m[0].replace(/[),;'"]+$/, '');
    if (ALL_EXT_RE.test(u) && !results.has(u)) results.set(u, { url: u, how: '链接' });
  }
  // 4) 相对路径资源属性
  const relRe = /(?:src|href|data-src|data-url|data-video|data-mp4)=["']([^"']+\.(?:m3u8|mpd|mp4|mkv|webm|flv|mov|avi|mp3|m4a|aac|ogg|wav|zip|rar|7z|pdf|apk|exe|msi|torrent|epub|srt))(\?[^"']*)?["']/gi;
  while ((m = relRe.exec(html))) add(m[1] + (m[2] || ''), '资源');
  return [...results.values()];
}

// ---------- yt-dlp 全站解析 ----------
async function sniffViaYtdlp(url) {
  const ytdlp = require('./ytdlp');
  const info = await ytdlp.probeFormats(url); // { title, extractor, items[] }
  // 首项固定为"最佳画质"（不指定格式，由 yt-dlp 自动选择并合并）
  const items = [{
    formatId: null, ext: 'mp4',
    label: `最佳画质（自动合并音视频）${info.title ? ' · ' + info.title : ''}`,
    size: null, type: '推荐', url
  }, ...info.items];
  return { kind: 'video', title: info.title, extractor: info.extractor, items };
}

// ---------- 主入口 ----------
async function sniff(url) {
  url = String(url || '').trim();
  const out = { url, kind: 'page', items: [], error: null, title: null, extractor: null };
  let parsed;
  try { parsed = new URL(url); } catch { out.error = '无效的网址'; return out; }
  if (!/^https?:$/i.test(parsed.protocol)) { out.error = '仅支持 http/https 链接'; return out; }

  // 通道 1：输入本身是直链文件
  if (isDirectFile(url)) {
    const ext = (extOf(url) || 'file').toUpperCase();
    const name = decodeURIComponent(url.split('#')[0].split('?')[0].split('/').pop() || url);
    out.kind = 'direct';
    out.items.push({ url, ext, label: name, size: null, type: '直链文件' });
    return out;
  }

  // 通道 2：已知视频站点直接走 yt-dlp（1800+ 站点通用）
  if (isVideoSite(url)) {
    try { return { ...out, ...(await sniffViaYtdlp(url)) }; }
    catch (e) { out.error = `yt-dlp 解析失败：${String(e.message || e).slice(0, 200)}`; return out; }
  }

  // 通道 3：普通网页抓 HTML 解析
  try {
    const { url: finalUrl, html } = await fetchPage(url);
    if (!html) { out.error = '页面内容无法解析（非网页类型）'; return out; }
    const found = extractFromHtml(finalUrl, html);
    out.items = found.map(f => {
      const ext = extOf(f.url);
      return { url: f.url, ext: (ext || 'file').toUpperCase(), label: decodeURIComponent(f.url.split('?')[0].split('/').pop() || f.url), size: null, type: typeOfExt(ext), how: f.how };
    }).slice(0, 60);
    // 兜底：页面没有直链时尝试 yt-dlp 通用解析（覆盖内嵌播放器/通用视频站）
    if (out.items.length === 0) {
      try { return { ...out, ...(await sniffViaYtdlp(url)) }; }
      catch { out.error = '未在该页面发现可下载的文件或媒体'; return out; }
    }
    return out;
  } catch (e) {
    out.error = `页面获取失败：${String(e.message || e).slice(0, 200)}`;
    return out;
  }
}

module.exports = { sniff, isDirectFile, isVideoSite, fetchPage, extractFromHtml };
