// TDM Fast - 渲染进程 UI 逻辑
let tasks = [];
let filter = 'all';

const $ = sel => document.querySelector(sel);
const listEl = $('#task-list');

const KIND_LABEL = { http: 'HTTP', hls: 'HLS', ytdlp: '视频', bt: 'BT', douyin: '抖音' };
const STATUS_LABEL = {
  pending: '排队中', probing: '探测中', downloading: '下载中',
  merging: '合并中', paused: '已暂停', completed: '已完成', error: '出错'
};

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function matchesFilter(t) {
  if (filter === 'all') return true;
  if (filter === 'active') return ['pending', 'probing', 'downloading', 'merging', 'paused'].includes(t.status);
  return t.status === filter;
}

function render() {
  const visible = tasks.filter(matchesFilter);
  $('#count-all').textContent = tasks.length;
  $('#count-active').textContent = tasks.filter(t => ['pending', 'probing', 'downloading', 'merging'].includes(t.status)).length;
  $('#count-completed').textContent = tasks.filter(t => t.status === 'completed').length;
  $('#count-error').textContent = tasks.filter(t => t.status === 'error').length;

  if (visible.length === 0) {
    listEl.innerHTML = `<div class="empty">暂无任务<br>粘贴链接开始你的第一次满速下载 ⚡</div>`;
    return;
  }
  listEl.innerHTML = visible.map(t => {
    const expanded = expandedIds.has(t.id);
    // 操作按钮严格互斥：按状态只渲染一种主操作
    let ops = '';
    if (t.status === 'completed') ops = `<button class="ghost small" data-op="open" title="打开所在文件夹">📁</button>`;
    else if (['downloading', 'probing', 'merging'].includes(t.status)) ops = `<button class="ghost small" data-op="pause" title="暂停">⏸</button>`;
    else if (['paused', 'error', 'pending'].includes(t.status)) ops = `<button class="ghost small" data-op="resume" title="${t.status === 'error' ? '重试' : '继续'}">${t.status === 'error' ? '🔄' : '▶'}</button>`;
    // 重新下载：非进行中的任务都可一键清进度重来
    const canRestart = ['paused', 'error', 'completed'].includes(t.status);
    // BT 没有「线程」概念，它由 aria2 管理 peer 连接，因此展示连接数与做种者数更有意义
    const isBt = t.kind === 'bt';
    const isYt = t.kind === 'ytdlp';
    const isDy = t.kind === 'douyin';
    const threadTitle = isBt ? '已连接的 peer 数量' : (isYt ? '并发分片' : '并行线程');
    const threadLabel = isBt ? `${t.connections || 0} 连接` : `${t.threads} ${isYt ? '并发' : '线程'}`;
    return `
    <div class="task ${t.status} ${expanded ? 'expanded' : ''}" data-id="${t.id}">
      <div class="row1 clickable" data-op="toggle">
        <span class="kind kind-${t.kind}">${KIND_LABEL[t.kind] || t.kind}</span>
        <span class="src" title="来源: ${escapeHtml(t.source || '')}">${escapeHtml(t.source || '')}</span>
        <span class="name" title="${escapeHtml(t.filename)}">${escapeHtml(t.filename)}</span>
        <span class="status st-${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
      </div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${t.progress}%"></div></div>
      <div class="row2">
        <span>${t.progress}%</span>
        <span>${fmtBytes(t.downloaded)} / ${t.sizeText || '-'}</span>
        <span>${t.speedText || ''}</span>
        <span class="thread-info" title="${threadTitle}">⚡ ${threadLabel}</span>
        ${isBt ? `<span class="thread-info" title="当前可见的做种者数量">🌱 ${t.seeders || 0}</span>` : ''}
        ${isDy && t.meta && t.meta.quality ? `<span class="thread-info" title="抖音清晰度档位">🎬 ${escapeHtml(t.meta.quality)}</span>` : ''}
        ${t.segments ? `<span class="thread-info">▐ ${t.activeThreads}/${t.segments} 段</span>` : ''}
        <span class="grow"></span>
        <div class="ops">
          ${ops}
          ${canRestart ? `<button class="ghost small" data-op="restart" title="重新下载（清除进度从头开始）">↻</button>` : ''}
          <button class="ghost small" data-op="toggle" title="详情 / 日志">📋</button>
          <button class="ghost small" data-op="remove" title="删除任务">🗑</button>
        </div>
      </div>
      ${t.error && !expanded ? `<div class="err-msg">${escapeHtml(t.error)} <a class="copy-err" data-op="copy-log">复制日志</a></div>` : ''}
      ${expanded ? renderDetail(t) : ''}
    </div>`;
  }).join('');
}

