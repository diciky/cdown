// CDown - 抖音解析（无水印直链）
//
// 为什么不走 yt-dlp 的 DouyinIE：
//   1) 它的源码里明确写着 `TODO: Run verification challenge code to generate signature cookies`
//      —— 它自己不生成签名，只负责把外部 cookie 拿来用；
//   2) 实测把浏览器导出的 cookie 喂给它，仍然 403（请求头与真实浏览器不一致）；
//   3) 直接调 detail 接口能拿到无水印 play_addr，且 CDN 直链支持 Range，
//      可以交给项目已有的多线程 HTTP 引擎，比 yt-dlp 单线程拉更快。
//
// 关键实测结论（都验证过，不是推测）：
//   * 抖音的 /aweme/v1/web/aweme/detail/ 需要 JS 挑战生成的 s_v_web_id，
//     纯 HTTP 请求会被 403 "Blocked by ArgusSecurityPlugin Uifid Not Found"；
//   * ttwid 可以免登录从 ttwid.bytedance.com 拿到，但**光有它不够**，
//     必须有真实浏览器上下文跑一遍挑战（本模块用隐藏 BrowserWindow 做这件事）；
//   * 拿到的 play_addr 是**无水印**的（download_addr 带 watermark=1）；
//   * 直链**必须带 Referer: https://www.douyin.com/**，否则 403；
//     带上后返回 206 + Content-Range，可多线程分段下载。
//
// 本模块依赖 Electron，必须懒加载（CLI/单测环境下没有 electron）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const PARTITION = 'persist:cdown-douyin';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOME_URL = 'https://www.douyin.com/';
const DETAIL_API = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

// 直链必需的请求头（少了 Referer 会被 403）
const MEDIA_HEADERS = { 'user-agent': UA, 'referer': HOME_URL };

// ---------- URL 解析（纯函数，可单测） ----------

// 支持：长链 /video/<id>、/note/<id>、短链 v.douyin.com/xxx、
//       iesdouyin 分享页 /share/video/<id>、以及分享文案里夹带的链接
function parseUrl(input) {
  const text = String(input || '').trim();
  // 从分享文案里抠出链接（抖音分享默认是「文案 + 链接」一整段）
  const m = text.match(/https?:\/\/[^\s，,。；;]+/);
  const url = m ? m[0] : text;
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)(douyin|iesdouyin)\.com$/.test(host)) return null;

  // 短链：需要发请求才能知道真实地址
  if (/^v\.douyin\.com$/.test(host)) {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? { kind: 'short', id: seg, url } : null;
  }

  const segs = u.pathname.split('/').filter(Boolean);
  const at = (name) => { const i = segs.indexOf(name); return i >= 0 ? segs[i + 1] : null; };

  const videoId = at('video') || at('slides') || (segs[0] === 'share' && segs[1] === 'video' ? segs[2] : null);
  if (videoId && /^\d{6,}$/.test(videoId)) return { kind: 'video', id: videoId, url };

  const noteId = at('note');
  if (noteId && /^\d{6,}$/.test(noteId)) return { kind: 'note', id: noteId, url };

  if (at('user') || segs[0] === 'user') return { kind: 'user', id: at('user') || segs[1] || null, url };
  if (at('live')) return { kind: 'live', id: at('live'), url };

  // 首页短链之外的未知形式：把 id 交给调用方再判断
  const tail = segs[segs.length - 1];
  if (tail && /^\d{6,}$/.test(tail)) return { kind: 'video', id: tail, url };
  return { kind: 'unknown', id: null, url };
}

