// CDown - 抖音下载 回归测试
//
// 抖音这条链路和别的都不一样：它不能交给 yt-dlp（DouyinIE 自己不生成签名 cookie，
// 实测喂浏览器导出的 cookie 仍 403），必须先经应用内的浏览器会话跑 JS 挑战换
// s_v_web_id，再调 detail 接口拿无水印直链，最后**带 Referer** 才能下载。
//
// 本套件不需要 Electron，分两层验证：
//   【1】纯函数：URL 解析 / 清晰度档位挑选 / 文件名生成
//   【2】队列集成：注入一个假的解析器，走真实的 HTTP 下载器打本地服务器，
//        并断言「请求里真的带了 Referer」——少了它真实环境就是 403，
//        这种回归用假的解析器是测不出来的，必须让请求真的发出去。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sha256(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdown-douyin-'));
  const dlDir = path.join(root, 'dl');
  fs.mkdirSync(dlDir, { recursive: true });

  // 隔离数据目录，避免污染用户真实任务列表
  process.env.TDM_DATA_DIR = path.join(root, 'data');
  const config = require('../src/engine/config');
  const { Queue, classify } = require('../src/engine/queue');
  const dy = require('../src/engine/douyin');

  config.save({ downloadDir: dlDir, maxConcurrent: 1, maxThreads: 4, segmentMinSize: 1 });

  // ==========================================================================
  console.log('\n【1】URL 解析');

  await t('长链 /video/<id>', () => {
    const r = dy.parseUrl('https://www.douyin.com/video/6961737553342991651');
    assert.strictEqual(r.kind, 'video');
    assert.strictEqual(r.id, '6961737553342991651');
  });

  await t('图文 /note/<id>', () => {
    const r = dy.parseUrl('https://www.douyin.com/note/6982497745948921092');
    assert.strictEqual(r.kind, 'note');
    assert.strictEqual(r.id, '6982497745948921092');
  });

  await t('短链 v.douyin.com/<code> → short（需二次请求解析）', () => {
    const r = dy.parseUrl('https://v.douyin.com/iRNBho6u/');
    assert.strictEqual(r.kind, 'short');
    assert.strictEqual(r.id, 'iRNBho6u');
  });

  await t('分享文案里夹带的链接能被抠出来', () => {
    const r = dy.parseUrl('7.65 复制打开抖音，看看【杨超越】的作品 https://v.douyin.com/iRNBho6u/ 一起看吧！');
    assert.strictEqual(r.kind, 'short');
    assert.strictEqual(r.id, 'iRNBho6u');
  });

  await t('iesdouyin 分享页 /share/video/<id>', () => {
    const r = dy.parseUrl('https://www.iesdouyin.com/share/video/6961737553342991651/?region=CN');
    assert.strictEqual(r.kind, 'video');
    assert.strictEqual(r.id, '6961737553342991651');
  });

  await t('用户主页 → user（应被 extract 拒绝，不是视频）', () => {
    const r = dy.parseUrl('https://www.douyin.com/user/MS4wLjABAAAAxxxx');
    assert.strictEqual(r.kind, 'user');
  });

  // 用户实测反馈的链接形式：抖音网页版在「列表页里弹出播放」时，
  // 作品 ID 放在查询参数 modal_id 里，路径上只有板块名。
  await t('精选页 /jingxuan?modal_id=<id>（用户实测报障的那种链接）', () => {
    const r = dy.parseUrl('https://www.douyin.com/jingxuan?modal_id=7689058205258779914');
    assert.strictEqual(r.kind, 'video');
    assert.strictEqual(r.id, '7689058205258779914');
  });

  await t('其它列表页带 modal_id 也要认：discover / follow / 首页 / 搜索结果', () => {
    for (const u of [
      'https://www.douyin.com/discover?modal_id=7689058205258779914',
      'https://www.douyin.com/follow?modal_id=7689058205258779914',
      'https://www.douyin.com/?modal_id=7689058205258779914',
      'https://www.douyin.com/search/杨超越?modal_id=7689058205258779914',
      'https://www.douyin.com/jingxuan?modal_id=7689058205258779914&other=1#top'
    ]) {
      const r = dy.parseUrl(u);
      assert.strictEqual(r.kind, 'video', `${u} 应为 video，实际 ${r.kind}`);
      assert.strictEqual(r.id, '7689058205258779914', u);
    }
  });

  await t('用户主页带 modal_id 时以视频为准（不能报「这是用户主页」）', () => {
    const r = dy.parseUrl('https://www.douyin.com/user/MS4wLjABAAAA?modal_id=7689058205258779914');
    assert.strictEqual(r.kind, 'video');
    assert.strictEqual(r.id, '7689058205258779914');
  });

  await t('路径上的作品 ID 优先于查询参数（/video/A?modal_id=B → A）', () => {
    const r = dy.parseUrl('https://www.douyin.com/video/6961737553342991651?modal_id=1111111111111111111');
    assert.strictEqual(r.id, '6961737553342991651');
  });

  await t('modal_id 不是纯数字时不误判（回退到原本的板块判断）', () => {
    assert.strictEqual(dy.parseUrl('https://www.douyin.com/jingxuan?modal_id=abc').kind, 'unknown');
    assert.strictEqual(dy.parseUrl('https://www.douyin.com/user/MS4wLjABAAAA?modal_id=abc').kind, 'user');
  });

  await t('直播：live.douyin.com/<roomid> 不能被当成视频', () => {
    const r = dy.parseUrl('https://live.douyin.com/123456789');
    assert.strictEqual(r.kind, 'live');
  });

  await t('iesdouyin 分享页 /share/note/<id> 认成图文', () => {
    const r = dy.parseUrl('https://www.iesdouyin.com/share/note/6982497745948921092/');
    assert.strictEqual(r.kind, 'note');
    assert.strictEqual(r.id, '6982497745948921092');
  });

  await t('非抖音域名 → null', () => {
    assert.strictEqual(dy.parseUrl('https://www.youtube.com/watch?v=abc'), null);
    assert.strictEqual(dy.parseUrl('https://fakedouyin.com/video/123456'), null);
    assert.strictEqual(dy.parseUrl('随便一段文字'), null);
  });

  // ==========================================================================
  console.log('\n【2】清晰度档位');

  // 形状取自真实 aweme_detail 的 bit_rate 数组
  const DETAIL = {
    aweme_id: '6961737553342991651',
    desc: '#杨超越  小小水手带你去远航❤️',
    duration: 19782,
    author: { nickname: '杨超越' },
    video: {
      bit_rate: [
        { gear_name: 'normal_1080_0', play_addr: { width: 1080, height: 1920, data_size: 6281768, url_list: ['https://v3.douyinvod.com/aaa'] } },
        { gear_name: 'normal_720_0', play_addr: { width: 720, height: 1280, data_size: 4100000, url_list: ['https://v3.douyinvod.com/bbb'] } },
        { gear_name: 'lower_540_0', play_addr: { width: 540, height: 960, data_size: 3500000, url_list: ['https://v3.douyinvod.com/ccc'] } },
        // 与 normal_720_0 同高度同大小 —— 用于验证去重
        { gear_name: 'normal_720_0', play_addr: { width: 720, height: 1280, data_size: 4100000, url_list: ['https://v3.douyinvod.com/ddd'] } }
      ]
    }
  };

  await t('按档位降序，同档去重（4 条 → 3 档）', () => {
    const v = dy.pickVariants(DETAIL);
    assert.strictEqual(v.length, 3, `期望 3 档，实际 ${v.length}`);
    assert.deepStrictEqual(v.map(x => x.tier), [1080, 720, 540]);
  });

  await t('档位取 gear_name 的数字，而不是 addr.height（竖屏 1080×1920 不能被标成 1920P）', () => {
    const v = dy.pickVariants(DETAIL);
    assert.strictEqual(v[0].label, '1080P');
    assert.strictEqual(v[0].height, 1920, '真实像素高度仍要如实保留，供界面展示');
    assert.strictEqual(v[0].width, 1080);
  });

  await t('流畅档带「（流畅）」标注，与普通档区分开', () => {
    const v = dy.pickVariants(DETAIL);
    assert.strictEqual(v[2].label, '540P（流畅）');
  });

  await t('bit_rate 为空 → 退回默认 play_addr', () => {
    const v = dy.pickVariants({ video: { play_addr: { width: 720, height: 1280, url_list: ['https://v3.douyinvod.com/only'] } } });
    assert.strictEqual(v.length, 1);
    assert.strictEqual(v[0].label, '默认');
    assert.strictEqual(v[0].tier, 720);
  });

  await t('pickBest: best → 最高档', () => {
    assert.strictEqual(dy.pickBest(dy.pickVariants(DETAIL), 'best').tier, 1080);
  });

  await t('pickBest: 按档位上限挑（1080 → 1080）', () => {
    assert.strictEqual(dy.pickBest(dy.pickVariants(DETAIL), '1080').tier, 1080);
  });

  await t('pickBest: 720 → 挑 720 而不是更高的 1080', () => {
    assert.strictEqual(dy.pickBest(dy.pickVariants(DETAIL), '720').tier, 720);
  });

  await t('pickBest: 传界面上的精确 label 时原样命中', () => {
    const vs = dy.pickVariants(DETAIL);
    const picked = dy.pickBest(vs, '540P（流畅）');
    assert.strictEqual(picked.label, '540P（流畅）');
    assert.strictEqual(picked.url, 'https://v3.douyinvod.com/ccc');
  });

  // ==========================================================================
  console.log('\n【2b】长视频的档位去重（真实数据里有 20+ 条，但只有几个清晰度）');

  // 形状取自真实长视频（30 分钟）的 bit_rate：
  // 同一清晰度有多个码率版本、h264/h265 两套编码、以及 mp4/dash 两种容器
  const mk = (gear, fmt, h265, w, h, size, id) => ({
    gear_name: gear, format: fmt, is_h265: h265,
    play_addr: { width: w, height: h, data_size: size, url_list: [`https://v3.douyinvod.com/${id}`] }
  });
  const LONG = {
    video: {
      bit_rate: [
        mk('normal_1080_0', 'mp4', 0, 1920, 1080, 900431812, 'a'),
        mk('normal_1080_0', 'dash', 0, 1920, 1080, 886527078, 'b'),
        mk('normal_720_0', 'mp4', 0, 1280, 720, 574619648, 'c'),
        mk('low_720_0', 'mp4', 0, 1280, 720, 563714458, 'd'),
        mk('low_540_0', 'mp4', 0, 1024, 576, 498397307, 'e'),
        mk('normal_540_0', 'mp4', 0, 1024, 576, 481426900, 'f'),
        mk('1080_1_1', 'mp4', 1, 1920, 1080, 389624718, 'g'),
        mk('1080_1_1', 'dash', 1, 1920, 1080, 376514656, 'h'),
        mk('adapt_low_540_0', 'mp4', 0, 1024, 576, 320574798, 'i'),
        mk('lower_540_0', 'mp4', 0, 1024, 576, 301971237, 'j'),
        mk('720_1_1', 'mp4', 1, 1280, 720, 227426683, 'k'),
        mk('720_2_1', 'mp4', 1, 1280, 720, 176308676, 'l'),
        mk('720_3_1', 'mp4', 1, 1280, 720, 149921534, 'm'),
        mk('720_4_1', 'mp4', 1, 1280, 720, 129806069, 'n'),
        mk('540_2_1', 'mp4', 1, 1024, 576, 119523119, 'o')
      ]
    }
  };

  await t('15 条压缩到 7 档（界面上不再是二十行重复的「720P」）', () => {
    assert.strictEqual(dy.pickVariants(LONG).length, 7);
  });

  await t('format=dash 的条目被排除（实测它只有视频轨，下回来是无声视频）', () => {
    const vs = dy.pickVariants(LONG);
    assert.ok(!vs.some(v => v.url.endsWith('/b')), '1080P 的 dash 条目不该出现');
    assert.ok(!vs.some(v => v.url.endsWith('/h')), 'H.265 1080P 的 dash 条目不该出现');
  });

  await t('同一档位的多个码率只留最大的那个（= 码率最高 = 画质最好）', () => {
    const vs = dy.pickVariants(LONG);
    const v1080 = vs.filter(v => v.label === '1080P');
    assert.strictEqual(v1080.length, 1);
    assert.strictEqual(v1080[0].size, 900431812);
    // 720P h265 有 4 个码率（k/l/m/n），应只留最大的 k
    const v720h = vs.find(v => v.label === '720P · H.265');
    assert.strictEqual(v720h.size, 227426683);
  });

  await t('h264 与 h265 分成两档（体积差 2 倍，用户需要能选）', () => {
    const vs = dy.pickVariants(LONG);
    assert.ok(vs.some(v => v.label === '1080P' && v.codec === 'h264' && v.size === 900431812));
    assert.ok(vs.some(v => v.label === '1080P · H.265' && v.codec === 'h265' && v.size === 389624718));
  });

  await t('「流畅」档不被同分辨率的普通档吞掉（它是弱网用户真正要的选项）', () => {
    const vs = dy.pickVariants(LONG);
    const smooth = vs.find(v => v.label === '540P（流畅）');
    assert.ok(smooth, '540P（流畅）应保留');
    assert.strictEqual(smooth.size, 301971237);
    // 普通 540P 保留体积最大的 low_540_0（498MB），而不是 481MB 的 normal_540_0
    assert.strictEqual(vs.find(v => v.label === '540P').size, 498397307);
  });

  await t('同档位时 h264 排在 h265 前面（兼容性优先）', () => {
    const vs = dy.pickVariants(LONG);
    const i1080 = vs.findIndex(v => v.label === '1080P');
    const i1080h = vs.findIndex(v => v.label === '1080P · H.265');
    assert.ok(i1080 < i1080h, '1080P 应排在 1080P · H.265 之前');
  });

  await t('pickBest: 含 H.265 的 label 能精确命中', () => {
    const vs = dy.pickVariants(LONG);
    assert.strictEqual(dy.pickBest(vs, '1080P · H.265').codec, 'h265');
  });

  await t('pickBest: 数字回退只取开头数字（"1080P · H.265" 不能被拼成 1080265）', () => {
    const vs = dy.pickVariants(LONG);
    // 若用 replace(/\D/g,'') 会得到 1080265 → fit 为空 → 退回 variants[0]，纯属巧合仍正确；
    // 这里用一个只有 h265 低档位的集合把差异暴露出来
    const only720h265 = vs.filter(v => v.tier === 720 && v.codec === 'h265');
    const picked = dy.pickBest(only720h265, '720P · H.265');
    assert.strictEqual(picked.tier, 720);
    assert.strictEqual(dy.pickBest(vs, '720').tier, 720);
  });

  await t('全是 dash 的极端情况：不静默返回空，而是保留并标注「无音轨」', () => {
    const allDash = {
      video: {
        bit_rate: [
          mk('normal_1080_0', 'dash', 0, 1920, 1080, 886527078, 'b'),
          mk('normal_720_0', 'dash', 0, 1280, 720, 574619648, 'c')
        ]
      }
    };
    const vs = dy.pickVariants(allDash);
    assert.strictEqual(vs.length, 2, '不能因为排除 dash 就把档位清空');
    assert.ok(vs.every(v => /无音轨/.test(v.label)), `应标注无音轨，实际 ${vs.map(v => v.label).join('/')}`);
  });

  // ==========================================================================
  console.log('\n【3】文件名');

  await t('原始 aweme_detail（author 是对象）→ 作者 - 描述', () => {
    const { name, ext } = dy.buildFilename(DETAIL);
    assert.strictEqual(name, '杨超越 - #杨超越  小小水手带你去远航❤️');
    assert.strictEqual(ext, 'mp4');
  });

  await t('extract() 返回（author 是字符串）也能用', () => {
    const { name } = dy.buildFilename({ author: '杨超越', desc: '你好', id: '1' });
    assert.strictEqual(name, '杨超越 - 你好');
  });

  await t('描述里的换行被压平（否则会变成文件名里的怪字符）', () => {
    const { name } = dy.buildFilename({ author: 'A', desc: '第一行\n第二行\t第三行' });
    assert.strictEqual(name, 'A - 第一行 第二行 第三行');
  });

  await t('没有作者也没有描述 → douyin_<id> 兜底', () => {
    const { name } = dy.buildFilename({ aweme_id: '999' });
    assert.strictEqual(name, 'douyin_999');
  });

  // ==========================================================================
  console.log('\n【4】来源识别');

  await t('classify 认出抖音（长链 / 短链 / iesdouyin）', () => {
    assert.strictEqual(classify('https://www.douyin.com/video/6961737553342991651'), 'douyin');
    assert.strictEqual(classify('https://v.douyin.com/iRNBho6u/'), 'douyin');
    assert.strictEqual(classify('https://www.iesdouyin.com/share/video/123456/'), 'douyin');
  });

  await t('classify 不会把抖音误判成 ytdlp', () => {
    // douyin.com 不在 VIDEO_SITES 里，且必须排在 ytdlp 判定之前
    assert.notStrictEqual(classify('https://www.douyin.com/video/6961737553342991651'), 'ytdlp');
  });

  // ==========================================================================
  console.log('\n【4b】分享文案（抖音「分享」按钮复制的是「文案 + 链接」一整段）');

  const SHARE_TEXT = '7.65 复制打开抖音，看看【杨超越】的作品 https://v.douyin.com/iRNBho6u/ 一起看吧！';

  await t('classify 能从整段文案里认出抖音（否则会被当成普通 HTTP 链接下载成 .bin）', () => {
    assert.strictEqual(classify(SHARE_TEXT), 'douyin');
  });

  await t('classify 对长链分享文案同样有效', () => {
    assert.strictEqual(classify('看看这个 https://www.douyin.com/video/6961737553342991651 不错'), 'douyin');
  });

  await t('classify 仍能认出磁力链和种子', () => {
    assert.strictEqual(classify('magnet:?xt=urn:btih:abcdef'), 'bt');
    assert.strictEqual(classify('https://example.com/a.torrent'), 'bt');
  });

  await t('classify 不会因为「文案里夹了个链接」就把普通页面误判成抖音', () => {
    assert.strictEqual(classify('看看这个 https://example.com/a.mp4 挺好'), 'http');
  });

  const { isDownloadableUrl } = require('../src/main/clipboard-url');

  await t('剪贴板：抖音分享文案（含空格）应被识别为可下载', () => {
    assert.strictEqual(isDownloadableUrl(SHARE_TEXT), true);
    assert.strictEqual(isDownloadableUrl('  ' + SHARE_TEXT + '\n'), true);
  });

  await t('剪贴板：普通带空格的文本仍应被否掉（不能因为放宽抖音而放开一切）', () => {
    assert.strictEqual(isDownloadableUrl('这是一句普通的话 https://example.com 结束'), false);
    assert.strictEqual(isDownloadableUrl('随便一段没有链接的文字'), false);
  });

  await t('剪贴板：普通 URL / 磁力链照常放行，非法协议否掉', () => {
    assert.strictEqual(isDownloadableUrl('https://example.com/a.zip'), true);
    assert.strictEqual(isDownloadableUrl('magnet:?xt=urn:btih:abc'), true);
    assert.strictEqual(isDownloadableUrl('file:///etc/passwd'), false);
    assert.strictEqual(isDownloadableUrl(''), false);
  });

  await t('剪贴板：超长文本被否掉（防止把一整篇文档当链接）', () => {
    assert.strictEqual(isDownloadableUrl('https://example.com/' + 'a'.repeat(2100)), false);
  });

  // ==========================================================================
  console.log('\n【5】队列集成（真实 HTTP 下载，验证 Referer 真的发出去了）');

  // 一段可校验的"视频"内容
  const payload = crypto.randomBytes(256 * 1024);
  const wantSha = crypto.createHash('sha256').update(payload).digest('hex');
  const seen = { referer: null, ua: null, rangeHits: 0, bare403: 0 };

  // 模拟抖音 CDN：没有 Referer 一律 403（真实环境实测就是如此）
  const cdn = http.createServer((req, res) => {
    seen.referer = req.headers.referer || null;
    seen.ua = req.headers['user-agent'] || null;
    if (req.headers.referer !== 'https://www.douyin.com/') {
      seen.bare403++;
      res.writeHead(403); return res.end('Blocked');
    }
    const range = req.headers.range;
    if (range) {
      seen.rangeHits++;
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : payload.length - 1;
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1
      });
      return res.end(payload.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise(r => cdn.listen(0, '127.0.0.1', r));
  const cdnUrl = `http://127.0.0.1:${cdn.address().port}/aweme/v1/play/?video_id=fake`;

  const queue = new Queue();
  const DY_URL = 'https://www.douyin.com/video/6961737553342991651';
  const meta = { author: '杨超越', desc: '小小水手', durationMs: 19782, quality: '1080P', width: 1080, height: 1920, variantCount: 3 };
  const fakeFilename = '杨超越 - 小小水手.mp4';

  await t('未注册解析器时 add 直接报错（而不是静默失败）', async () => {
    const q2 = new Queue();
    await assert.rejects(() => q2.add(DY_URL), /解析器未注册/);
  });

  queue.setDouyinResolver(async (url, opts) => ({
    url: cdnUrl,
    headers: dy.mediaHeaders(),
    filename: fakeFilename,
    meta: { ...meta, quality: opts.quality || '1080P' }
  }));

  let id = null;
  await t('add 建出 douyin 任务：kind/source/headers/meta 都齐', async () => {
    id = await queue.add(DY_URL);
    const task = queue.tasks.get(id);
    assert.strictEqual(task.type, 'douyin');
    assert.strictEqual(task.kind, 'douyin');
    assert.strictEqual(task.source, '抖音');
    assert.strictEqual(task.directUrl, cdnUrl);
    assert.strictEqual(task.headers.referer, 'https://www.douyin.com/');
    assert.strictEqual(task.meta.author, '杨超越');
    assert.strictEqual(task.filename, fakeFilename);
    assert.strictEqual(path.dirname(task.filePath), dlDir);
  });

  await t('界面快照把 kind 报成 douyin（不是底层引擎的 http）', () => {
    const s = queue.snapshotAll().find(x => x.id === id);
    assert.strictEqual(s.kind, 'douyin');
    assert.strictEqual(s.source, '抖音');
  });

  await t('下载完成，内容与源文件一致（且全程带 Referer，未触发 403）', async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const task = queue.tasks.get(id);
      if (task.status === 'completed') break;
      if (task.status === 'error') throw new Error(`下载失败: ${task.error}`);
      await sleep(120);
    }
    const task = queue.tasks.get(id);
    assert.strictEqual(task.status, 'completed', `最终状态 ${task.status}`);
    assert.strictEqual(sha256(task.filePath), wantSha);
    assert.strictEqual(seen.referer, 'https://www.douyin.com/');
    assert.ok(/Chrome\//.test(seen.ua || ''), `UA 应被替换成浏览器 UA，实际 ${seen.ua}`);
    assert.strictEqual(seen.bare403, 0, '不应有任何一个不带 Referer 的请求');
  });

  await t('下载真的走了多线程分段（不是单连接拉完）', () => {
    assert.ok(seen.rangeHits > 0, `期望出现 Range 请求，实际 ${seen.rangeHits}`);
  });

  await t('断点元数据带 resumeKey（直链含时效签名，不能靠 url 比对）', async () => {
    // 下载成功后 .tdmmeta.json 会被清掉，所以这里直接验证写入契约
    const { HttpDownloader } = require('../src/engine/downloader');
    const f = path.join(dlDir, 'meta-probe.bin');
    const d = new HttpDownloader({
      id: 1, url: 'http://signed/', headers: {}, filePath: f,
      threads: 1, size: 100, resumeKey: `douyin:${DY_URL}:best`
    });
    d.segments = [{ index: 0, start: 0, end: 99, done: 0 }];
    await d._persist();
    const m = JSON.parse(fs.readFileSync(f + '.tdmmeta.json', 'utf8'));
    assert.strictEqual(m.resumeKey, `douyin:${DY_URL}:best`);
  });

  await t('任务记录持久化了 kind/quality/meta，重启后界面仍显示抖音', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'tasks.json'), 'utf8'));
    const rec = saved.find(x => x.id === id);
    assert.strictEqual(rec.kind, 'douyin');
    assert.strictEqual(rec.source, '抖音');
    assert.strictEqual(rec.meta.author, '杨超越');

    // 新队列实例从磁盘恢复
    const q3 = new Queue();
    await q3.loadPersisted();
    const s3 = q3.snapshotAll().find(x => x.id === id);
    assert.strictEqual(s3.kind, 'douyin');
    assert.strictEqual(s3.source, '抖音');
    assert.strictEqual(s3.meta.desc, '小小水手');
  });

  await t('恢复时沿用任务自己记的清晰度，而不是退回全局默认', async () => {
    const q4 = new Queue();
    const calls = [];
    q4.setDouyinResolver(async (url, opts) => { calls.push(opts.quality); return { url: cdnUrl, headers: dy.mediaHeaders(), filename: fakeFilename, meta }; });
    await q4.loadPersisted();
    const task = q4.tasks.get(id);
    task.quality = '720P';        // 用户当初选的是 720P
    config.save({ douyinQuality: 'best' }); // 全局默认仍是 best
    task.status = 'pending';
    await q4._startTask(task);
    assert.strictEqual(calls[0], '720P', `解析器收到的清晰度应为 720P，实际 ${calls[0]}`);
    await q4.pause(task.id);
  });

  await t('resumeKey 让"直链变了"也能续传（url 参与比对时是做不到的）', async () => {
    const metaPath = path.join(dlDir, 'resume.bin.tdmmeta.json');
    const f = path.join(dlDir, 'resume.bin');
    fs.writeFileSync(f + '.part', Buffer.alloc(10));
    fs.writeFileSync(metaPath, JSON.stringify({
      version: 1, url: 'http://old-signed-url/', finalUrl: null, headers: {},
      filePath: f, size: 10, etag: 'x', lastModified: null, resumeKey: 'douyin:AAA:best',
      segments: [{ start: 0, end: 9, done: 10 }]
    }));
    const { HttpDownloader } = require('../src/engine/downloader');
    const d = new HttpDownloader({
      id: 99, url: 'http://brand-new-signed-url/', headers: {}, filePath: f,
      threads: 2, size: 10, resumeKey: 'douyin:AAA:best'
    });
    assert.strictEqual(await d._tryResume(), true, '同 resumeKey + 同 size 应判定为同一资源');

    const d2 = new HttpDownloader({
      id: 100, url: 'http://brand-new-signed-url/', headers: {}, filePath: f,
      threads: 2, size: 10, resumeKey: 'douyin:AAA:720P'
    });
    assert.strictEqual(await d2._tryResume(), false, '换了清晰度必须重新开始，不能混着续');
  });

  cdn.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  通过 ${pass} / ${pass + fail}${fail ? `  失败 ${fail}` : ''}`);
  console.log(`${'='.repeat(56)}`);
  process.exit(fail === 0 ? 0 : 1);
})();
