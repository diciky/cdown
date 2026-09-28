// 【调试用探针，不属于测试套件】
// 用途：把抖音 detail 接口的原始返回结构 dump 出来，并对比不同请求头下直链的响应。
// 什么时候需要它：抖音改了字段名 / 加了新的档位命名 / 直链突然 403 时，
// 先跑它看一眼上游到底返回了什么，再去改 src/engine/douyin.js。
//
// 日常回归请用 scripts/douyin-test.js（离线，快）与 scripts/douyin-e2e.js（真实下载）。
//
// 当初确认路线的依据（已实测，结论已固化进 src/engine/douyin.js 的模块注释）：
//   1) yt-dlp 的 DouyinIE 源码里写着 `TODO: Run verification challenge code to generate
//      signature cookies` —— 它自己不生成签名，只负责把外部 cookie 拿来用；
//   2) 实测把浏览器导出的 cookie 喂给它仍然 403（请求头与真实浏览器不一致）；
//   3) 走 detail 接口能直接拿到无水印 play_addr，且 CDN 直链支持 Range，
//      可以交给项目已有的多线程 HTTP 引擎，比 yt-dlp 单线程拉更快。
//
// 运行: env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron --no-sandbox scripts/douyin-extract-probe.js
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const https = require('https');

const VIDEO_IDS = (process.env.DOUYIN_IDS || '6961737553342991651,6982497745948921092').split(',');
const PARTITION = 'persist:douyin-probe';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA);
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false }
  });

  console.log('【1】用 Electron 会话完成抖音的 JS 验证挑战');
  const t0 = Date.now();
  win.loadURL('https://www.douyin.com/').catch(() => {});
  while (Date.now() - t0 < 45000) {
    const c = await ses.cookies.get({ domain: 'douyin.com' });
    if (c.some(x => x.name === 's_v_web_id')) break;
    await sleep(800);
  }
  const cookies = await ses.cookies.get({ domain: 'douyin.com' });
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s，cookie: ${cookies.map(c => c.name).join(', ')}\n`);

  console.log('【2】在会话内调 detail 接口并检查关键字段');
  for (const id of VIDEO_IDS) {
    const js = `(async () => {
      const u = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}&device_platform=webapp&aid=6383';
      const r = await fetch(u, { credentials: 'include', headers: { 'accept': 'application/json' } });
      const t = await r.text();
      if (!/aweme_detail/.test(t)) return JSON.stringify({ status: r.status, err: t.slice(0, 120) });
      const j = JSON.parse(t);
      const a = j.aweme_detail || {};
      const v = a.video || {};
      const pick = (o) => (o && o.url_list) ? o.url_list : [];
      return JSON.stringify({
        status: r.status,
        desc: (a.desc || '').slice(0, 60),
        author: (a.author || {}).nickname,
        duration: a.duration,
        createTime: a.create_time,
        images: (a.images || []).length,
        play: pick(v.play_addr),
        download: pick(v.download_addr),
        playApi: v.play_addr && v.play_addr.uri,
        cover: pick(v.cover),
        bitRates: (v.bit_rate || []).map(b => ({ gear: b.gear_name, w: b.play_addr && b.play_addr.width, h: b.play_addr && b.play_addr.height, size: b.play_addr && b.play_addr.data_size, url: pick(b.play_addr)[0] })),
        music: (a.music || {}).title,
      });
    })()`;
    let res;
    try { res = JSON.parse(await win.webContents.executeJavaScript(js)); }
    catch (e) { console.log(`  ${id}: 执行失败 ${e.message}`); continue; }
    if (res.err) { console.log(`  ${id}: HTTP ${res.status} — ${res.err}`); continue; }
    console.log(`  ${id}  HTTP ${res.status}`);
    console.log(`    desc      : ${res.desc}`);
    console.log(`    author    : ${res.author}   时长: ${res.duration}ms   图文: ${res.images}`);
    console.log(`    音乐      : ${res.music}`);
    console.log(`    play_addr : ${res.play.length} 个`);
    res.play.slice(0, 3).forEach(u => console.log(`       ${u.slice(0, 110)}`));
    console.log(`    download  : ${res.download.length} 个（通常带水印）`);
    res.download.slice(0, 1).forEach(u => console.log(`       ${u.slice(0, 110)}`));
    console.log(`    bitRates  : ${res.bitRates.length} 档`);
    res.bitRates.forEach(b => console.log(`       ${String(b.gear || '-').padEnd(10)} ${b.w}x${b.h}  ${b.size ? (b.size / 1024 / 1024).toFixed(1) + 'MB' : '-'}`));
    console.log(`    play vs download 是否不同: ${res.play[0] !== res.download[0]}`);

    // 验证直链能否脱离浏览器会话下载，并确认 Referer 是否必需
    // （决定 CDown 的 HTTP 引擎要不要带自定义请求头）
    if (res.play[0]) {
      const variants = [
        ['无任何请求头', {}],
        ['仅 UA', { 'user-agent': UA }],
        ['UA + Referer', { 'user-agent': UA, 'referer': 'https://www.douyin.com/' }]
      ];
      for (const [label, headers] of variants) {
        try {
          const r = await fetch(res.play[0], { headers: { range: 'bytes=0-1023', ...headers } });
          console.log(`    [${label}] status=${r.status} cr=${r.headers.get('content-range') || '-'} ar=${r.headers.get('accept-ranges') || '-'}`);
          try { await r.body?.cancel(); } catch { /* ignore */ }
        } catch (e) { console.log(`    [${label}] 失败 ${e.message}`); }
      }
      fs.writeFileSync('/tmp/douyin-play.txt', res.play.join('\n') + '\n');
    }
    console.log('');
  }

  app.exit(0);
}).catch(e => { console.error('异常:', e); app.exit(1); });