// 从 aweme_detail 里挑清晰度档位。
// bit_rate 数组每档形如 { gear_name, play_addr: { width, height, data_size, url_list } }
//
// 关于「档位数字」（tier）：必须优先取 gear_name 里的数字，不能拿 addr.height 当档位。
// 抖音竖屏作品是 1080×1920，gear_name 是 normal_1080_0，用户看到的就是「1080P」；
// 而 addr.height 是 1920 —— 直接拿来当档位，1080P 会被标成 1920P，
// 排序、去重、"不超过目标分辨率"的挑选逻辑会全部错位。
function pickVariants(detail) {
  const video = (detail && detail.video) || {};
  const out = [];
  const push = (label, addr, tier) => {
    const urls = (addr && addr.url_list) || [];
    const url = urls.find(u => /douyinvod\.com|douyin\.com\/aweme\/v1\/play/.test(u));
    if (!url) return;
    out.push({
      label,
      tier: tier || 0,
      width: addr.width || 0,
      height: addr.height || 0,
      size: addr.data_size || 0,
      url
    });
  };

  for (const br of video.bit_rate || []) {
    const addr = br.play_addr || {};
    const gear = String(br.gear_name || '');
    // gear_name 形如 normal_1080_0 / lower_540_0 / comet_bvc1_r3_adapt_lowest_720_1
    const hMatch = gear.match(/(\d{3,4})/);
    const sides = [addr.width, addr.height].filter(n => Number(n) > 0);
    // 没有数字时退回短边（≈ 清晰度档），而不是长边
    const tier = hMatch ? Number(hMatch[1]) : (sides.length ? Math.min(...sides) : 0);
    const low = /lower|lowest|adapt_lowest/.test(gear);
    const label = tier ? `${tier}P${low ? '（流畅）' : ''}` : gear;
    push(label, addr, tier);
  }
  // bit_rate 为空时退回默认 play_addr
  if (!out.length) {
    const addr = video.play_addr || {};
    const sides = [addr.width, addr.height].filter(n => Number(n) > 0);
    push('默认', addr, sides.length ? Math.min(...sides) : 0);
  }

  // 去重（同一档可能有多个镜像），按档位降序
  const seen = new Set();
  return out
    .filter(v => { const k = `${v.label}|${v.size}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.tier - a.tier) || (b.size - a.size));
}

function pickBest(variants, prefer) {
  if (!variants.length) return null;
  if (!prefer || prefer === 'best') return variants[0];
  const s = String(prefer);
  // 精确标签优先：界面上给用户选的就是某一档的 label，必须原样命中。
  // 否则「720P（流畅）」会被按数字解析成 720，进而挑到另一档普通 720P。
  const exact = variants.find(v => v.label === s);
  if (exact) return exact;
  const want = Number(s.replace(/\D/g, ''));
  if (!want) return variants[0];
  // 优先不超过目标档位的最高档，避免为了「1080P」硬拉一档更大的
  const fit = variants.filter(v => v.tier && v.tier <= want);
  return (fit.length ? fit : variants)[0];
}

// 生成可读的文件名：作者 - 描述.mp4
// detail 既接受原始 aweme_detail（author 是对象），也接受 extract() 的返回（author 是字符串）
function buildFilename(detail, ext = 'mp4') {
  const d = detail || {};
  const author = typeof d.author === 'string' ? d.author : ((d.author || {}).nickname || '');
  const desc = String(d.desc || '').replace(/[\r\n\t]+/g, ' ').trim();
  let name = [author, desc].filter(Boolean).join(' - ');
  if (!name) name = `douyin_${d.aweme_id || d.id || Date.now()}`;
  return { name, ext };
}

// ---------- Electron 会话（懒加载） ----------

let _win = null;
let _ready = false;
let _readyAt = 0;
const READY_TTL = 20 * 60 * 1000; // 20 分钟内复用同一会话，过期重新跑挑战

function electron() {
  // 懒加载：CLI / 单测环境没有 electron，不能顶层 require
  const e = require('electron');
  if (!e || !e.BrowserWindow) throw new Error('抖音下载需要在 CDown 应用内运行（依赖 Electron 会话）');
  return e;
}

async function ensureWindow() {
  const { BrowserWindow, session } = electron();
  if (_win && !_win.isDestroyed()) return _win;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA);
  _win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false }
  });
  _win.on('closed', () => { _win = null; _ready = false; });
  _win.loadURL(HOME_URL).catch(() => { /* 失败时下面靠 cookie 轮询判断 */ });
  return _win;
}

// 等 JS 验证挑战跑完（标志是拿到 s_v_web_id）
async function ensureReady(force = false) {
  const { session } = electron();
  if (_ready && !force && Date.now() - _readyAt < READY_TTL) return true;
  const win = await ensureWindow();
  const ses = session.fromPartition(PARTITION);
  const t0 = Date.now();
  const timeout = 45000;
  while (Date.now() - t0 < timeout) {
    if (win.isDestroyed()) throw new Error('抖音会话窗口已关闭');
    const cookies = await ses.cookies.get({ domain: 'douyin.com' });
    if (cookies.some(c => c.name === 's_v_web_id')) {
      _ready = true;
      _readyAt = Date.now();
      return true;
    }
    if (Date.now() - t0 > 3000 && !win.webContents.isLoading()) {
      // 页面已停但还没拿到 cookie，重新加载一次（挑战偶尔会失败）
      win.loadURL(HOME_URL).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('抖音验证超时：未能获取 s_v_web_id（可能需要网络代理，或抖音风控策略有变）');
}

// 跟随一次重定向并返回目标地址（不真正下载内容）。
//
// 为什么不用 session.fetch：实测它带 redirect:'manual' 时直接抛
// "Redirect was cancelled"（拿不到 3xx 响应本身），带 'follow' 时 res.url 是空的
// （Electron 不填这个字段）—— 两条路都拿不到 Location。
// 为什么不用 Node 的 http/https：它不读系统代理，而抖音短链在国内常需要走代理。
// net.request 既走 Chromium 的网络栈（自动用系统代理），又能通过 redirect 事件
// 拿到目标地址，是这里唯一同时对的选择。
function followRedirectOnce(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      const { net, session } = electron();
      req = net.request({
        method: 'GET',
        url,
        redirect: 'manual',
        session: session.fromPartition(PARTITION)
      });
    } catch { return finish(null); }

    req.on('redirect', (_status, _method, redirectUrl) => {
      finish(redirectUrl || null);
      try { req.abort(); } catch { /* 忽略 */ }
    });
    req.on('response', () => finish(null)); // 没有重定向
    req.on('error', () => finish(null));
    try { req.setHeader('user-agent', UA); } catch { /* 忽略 */ }
    try { req.end(); } catch { finish(null); }
    setTimeout(() => { finish(null); try { req.abort(); } catch { /* 忽略 */ } }, timeoutMs);
  });
}

// 短链 → 真实链接。
// 短链通常是一串 302：v.douyin.com/xxx → www.iesdouyin.com/share/video/<id>/。
// 先用 net.request 读 Location（最可靠），拿不到再退回页面上下文
// （与浏览器同源、能带全部 cookie，能兜住「靠页面 JS 跳转」的短链）。
async function resolveShortLink(shortUrl) {
  const target = await followRedirectOnce(shortUrl);
  if (target && target !== shortUrl) return target;

  const win = await ensureWindow();
  const js = `fetch(${JSON.stringify(shortUrl)}, { redirect: 'follow', credentials: 'include' })
    .then(r => r.url).catch(e => 'ERR:' + e.message)`;
  try {
    const finalUrl = await win.webContents.executeJavaScript(js);
    if (typeof finalUrl === 'string' && !finalUrl.startsWith('ERR:') && finalUrl !== shortUrl) return finalUrl;
  } catch { /* 两条路都不行 */ }
  return shortUrl;
}

// 调 detail 接口。
// 先在页面上下文里 fetch（与浏览器同源、自动带全部 cookie 与 Referer，实测最稳），
// 失败再退回主进程 ses.fetch。
async function fetchDetail(id) {
  const win = await ensureWindow();
  const api = `${DETAIL_API}?aweme_id=${encodeURIComponent(id)}&device_platform=webapp&aid=6383`;
  const js = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(api)}, { credentials: 'include', headers: { accept: 'application/json' } });
      const t = await r.text();
      return JSON.stringify({ status: r.status, body: t });
    } catch (e) { return JSON.stringify({ status: -1, body: String(e && e.message) }); }
  })()`;
  let raw;
  try { raw = JSON.parse(await win.webContents.executeJavaScript(js)); }
  catch (e) { raw = { status: -1, body: String(e.message) }; }

  let parsed = null;
  if (raw.status === 200) { try { parsed = JSON.parse(raw.body); } catch { /* 非 JSON */ } }

  if (!parsed || !parsed.aweme_detail) {
    // 退回主进程请求
    try {
      const { session } = electron();
      const res = await session.fromPartition(PARTITION).fetch(api, {
        headers: { accept: 'application/json', referer: HOME_URL, origin: 'https://www.douyin.com' }
      });
      if (res.ok) parsed = await res.json();
    } catch { /* 两条路都不行，下面统一报错 */ }
  }

  if (parsed && parsed.aweme_detail) return parsed.aweme_detail;

  // 403 通常意味着挑战态过期，标记为需要重新验证
  const err = new Error('抖音返回的内容里没有视频数据（可能需要重新验证或视频已被删除）');
  err.needsRefresh = true;
  err.status = raw.status;
  throw err;
}

/**
 * 解析一个抖音链接，返回可供下载的信息。
 * @param {string} input 链接或分享文案
 * @returns {Promise<{id,desc,author,durationMs,music,cover,variants,isImages,images,detail}>}
 */
async function extract(input) {
  let info = parseUrl(input);
  if (!info) throw new Error('不是有效的抖音链接');

  if (info.kind === 'short') {
    const real = await resolveShortLink(info.url);
    const reparsed = parseUrl(real);
    if (reparsed && reparsed.kind !== 'short' && reparsed.id) info = reparsed;
  }
  if (info.kind === 'user') throw new Error('这是抖音用户主页链接，请改用具体视频的分享链接');
  if (info.kind === 'live') throw new Error('暂不支持抖音直播');
  if (!info.id) throw new Error('无法从链接里识别视频 ID');

  await ensureReady();
  let detail;
  try {
    detail = await fetchDetail(info.id);
  } catch (e) {
    if (e.needsRefresh) {
      // 会话态过期：重跑一次挑战再试
      await ensureReady(true);
      detail = await fetchDetail(info.id);
    } else throw e;
  }

  const video = detail.video || {};
  const images = (detail.images || []).map(img => ({
    url: ((img.url_list || []).find(u => /douyinpic|douyin\.com/.test(u)) || (img.url_list || [])[0]),
    width: img.width, height: img.height
  })).filter(x => x.url);

  return {
    id: detail.aweme_id || info.id,
    desc: detail.desc || '',
    author: (detail.author || {}).nickname || '',
    authorId: (detail.author || {}).sec_uid || '',
    durationMs: detail.duration || 0,
    music: (detail.music || {}).title || '',
    cover: (((video.cover || {}).url_list) || [])[0] || '',
    variants: pickVariants(detail),
    isImages: images.length > 0,
    images,
    createTime: detail.create_time || 0
  };
}

// 图片/动图图文：返回所有图片直链（同样需要 Referer）
async function extractImages(input) {
  const r = await extract(input);
  return { ...r, headers: MEDIA_HEADERS };
}

/**
 * 任务队列用的解析入口：把链接换成「一个可直接多线程下载的直链 + 必需请求头 + 文件名」。
 * 放在本模块而不是主进程，是为了让端到端探针能跑完全一致的那段逻辑。
 * @param {string} input 链接或分享文案
 * @param {string} [quality] 清晰度档位标签（界面上的 label，如 '1080P'）；缺省取最高档
 */
async function resolve(input, quality) {
  const r = await extract(input);
  if (!r.variants.length) {
    throw new Error(r.isImages
      ? '这是抖音图文作品，当前版本只支持下载视频'
      : '没有解析到可下载的视频流（作品可能已删除，或需要登录才能观看）');
  }
  const v = pickBest(r.variants, quality);
  const { name, ext } = buildFilename(r, 'mp4');
  return {
    url: v.url,
    headers: mediaHeaders(),
    filename: `${name}.${ext}`,
    meta: {
      author: r.author,
      desc: r.desc,
      durationMs: r.durationMs,
      quality: v.label,
      width: v.width,
      height: v.height,
      variantCount: r.variants.length
    }
  };
}

function mediaHeaders() { return { ...MEDIA_HEADERS }; }

function dispose() {
  if (_win && !_win.isDestroyed()) _win.destroy();
  _win = null;
  _ready = false;
}

module.exports = {
  parseUrl,
  pickVariants,
  pickBest,
  buildFilename,
  extract,
  extractImages,
  resolve,
  mediaHeaders,
  resolveShortLink,
  ensureReady,
  dispose,
  MEDIA_HEADERS,
  UA
};
