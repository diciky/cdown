// TDM Fast - 渲染进程 UI 逻辑
let tasks = [];
let filter = 'all';

const $ = sel => document.querySelector(sel);
const listEl = $('#task-list');

const KIND_LABEL = { http: 'HTTP', hls: 'HLS', ytdlp: '视频' };
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
        <span class="thread-info" title="${t.kind === 'ytdlp' ? '并发分片' : '并行线程'}">⚡ ${t.threads} ${t.kind === 'ytdlp' ? '并发' : '线程'}</span>
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
  return `
    <div class="detail">
      ${t.error ? `<div class="err-msg">${escapeHtml(t.error)}</div>` : ''}
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
    if (t) window.tdm.showItem(t.filePath);
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

async function addTask(url, threads) {
  const input = $('#url-input');
  const finalUrl = (url || input.value).trim();
  if (!finalUrl) return toast('请先粘贴下载链接', true);
  const finalThreads = Math.min(64, Math.max(1, Number(threads ?? $('#threads-input').value) || 32));
  try {
    await window.tdm.addTask(finalUrl, { threads: finalThreads });
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
    clipboardMonitor: $('#cfg-clipboard').checked
  });
  modal.classList.add('hidden');
  toast('设置已保存');
});

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