function renderDetail(t) {
  const segGrid = (t.segDetail && t.segDetail.length)
    ? `<div class="seg-grid">${t.segDetail.map(s => {
        const pct = s.total > 0 ? Math.min(100, (s.done / s.total) * 100) : (s.done > 0 ? 50 : 0);
        const cls = pct >= 100 ? 'done' : (s.active ? 'active' : (pct > 0 ? 'partial' : 'wait'));
        return `<div class="seg-cell ${cls}" style="--p:${pct}%" title="分段 ${s.i + 1}: ${fmtBytes(s.done)}/${fmtBytes(s.total)} ${s.active ? '（下载中）' : ''}"></div>`;
      }).join('')}</div>
      <div class="seg-legend"><span class="lg done"></span>完成 <span class="lg active"></span>下载中 <span class="lg partial"></span>部分 <span class="lg wait"></span>等待</div>`
    : '';
  const logs = (t.logs && t.logs.length) ? t.logs.join('\n') : '（暂无日志）';
  const dy = (t.kind === 'douyin' && t.meta) ? `
      <div class="dy-card">
        <div class="dy-card-row"><b>作者</b><span>${escapeHtml(t.meta.author || '-')}</span></div>
        <div class="dy-card-row"><b>文案</b><span>${escapeHtml(t.meta.desc || '-')}</span></div>
        <div class="dy-card-row"><b>清晰度</b><span>${escapeHtml(t.meta.quality || '-')}${t.meta.width && t.meta.height ? ` · ${t.meta.width}×${t.meta.height}` : ''}${t.meta.variantCount ? `（共 ${t.meta.variantCount} 档）` : ''}</span></div>
        ${t.meta.durationMs ? `<div class="dy-card-row"><b>时长</b><span>${fmtDuration(t.meta.durationMs)}</span></div>` : ''}
      </div>` : '';
  return `
    <div class="detail">
      ${t.error ? `<div class="err-msg">${escapeHtml(t.error)}</div>` : ''}
      ${dy}
      ${segGrid}
      <div class="log-box">${escapeHtml(logs)}</div>
      <div class="detail-actions">
        <button class="ghost small" data-op="copy-log">📋 复制日志</button>
        <button class="ghost small" data-op="copy-url">🔗 复制链接</button>
        <span class="dim">来源: ${escapeHtml(t.source || '-')} ｜ 目标: ${escapeHtml(t.filePath || '')}</span>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const expandedIds = new Set();

listEl.addEventListener('click', async e => {
  const btn = e.target.closest('[data-op]');
  if (!btn) return;
  const id = Number(btn.closest('.task').dataset.id);
  const op = btn.dataset.op;
  if (op === 'toggle') {
    expandedIds.has(id) ? expandedIds.delete(id) : expandedIds.add(id);
    render();
  } else if (op === 'pause') await window.tdm.pause(id);
  else if (op === 'resume') await window.tdm.resume(id);
  else if (op === 'remove') { expandedIds.delete(id); await window.tdm.remove(id); }
  else if (op === 'restart') {
    if (!confirm('重新下载将清除当前进度，从头开始。确定吗？')) return;
    await window.tdm.restart(id);
    toast('已重新开始下载');
  }
  else if (op === 'copy-url') {
    const t = tasks.find(x => x.id === id);
    if (t) { await window.tdm.copyText(t.url); toast('链接已复制'); }
  }
  else if (op === 'open') {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    // 主进程会做三级降级（精确命中 → 推断真实文件 → 打开所在目录），
    // 这里必须把结果告诉用户，否则「什么都没发生」无法与「已成功打开」区分。
    const r = await window.tdm.showItem(t.filePath);
    if (r && r.ok === false) toast(r.error || '无法定位文件', true);
    else if (r && r.note) toast(r.note);
  } else if (op === 'copy-log') {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const text = [
      `CDown 日志 - ${t.filename}`,
      `URL: ${t.url}`,
      `状态: ${t.status}  进度: ${t.progress}%  (${fmtBytes(t.downloaded)} / ${t.sizeText})`,
      t.error ? `错误: ${t.error}` : '',
      '',
      ...(t.logs && t.logs.length ? t.logs : ['（暂无日志）'])
    ].join('\n');
    await window.tdm.copyText(text);
    toast('日志已复制到剪贴板');
  }
});

async function addTask(url, threads, opts = {}) {
  const input = $('#url-input');
  const finalUrl = (url || input.value).trim();
  if (!finalUrl) return toast('请先粘贴下载链接', true);
  // 抖音链接不能直接加：要先跑一次解析，把清晰度档位摆给用户选，
  // 否则只能盲选一档，用户既看不到有哪些档、也不知道自己在下哪一档。
  if (!opts.quality && isDouyinUrl(finalUrl)) return openDouyinModal(finalUrl, threads);
  const finalThreads = Math.min(64, Math.max(1, Number(threads ?? $('#threads-input').value) || 32));
  try {
    await window.tdm.addTask(finalUrl, { threads: finalThreads, quality: opts.quality });
    input.value = '';
    toast('任务已添加');
  } catch (e) {
    toast(`添加失败：${e.message?.replace?.('Error invoking remote method \'tasks:add\': Error: ', '') || e}`, true);
  }
}
$('#btn-add').addEventListener('click', () => addTask());
$('#url-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
$('#threads-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
$('#btn-pause-all').addEventListener('click', () => window.tdm.pauseAll());
$('#btn-clear-completed').addEventListener('click', () => window.tdm.clearCompleted());

// 版本号从主进程取，避免界面写死的版本号和 package.json 漂移
window.tdm.appVersion?.().then(v => {
  const el = $('#about-version');
  if (el && v) el.textContent = 'v' + v;
}).catch(() => {});

// 链接复制 / 导出
$('#btn-copy-links').addEventListener('click', async () => {
  if (tasks.length === 0) return toast('暂无任务', true);
  await window.tdm.copyText(tasks.map(t => t.url).join('\n'));
  toast(`已复制 ${tasks.length} 条链接`);
});
$('#btn-export-links').addEventListener('click', async () => {
  if (tasks.length === 0) return toast('暂无任务', true);
  const p = await window.tdm.exportLinks();
  if (p) toast('已导出: ' + p);
});

// 标签切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    filter = tab.dataset.filter;
    render();
  });
});

// 设置
const modal = $('#settings-modal');
$('#btn-settings').addEventListener('click', async () => {
  const cfg = await window.tdm.getConfig();
  $('#cfg-dir').value = cfg.downloadDir;
  $('#cfg-threads').value = cfg.maxThreads;
  $('#cfg-concurrent').value = cfg.maxConcurrent;
  $('#cfg-clipboard').checked = cfg.clipboardMonitor !== false;
  $('#cfg-bt-seed').value = cfg.btSeedTime ?? 0;
  $('#cfg-bt-trackers').value = cfg.btTrackers || '';
  modal.classList.remove('hidden');
});
$('#btn-settings-cancel').addEventListener('click', () => modal.classList.add('hidden'));
$('#btn-choose-dir').addEventListener('click', async () => {
  const dir = await window.tdm.chooseDir();
  if (dir) $('#cfg-dir').value = dir;
});
$('#btn-settings-save').addEventListener('click', async () => {
  await window.tdm.setConfig({
    downloadDir: $('#cfg-dir').value,
    maxThreads: Math.min(64, Math.max(1, Number($('#cfg-threads').value) || 32)),
    maxConcurrent: Math.min(10, Math.max(1, Number($('#cfg-concurrent').value) || 3)),
    clipboardMonitor: $('#cfg-clipboard').checked,
    btSeedTime: Math.max(0, Number($('#cfg-bt-seed').value) || 0),
    btTrackers: $('#cfg-bt-trackers').value.trim()
  });
  modal.classList.add('hidden');
  toast('设置已保存');
});

// ---------- 网址嗅探 ----------
const sniffModal = $('#sniff-modal');
let sniffItems = [];
let sniffing = false;

function sniffStatusLabel(t) {
  const labels = { video: '视频站点', audio: '音频站点', audiofile: '音频', image: '图片', document: '文档', archive: '压缩包', executable: '程序', subtitle: '字幕', videoPlaylist: '视频流', direct: '直链', unknown: '文件' };
  return labels[t] || t || '文件';
}

function fmtSize(n) { return n ? fmtBytes(n) : '未知'; }

function renderSniffResults() {
  const box = $('#sniff-results');
  if (sniffItems.length === 0) { box.innerHTML = '<div class="sniff-empty">未发现可下载内容</div>'; return; }
  box.innerHTML = sniffItems.map((it, i) => `
    <label class="sniff-item">
      <input type="checkbox" class="sniff-check" data-i="${i}" checked />
      <span class="sniff-ext">${it.ext || '?'}</span>
      <span class="sniff-label" title="${escapeHtml(it.label || it.url)}">${escapeHtml(it.label || it.url)}</span>
      <span class="sniff-meta">${escapeHtml(it.typeLabel || it.type || '')}</span>
      <span class="sniff-size">${fmtSize(it.size)}</span>
    </label>`).join('');
  box.querySelectorAll('.sniff-check').forEach(cb => cb.addEventListener('change', updateSniffButtons));
}

function updateSniffButtons() {
  const any = !!document.querySelector('.sniff-check:checked');
  $('#btn-sniff-download').disabled = !any || sniffing;
  const boxes = [...document.querySelectorAll('.sniff-check')];
  $('#sniff-checkall').checked = boxes.length > 0 && boxes.every(b => b.checked);
}

async function doSniff() {
  if (sniffing) return;
  const url = $('#sniff-url').value.trim();
  if (!url) { toast('请输入要嗅探的网址', true); return; }
  sniffing = true;
  $('#btn-sniff-go').disabled = true;
  $('#btn-sniff-download').disabled = true;
  const status = $('#sniff-status');
  status.textContent = '⏳ 正在嗅探页面，视频站点解析可能需要几秒…';
  $('#sniff-results').innerHTML = '';
  try {
    const r = await window.tdm.sniffUrl(url);
    if (r.error) { status.textContent = '❌ ' + r.error; return; }
    if (!r.items || r.items.length === 0) { status.textContent = '未发现可下载内容'; return; }
    status.textContent = r.extractor
      ? `✅ ${r.extractor}：${r.title || ''}（${r.items.length} 个画质/音质可选）`
      : `✅ 发现 ${r.items.length} 个可下载项`;
    sniffItems = r.items.map(it => ({
      ...it,
      typeLabel: it.typeLabel || sniffStatusLabel(it.type),
      ext: (it.ext || '?').toUpperCase()
    }));
    renderSniffResults();
  } catch (e) {
    status.textContent = '❌ 嗅探失败: ' + (e.message || e);
  } finally {
    sniffing = false;
    $('#btn-sniff-go').disabled = false;
    updateSniffButtons();
  }
}

async function downloadSniffed() {
  const checked = [...document.querySelectorAll('.sniff-check:checked')]
    .map(cb => sniffItems[Number(cb.dataset.i)]).filter(Boolean);
  if (checked.length === 0) return;
  const threads = Math.min(64, Math.max(1, Number($('#sniff-threads').value) || 32));
  let ok = 0, fail = 0;
  for (const it of checked) {
    try {
      await window.tdm.addTask(it.url, { threads, format: it.formatId || undefined, formatExt: it.formatId ? (it.ext || 'mp4').toLowerCase() : undefined });
      ok++;
    } catch { fail++; }
  }
  sniffModal.classList.add('hidden');
  toast(fail ? `已添加 ${ok} 个任务，${fail} 个失败` : `已添加 ${ok} 个下载任务`);
}

$('#btn-sniff').addEventListener('click', () => {
  $('#sniff-url').value = $('#url-input').value.trim();
  sniffModal.classList.remove('hidden');
  if ($('#sniff-url').value) doSniff();
  else $('#sniff-url').focus();
});
$('#btn-sniff-go').addEventListener('click', doSniff);
$('#sniff-url').addEventListener('keydown', e => { if (e.key === 'Enter') doSniff(); });
$('#btn-sniff-download').addEventListener('click', downloadSniffed);
$('#btn-sniff-close').addEventListener('click', () => sniffModal.classList.add('hidden'));
sniffModal.addEventListener('click', e => { if (e.target === sniffModal) sniffModal.classList.add('hidden'); });
$('#sniff-checkall').addEventListener('change', () => {
  const on = $('#sniff-checkall').checked;
  document.querySelectorAll('.sniff-check').forEach(cb => { cb.checked = on; });
  updateSniffButtons();
});

// ---------- 抖音 ----------
// 抖音必须走应用内解析（隐藏窗口跑 JS 挑战换 s_v_web_id，再调 detail 接口拿无水印直链），
// 不能交给 yt-dlp —— 它的 DouyinIE 自己不生成签名 cookie，实测喂 cookie 也 403。
const dyModal = $('#douyin-modal');
let dyCurrent = null; // { url, threads, variants, selected }

// 抖音的分享按钮复制出来的是「文案 + 链接」一整段，所以不能直接 new URL()，
// 要先把里面的链接抠出来（与 queue.js 的 classify 保持一致的口径）。
function isDouyinUrl(u) {
  const m = String(u || '').match(/https?:\/\/[^\s，,。；;、]+/);
  try {
    const h = new URL(m ? m[0] : String(u || '').trim()).hostname.toLowerCase();
    return /(^|\.)(douyin|iesdouyin)\.com$/.test(h);
  } catch { return false; }
}

async function openDouyinModal(url, threads) {
  dyCurrent = null;
  const cover = $('#dy-cover');
  cover.removeAttribute('src');
  cover.style.display = 'none';
  $('#dy-author').textContent = '';
  $('#dy-desc').textContent = '';
  $('#dy-stats').textContent = '';
  $('#dy-variants').innerHTML = '';
  $('#btn-dy-add').disabled = true;
  $('#dy-status').textContent = '⏳ 正在通过抖音验证并解析无水印地址…（首次需要跑一次验证，约 2–5 秒）';
  dyModal.classList.remove('hidden');

  let r;
  try { r = await window.tdm.douyinExtract(url); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!dyModal || dyModal.classList.contains('hidden')) return; // 解析期间用户已关闭
  if (!r.ok) { $('#dy-status').textContent = '❌ ' + r.error; return; }
  if (r.isImages) {
    $('#dy-status').textContent = `❌ 这是图文作品（${r.imageCount} 张图），当前版本只支持下载视频`;
    return;
  }
  if (!r.variants.length) { $('#dy-status').textContent = '❌ 没有解析到可下载的视频流'; return; }

  dyCurrent = { url, threads, variants: r.variants, selected: 0 };
  $('#dy-author').textContent = r.author || '';
  $('#dy-desc').textContent = r.desc || '';
  $('#dy-stats').textContent = [fmtDuration(r.durationMs), r.music].filter(Boolean).join(' · ');
  if (r.cover) { cover.src = r.cover; cover.style.display = ''; }
  $('#dy-status').textContent = `✅ 共 ${r.variants.length} 档清晰度，选一档开始下载`;
  $('#dy-variants').innerHTML = r.variants.map((v, i) => `
    <label class="dy-variant">
      <input type="radio" name="dy-quality" value="${i}" ${i === 0 ? 'checked' : ''} />
      <span class="dy-q-label">${escapeHtml(v.label || '默认')}</span>
      <span class="dy-q-dim">${v.width && v.height ? `${v.width}×${v.height}` : ''}</span>
      <span class="dy-q-size">${v.size ? fmtBytes(v.size) : ''}</span>
    </label>`).join('');
  $('#dy-variants').querySelectorAll('input[name="dy-quality"]').forEach(el => {
    el.addEventListener('change', () => { if (dyCurrent) dyCurrent.selected = Number(el.value); });
  });
  $('#btn-dy-add').disabled = false;
}

$('#btn-dy-add').addEventListener('click', async () => {
  if (!dyCurrent) return;
  const { url, threads, variants, selected } = dyCurrent;
  dyCurrent = null;
  dyModal.classList.add('hidden');
  const v = variants[selected];
  // 传 label 而不是高度：同一高度可能有「普通」和「流畅」两档，只有 label 能唯一指定
  await addTask(url, threads, { quality: v ? v.label : undefined });
});
$('#btn-dy-cancel').addEventListener('click', () => { dyCurrent = null; dyModal.classList.add('hidden'); });
dyModal.addEventListener('click', e => { if (e.target === dyModal) $('#btn-dy-cancel').click(); });

// ---------- 剪贴板自动识别 ----------
const cbModal = $('#clipboard-modal');
let cbCurrent = null;
const cbDismissed = new Set();

window.tdm.onClipboardUrl(url => {
  if (cbModal.classList.contains('hidden') === false || cbDismissed.has(url)) return;
  // 已存在相同 URL 的任务则不重复询问
  if (tasks.some(t => t.url === url)) return;
  cbCurrent = url;
  $('#clipboard-url').textContent = url.length > 90 ? url.slice(0, 90) + '…' : url;
  $('#clipboard-url').title = url;
  $('#cb-threads').value = $('#threads-input').value;
  cbModal.classList.remove('hidden');
});

$('#btn-cb-add').addEventListener('click', async () => {
  if (!cbCurrent) return;
  const url = cbCurrent;
  cbDismissed.add(url);
  cbCurrent = null;
  cbModal.classList.add('hidden');
  await window.tdm.markClipboardHandled();
  await addTask(url, Number($('#cb-threads').value));
});

$('#btn-cb-ignore').addEventListener('click', async () => {
  if (cbCurrent) cbDismissed.add(cbCurrent);
  cbCurrent = null;
  cbModal.classList.add('hidden');
  await window.tdm.markClipboardHandled();
});
cbModal.addEventListener('click', e => { if (e.target === cbModal) $('#btn-cb-ignore').click(); });

// 实时刷新
window.tdm.onTasksUpdated(list => { tasks = list; render(); });
window.tdm.onTaskDone(s => toast(`✔ 下载完成：${s.filename}`));
window.tdm.onTaskError(s => { if (s.id) expandedIds.add(s.id); toast(`✖ ${s.filename}: ${s.error}`, true); });
window.tdm.onAddFailed(s => toast(`添加失败：${s.error}`, true));

// 启动
(async () => { tasks = await window.tdm.listTasks(); render(); })();
