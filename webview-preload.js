'use strict';

const { ipcRenderer } = require('electron');
const det = require('./video-detect');

/**
 * webview 内部注入脚本（最小权限）。
 * 行为：页面内「可导航链接」的左键 / 中键 / Ctrl+左键点击，一律在新建标签页打开；
 * 同页锚点、javascript:、mailto: 等保持原生行为。
 * 额外能力：探测页面内 <video>，右键提供「下载视频」，并把视频源（含 HLS 的 .m3u8）
 * 上报给外壳，由主进程下载为 MP4。
 *
 * 【实现注意】
 * 1) 判定元素时不用 `el instanceof HTMLAnchorElement` / `HTMLVideoElement`。webview 以
 *    contextIsolation=true 运行，预加载处于「隔离世界」，跨世界的构造函数身份比较依赖
 *    Electron/Chromium 的具体实现（实测 31.7.7 可用，但该写法本身脆弱、不同版本或沙箱
 *    配置下不可靠）。这里统一改用 nodeType + tagName 字符串判定，不依赖构造函数身份。
 * 2) 不在这里改写 `window.open`。contextIsolation 下预加载的 window 与页面 window 不同，
 *    改写它并不能拦截页面发起的弹窗。页面 window.open / target="_blank" 统一由主进程
 *    setWindowOpenHandler 接管并转发为「新标签打开」（见 main.js），这里不再重复处理。
 */

// 跨世界安全地定位事件路径上的第一个 <a href>
function findAnchor(path) {
  if (!path) return null;
  for (let i = 0; i < path.length; i++) {
    const el = path[i];
    if (!el || el.nodeType !== 1) continue; // 只要元素节点
    if (el.tagName === 'A' && el.href) return el;
  }
  return null;
}

// 判断一个 href 是否应在「新标签页」打开
function shouldOpenNewTab(href) {
  if (!href) return false;
  let u;
  try {
    u = new URL(href, location.href);
  } catch (_) {
    return false;
  }
  // 仅允许 web 类协议走新标签
  if (!/^(https?:|about:|file:)$/i.test(u.protocol)) return false;
  // 同页锚点（仅 hash 不同）不新开标签，保留页面内滚动
  if (
    u.host === location.host &&
    u.pathname === location.pathname &&
    u.search === location.search &&
    u.hash !== location.hash
  ) {
    return false;
  }
  return true;
}

function emitNewWindow(url, details = {}) {
  if (!url) return;
  ipcRenderer.sendToHost('mb-new-window', { url, details });
}

function normalizeHref(href) {
  return det.normalizeUrl(href, location.href);
}

// 1. 左键点击所有可导航链接 → 新标签
document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0) return; // 只处理左键
    const a = findAnchor(e.composedPath());
    if (!a) return;
    const href = a.href;
    if (!href || !shouldOpenNewTab(href)) return;
    e.preventDefault();
    e.stopPropagation();
    emitNewWindow(href, { via: 'click', target: a.getAttribute('target') });
  },
  true
);

// 2. 中键点击链接 → 新标签（浏览器习惯，且阻止默认的「特殊粘贴」行为）
document.addEventListener(
  'mousedown',
  (e) => {
    if (e.button !== 1) return;
    const a = findAnchor(e.composedPath());
    if (!a) return;
    const href = a.href;
    if (!href || !shouldOpenNewTab(href)) return;
    e.preventDefault();
    e.stopPropagation();
    emitNewWindow(href, { via: 'mousedown-middle' });
  },
  true
);

// 3. Ctrl/⌘ + 左键 也走新标签（与普通浏览器一致）
document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    const a = findAnchor(e.composedPath());
    if (!a) return;
    const href = a.href;
    if (!href || !shouldOpenNewTab(href)) return;
    e.preventDefault();
    e.stopPropagation();
    emitNewWindow(href, { via: 'ctrl-click' });
  },
  true
);

// 4. 右键菜单：视频优先提供「下载视频」；否则把链接信息/坐标发送给外壳渲染
document.addEventListener(
  'contextmenu',
  (e) => {
    // 命中 <video>：上报视频源，由外壳弹出「下载视频」
    const videoEl = det.findVideoInPath(e.composedPath());
    if (videoEl) {
      const sources = collectVideoSources(videoEl);
      ipcRenderer.sendToHost('mb-video-context-menu', {
        x: e.clientX,
        y: e.clientY,
        sources,
        title: document.title || location.host || 'video',
        pageUrl: location.href
      });
      e.preventDefault();
      return;
    }
    const a = findAnchor(e.composedPath());
    let link = null;
    if (a && a.href) {
      const url = normalizeHref(a.href);
      if (shouldOpenNewTab(url)) {
        link = { url, text: (a.textContent || '').trim().slice(0, 80) };
      }
    }
    let selection = '';
    try {
      const sel = window.getSelection && window.getSelection();
      selection = sel ? sel.toString().slice(0, 200) : '';
    } catch (_) {
      selection = '';
    }
    ipcRenderer.sendToHost('mb-context-menu', {
      x: e.clientX,
      y: e.clientY,
      link,
      selection
    });
    e.preventDefault();
  },
  true
);

