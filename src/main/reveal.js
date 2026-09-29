// CDown - 「在访达/资源管理器中定位文件」的路径解析
//
// 单独成模块的原因：这段逻辑不依赖 Electron，可以直接跑单元测试。
// 它要解决的问题是——shell.showItemInFolder() 对不存在的路径**静默无反应**，
// 而任务记录里的路径与实际文件不一致是常态：
//   * 用户移动/重命名/删除了文件；
//   * 下载完成时扩展名被纠正过（m3u8 实际合并成了 .mp4，yt-dlp 自行选了 .mkv）；
//   * 任务记录是旧版本写的，命名规则已变；
//   * 文件名过长被截断。
// 因此这里做三级降级，并且**永远给出一个明确结果**，让界面能如实提示用户。
const fsp = require('fs/promises');
const path = require('path');

// 同一份内容可能落在的容器后缀，按可能性排序
const FALLBACK_EXTS = ['.mp4', '.mkv', '.ts', '.flv', '.webm', '.mp3', '.m4a', '.zip', '.bin'];

// CDown 自己的中间产物，永远不该被当成「用户要看的文件」
const ARTIFACT_SUFFIXES = ['.hlsmeta.json', '.tdmmeta.json', '.part', '.hls.tmp'];

function isArtifact(name) {
  return ARTIFACT_SUFFIXES.some(s => name.endsWith(s)) || /^\.cdown-path-\d+\.txt$/.test(name);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * 解析应该在文件管理器里定位的路径。
 * @param {string} p 任务记录的 filePath
 * @returns {Promise<{ok:boolean, mode?:'select'|'open-dir', path?:string, note?:string, error?:string}>}
 *   mode='select'   → 调用方用 showItemInFolder(path) 选中该文件
 *   mode='open-dir' → 调用方用 openPath(path) 打开该目录
 */
async function resolveRevealTarget(p) {
  if (!p || typeof p !== 'string') return { ok: false, error: '该任务没有记录文件路径' };

  // 1) 文件就在原地
  if (await exists(p)) return { ok: true, mode: 'select', path: p };

  const dir = path.dirname(p);
  const base = path.basename(p);
  const stem = base.replace(/\.[^.]+$/, '');

  // 2) 只是容器后缀不同
  for (const ext of FALLBACK_EXTS) {
    if (base.toLowerCase().endsWith(ext)) continue;
    const cand = path.join(dir, stem + ext);
    if (await exists(cand)) return { ok: true, mode: 'select', path: cand, note: `已定位到 ${path.basename(cand)}` };
  }

  // 3) 文件名被截断/改写 —— 按前缀在目录里找
  if (stem.length >= 12) {
    const names = await fsp.readdir(dir).catch(() => []);
    const prefix = stem.slice(0, 12);
    const hit = names.find(n => n.startsWith(prefix) && !isArtifact(n));
    if (hit) {
      const cand = path.join(dir, hit);
      return { ok: true, mode: 'select', path: cand, note: `已定位到 ${hit}` };
    }
  }

  // 4) 文件确实没了 —— 至少打开所在目录，比毫无反应有用
  if (await exists(dir)) {
    return { ok: true, mode: 'open-dir', path: dir, note: '原文件已不在，已打开所在文件夹' };
  }

  return { ok: false, error: `文件不存在：${p}` };
}

module.exports = { resolveRevealTarget, isArtifact, FALLBACK_EXTS };
