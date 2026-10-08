'use strict';

/**
 * 视频探测纯逻辑（不依赖 electron / DOM，可在 Node 中直接单测）。
 * webview-preload.js 在浏览器（预加载）环境里引用本模块做实际的 DOM 提取，
 * 同时 Node 单测直接 require 本模块验证分类 / 去重 / 合并逻辑，避免「测副本」。
 */

// 依据 URL 判断视频类型：
//  - m3u8  -> 'hls'（HLS 流，需经 ffmpeg 转封装）
//  - .mp4/.m4v -> 'mp4'
//  - 其它（webm、blob、空） -> 'other'
function classifyVideoUrl(url) {
  if (!url) return 'other';
  if (/m3u8/i.test(url)) return 'hls';
  if (/\.(mp4|m4v)(\?|$)/i.test(url)) return 'mp4';
  return 'other';
}

// 把相对地址解析为绝对地址；解析失败原样返回（兼容 data:/blob: 等）。
function normalizeUrl(raw, base) {
  if (!raw) return raw;
  try {
    return new URL(raw, base || undefined).href;
  } catch (_) {
    return raw;
  }
}

/**
 * 从「视频元素的平面描述」收集可下载源。
 * @param {object} videoLike 形如 { src, currentSrc, sources:[url...] }
 *   - src:        <video src="..."> 直接属性
 *   - currentSrc: 实际播放源（直链时等于 src；经 MediaSource 播放时为 blob:）
 *   - sources:    <source> 子元素的 src 列表
 * @param {string[]} capturedM3u8 页面级捕获到的 .m3u8（HLS 经 MediaSource 时 video 本身无直链）
 * @param {string} baseHref 用于解析相对地址的基准（location.href）
 * @returns {Array<{url:string, kind:string}>} 去重后的源列表，按出现顺序
 */
function collectVideoSources(videoLike, capturedM3u8, baseHref) {
  const sources = [];
  const seen = new Set();
  const add = (raw, forceKind) => {
    if (!raw) return;
    const abs = normalizeUrl(raw, baseHref);
    if (seen.has(abs)) return;
    seen.add(abs);
    sources.push({ url: abs, kind: forceKind || classifyVideoUrl(abs) });
  };

  const cur = (videoLike && (videoLike.currentSrc || videoLike.src)) || '';
  // 跳过 blob:（MediaSource 播放时才有，不是真实可下载地址；真实源靠 capturedM3u8）
  if (cur && !/^blob:/i.test(cur)) add(cur);

  if (videoLike && Array.isArray(videoLike.sources)) {
    for (let i = 0; i < videoLike.sources.length; i++) {
      if (videoLike.sources[i]) add(videoLike.sources[i]);
    }
  }

  if (Array.isArray(capturedM3u8)) {
    for (let i = 0; i < capturedM3u8.length; i++) add(capturedM3u8[i], 'hls');
  }
  return sources;
}

// 在事件路径（composedPath / 数组）中定位第一个 <video> 元素。
function findVideoInPath(path) {
  if (!path || !path.length) return null;
  for (let i = 0; i < path.length; i++) {
    const el = path[i];
    if (el && el.nodeType === 1 && el.tagName === 'VIDEO') return el;
  }
  return null;
}

// 视频可见区域的最小边长（px）：小于它的 <video>（埋点像素、1x1 探测节点）不参与命中，
// 避免右键时被这些隐形节点抢走。
const MIN_VIDEO_EDGE = 32;

/**
 * 依据「光标点 + 各视频的几何信息」挑选右键命中的视频（纯逻辑，便于单测）。
 *
 * 为什么需要它：真实播放器普遍会在 <video> 上盖一层（封面 poster、渐变遮罩、自绘控制条、
 * 弹幕层），右键命中的是覆盖层，事件的 composedPath 里根本没有 VIDEO，于是「右键视频下载」
 * 会静默失效。这里改为按坐标做几何判定，穿透覆盖层。
 *
 * @param {Array<object>} videos 每个元素形如
 *   { rect:{left,top,right,bottom}, visible?:boolean, paused?:boolean, readyState?:number }
 *   rect 为 null / 尺寸过小 / visible === false 的会被剔除。
 * @param {number} x 光标横坐标（视口坐标，与 getBoundingClientRect 同一坐标系）
 * @param {number} y 光标纵坐标
 * @returns {number} 命中项在入参数组中的下标；无命中返回 -1
 *
 * 排序优先级：① 正在播放（!paused 且 readyState>=2）优先 → ② 面积更小者优先
 * （更可能是「真正的播放器」而非铺满页面的背景视频） → ③ DOM 靠后者优先（通常层级更高）。
 */
function pickVideoAtPoint(videos, x, y) {
  if (!Array.isArray(videos) || !videos.length) return -1;
  let best = -1;
  let bestRank = null;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (!v || !v.rect || v.visible === false) continue;
    const r = v.rect;
    const w = (r.right - r.left) || 0;
    const h = (r.bottom - r.top) || 0;
    if (w < MIN_VIDEO_EDGE || h < MIN_VIDEO_EDGE) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const playing = v.paused === false && (v.readyState == null || v.readyState >= 2);
    const rank = [playing ? 0 : 1, w * h, -i];
    if (bestRank === null || lessRank(rank, bestRank)) {
      bestRank = rank;
      best = i;
    }
  }
  return best;
}

// 字典序比较：rank 结构固定为 [是否非播放, 面积, -DOM序]
function lessRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * 是否应把「页面级捕获到的 .m3u8」附加到该视频作为下载候选。
 * 返回 true 表示「自身没有可用直链源」，需要靠页面级 HLS 兜底：
 *  - currentSrc/src 为空（尚未加载，离线测试常见）：保守地附加；
 *  - currentSrc 为 blob:（HLS 经 MediaSource 播放，真实地址在 capturedM3u8 里）：附加；
 * 返回 false 表示「自身已有直链源」（如已加载的 mp4）：不再误挂整页的 HLS 源。
 */
function shouldAttachPageM3u8(currentSrc, src) {
  const cur = currentSrc || src;
  return !(cur && !/^blob:/i.test(cur));
}

module.exports = {
  classifyVideoUrl,
  normalizeUrl,
  collectVideoSources,
  findVideoInPath,
  shouldAttachPageM3u8,
  pickVideoAtPoint,
  MIN_VIDEO_EDGE
};
