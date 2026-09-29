// CDown - 剪贴板文本是否是可下载链接
//
// 单独成模块的原因和 reveal.js 一样：这是纯逻辑，不依赖 Electron，可以单测。
// 它被 main.js 的剪贴板轮询每 1.2 秒调用一次，判定错了用户就会一直收到误弹窗
// （或者该弹的时候不弹），属于值得锁住的边界。

// 抖音分享出来的是「文案 + 链接」一整段，例如：
//   "7.65 复制打开抖音，看看【杨超越】的作品 https://v.douyin.com/iRNBho6u/ 一起看吧！"
// 这种文本含空格，按普通 URL 的规则会被否掉，所以要单独放行。
const DOUYIN_IN_TEXT = /https?:\/\/(?:[\w-]+\.)*(?:douyin|iesdouyin)\.com\//i;

function isDownloadableUrl(text) {
  const t = String(text || '').trim();
  // 磁力链里不能有空白（含换行），但长度通常远超普通 URL，所以先单独放行再限长
  if (/^magnet:\?/i.test(t)) return t.length <= 4000;
  if (!t || t.length > 2000) return false;
  if (DOUYIN_IN_TEXT.test(t)) return true;
  if (/\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

module.exports = { isDownloadableUrl, DOUYIN_IN_TEXT };