// 5. 键盘：焦点在页面内时外壳收不到 keydown，需把查找快捷键转发给外壳。
//    Ctrl/Cmd+F 打开查找条；Esc 关闭查找条（不 preventDefault，避免影响页面自身的 Esc 行为）。
document.addEventListener(
  'keydown',
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.sendToHost('mb-find', { action: 'open' });
    } else if (e.key === 'Escape') {
      ipcRenderer.sendToHost('mb-find', { action: 'close' });
    }
  },
  true
);

// ---------- 视频探测 + 下载（页面内可播放视频 → 下载为 MP4）----------
// 右键点击 <video> 或在工具栏点「下载视频」时，把检测到的视频源（直链 / HLS 的 .m3u8）
// 上报给外壳，由主进程决定下载方式。
// HLS 流经由 MediaSource 播放时 video.currentSrc 是 blob:，无法直接使用，因此通过
// performance 资源计时捕获页面发出的 .m3u8 请求地址（hls.js 等库会先 XHR/fetch 拉取播放列表）。

const videoRegistry = new Set();
const capturedM3u8 = [];
let videoReportTimer = null;
let videoScanTimer = null;

// 把真实 <video> 元素转成平面描述，交给纯逻辑模块收集源（便于单测复用同一份实现）
function collectVideoSources(videoEl) {
  const srcs = [];
  try {
    const srcEls = videoEl.querySelectorAll('source');
    for (let i = 0; i < srcEls.length; i++) {
      if (srcEls[i].src) srcs.push(srcEls[i].src);
    }
  } catch (_) {
    /* ignore */
  }
  const cur = videoEl.currentSrc || videoEl.src;
  // 仅当该 <video> 自身没有可用的直链源时（典型是 HLS 经 MediaSource 播放，currentSrc 为 blob:），
  // 才把页面级捕获到的 .m3u8 作为候选附上，避免给「本来就是 mp4」的视频误挂整页的 HLS 源。
  const hasDirect = !det.shouldAttachPageM3u8(videoEl.currentSrc, videoEl.src);
  const m3u8 = hasDirect ? [] : capturedM3u8;
  return det.collectVideoSources(
    { src: videoEl.src, currentSrc: videoEl.currentSrc, sources: srcs },
    m3u8,
    location.href
  );
}

function captureM3u8(url) {
  if (!url || /m3u8/i.test(url) === false) return;
  if (capturedM3u8.indexOf(url) < 0) {
    capturedM3u8.push(url);
    scheduleVideoReport();
  }
}

function scanPerformanceForM3u8() {
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].name) captureM3u8(entries[i].name);
    }
  } catch (_) {
    /* 某些环境不支持 performance 资源计时时忽略 */
  }
}

function scanVideos() {
  let nodes;
  try {
    nodes = document.querySelectorAll('video');
  } catch (_) {
    return;
  }
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i];
    if (!videoRegistry.has(v)) {
      videoRegistry.add(v);
      try {
        v.addEventListener('loadedmetadata', scheduleVideoReport, true);
      } catch (_) {
        /* ignore */
      }
    }
  }
  scheduleVideoReport();
}

function scheduleVideoReport() {
  if (videoReportTimer) return;
  videoReportTimer = setTimeout(() => {
    videoReportTimer = null;
    reportVideos();
  }, 300);
}

function reportVideos() {
  scanPerformanceForM3u8();
  const list = [];
  videoRegistry.forEach((v) => {
    const sources = collectVideoSources(v);
    if (sources.length) {
      list.push({ sources, title: document.title || location.host || 'video' });
    }
  });
  ipcRenderer.sendToHost('mb-videos-updated', list);
}

// 页面结构变化即重新扫描；并对「延迟加载的播放器」做一段定时扫描
const videoObserver = new MutationObserver(() => scanVideos());
try {
  videoObserver.observe(document.documentElement, { childList: true, subtree: true });
} catch (_) {
  /* ignore */
}
scanVideos();
scanPerformanceForM3u8();
videoScanTimer = setInterval(() => {
  scanVideos();
  scanPerformanceForM3u8();
}, 2000);
// 前 60 秒密集扫描后停止定时（视频源一般早已出现），避免长期空转
setTimeout(() => {
  if (videoScanTimer) {
    clearInterval(videoScanTimer);
    videoScanTimer = null;
  }
}, 60000);

// 外壳主动询问当前页面视频源（工具栏「下载视频」按钮触发）
ipcRenderer.on('mb-request-videos', () => reportVideos());
