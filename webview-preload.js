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
 * 3) 右键下载视频不能只认「事件路径上有没有 VIDEO」：播放器普遍在 <video> 上盖了封面 /
 *    遮罩 / 自绘控制条，右键命中的是覆盖层。故未在路径中命中时，回退到按坐标的几何判定
 *    （videoAtPoint），穿透覆盖层找到光标所在的 <video>。
 * 4) 还需穿透**同源 iframe**：很多站点的播放器跑在 iframe 里（本站 allappy.com 即如此），
 *    而 contextmenu 不会跨 frame 冒泡——只挂主文档的话，探测与右键都会静默失效。
 *    这里对同源 iframe 递归收集文档（accessibleDocuments），把监听器装进子文档，
 *    并把视频扫描与 performance 的 m3u8 捕获一并延伸过去。跨域 iframe 无法访问，
 *    维持既有边界（不为此放宽主进程的 nodeIntegrationInSubFrames）。
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

// 4. 右键菜单：视频优先提供「下载」；否则把链接信息/坐标发送给外壳渲染。
//    注意：本处理器会被挂到「每个可访问文档」上（含同源 iframe），因为 contextmenu
//    不会跨 frame 冒泡——播放器在 iframe 内时，主文档上的监听器根本收不到事件。
function onContextMenu(e) {
  // 事件发生在哪个文档（本处理器会被挂到主文档与各同源 iframe 文档上）
  const evtDoc =
    e.currentTarget && e.currentTarget.nodeType === 9
      ? e.currentTarget
      : (e.target && e.target.ownerDocument) || document;
  // 优先取事件路径上的 <video>；未命中则按坐标做几何回退——真实播放器几乎都在
  // <video> 上盖了一层（封面 poster / 渐变遮罩 / 自绘控制条 / 弹幕层），此时
  // composedPath 里没有 VIDEO，只靠路径判定会静默失效（右键毫无反应）。
  const videoEl =
    det.findVideoInPath(e.composedPath()) || videoAtPoint(e.clientX, e.clientY, evtDoc);
  if (videoEl) {
    const sources = collectVideoSources(videoEl);
    ipcRenderer.sendToHost('mb-video-context-menu', {
      x: e.clientX,
      y: e.clientY,
      sources,
      playing: videoEl.paused === false, // 用于提示「正在播放」，不影响下载源选择
      title: topTitle(),
      pageUrl: docBaseUrl(videoEl.ownerDocument)
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
}

// 顶层文档标题（用于下载文件的默认命名）；拿不到时退回 host
function topTitle() {
  try {
    return document.title || location.host || 'video';
  } catch (_) {
    return 'video';
  }
}

// ---------- 可访问文档集合：主文档 + 同源 iframe（递归）+ open shadow root 内的 iframe ----------
// 为什么需要它：右键事件不会跨 frame 冒泡。若播放器位于 iframe 内（本站即如此），
// 主文档上挂的 contextmenu 监听器永远不会被触发，视频探测与「右键下载」双双静默失效。
// 同源 iframe 的 document 可以直接访问，于是把监听器与扫描一并延伸到子文档。
// 跨域 iframe 受同源策略保护无法访问，维持既有能力边界（不为它放宽 nodeIntegrationInSubFrames）。
const listenedDocs = new WeakSet();
const DOC_WALK_MAX = 200; // 防御异常页面（帧中帧爆炸）导致的一次扫描开销失控

function accessibleDocuments() {
  const docs = [];
  const seenWin = new Set();
  const visit = (win) => {
    if (!win || seenWin.has(win) || docs.length >= DOC_WALK_MAX) return;
    seenWin.add(win);
    let doc = null;
    try {
      doc = win.document; // 跨域 frame 访问这里会抛错，直接跳过
    } catch (_) {
      return;
    }
    if (!doc || docs.indexOf(doc) >= 0) return;
    docs.push(doc);
    // 常规子框架
    let frames = null;
    try {
      frames = doc.querySelectorAll('iframe, frame');
    } catch (_) {
      frames = null;
    }
    if (frames) {
      for (let i = 0; i < frames.length; i++) {
        let cw = null;
        try {
          cw = frames[i].contentWindow;
        } catch (_) {
          cw = null;
        }
        if (cw) visit(cw);
      }
    }
    // open shadow root 里的子框架（自定义播放器元素常见）
    let all = null;
    try {
      all = doc.querySelectorAll('*');
    } catch (_) {
      all = null;
    }
    if (!all) return;
    for (let i = 0; i < all.length; i++) {
      const sr = all[i] && all[i].shadowRoot;
      if (!sr) continue;
      let fs = null;
      try {
        fs = sr.querySelectorAll('iframe, frame');
      } catch (_) {
        fs = null;
      }
      if (!fs) continue;
      for (let j = 0; j < fs.length; j++) {
        let cw = null;
        try {
          cw = fs[j].contentWindow;
        } catch (_) {
          cw = null;
        }
        if (cw) visit(cw);
      }
    }
  };
  try {
    visit(window);
  } catch (_) {
    /* ignore */
  }
  return docs;
}

// 文档所属 URL（当作该文档内视频源的 baseUrl / Referer 来源）
function docBaseUrl(doc) {
  try {
    if (doc && doc.location && doc.location.href) return doc.location.href;
  } catch (_) {
    /* 跨域/已卸载 */
  }
  try {
    return location.href;
  } catch (_) {
    return '';
  }
}

// 把右键处理器装到某个文档上（幂等）
function ensureDocListener(doc) {
  if (!doc || listenedDocs.has(doc)) return;
  listenedDocs.add(doc);
  try {
    doc.addEventListener('contextmenu', onContextMenu, true);
  } catch (_) {
    /* ignore */
  }
}

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
    docBaseUrl(videoEl.ownerDocument) // 以视频所在文档（可能是 iframe）为基准解析相对地址
  );
}

// 收集所有可访问文档内的 <video>：含同源 iframe（递归）与 open shadow root 内的。
// 只使用 nodeType / tagName / 属性 / DOM API，不做跨世界构造函数身份比较（见文件顶部说明）。
function allVideoElements() {
  const out = [];
  const walk = (root) => {
    let nodes = null;
    try {
      nodes = root.querySelectorAll('video');
    } catch (_) {
      nodes = null;
    }
    if (nodes) {
      for (let i = 0; i < nodes.length; i++) out.push(nodes[i]);
    }
    let all = null;
    try {
      all = root.querySelectorAll('*');
    } catch (_) {
      return; // 该 root 不可查询（如已脱离文档）时停止下探
    }
    for (let i = 0; i < all.length; i++) {
      const sr = all[i] && all[i].shadowRoot;
      if (sr) walk(sr);
    }
  };
  const docs = accessibleDocuments();
  for (let d = 0; d < docs.length; d++) {
    try {
      walk(docs[d]);
    } catch (_) {
      /* ignore */
    }
  }
  return out;
}

// 视频是否「看得见」：尺寸过小或 display/visibility/opacity 隐藏的不参与命中
function videoVisible(v, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  try {
    const view = (v.ownerDocument && v.ownerDocument.defaultView) || window;
    const cs = view.getComputedStyle(v);
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
    }
  } catch (_) {
    /* 拿不到计算样式时保守按可见处理 */
  }
  return true;
}

// 按坐标定位视频：穿透封面 / 遮罩 / 自绘控制条等覆盖层。
// 判定逻辑（排序优先级）抽到 video-detect.pickVideoAtPoint，便于 Node 单测复用同一份实现。
// doc 存在时只在「该文档内」的视频里挑：同一份 clientX/clientY 在不同 frame 的坐标系里
// 含义不同，不限定文档会让「主文档点击」误命中 iframe 内数值上重叠的 <video>。
function videoAtPoint(x, y, doc) {
  let els = allVideoElements();
  if (doc) els = els.filter((v) => v.ownerDocument === doc);
  const desc = [];
  for (let i = 0; i < els.length; i++) {
    const v = els[i];
    let rect = null;
    try {
      rect = v.getBoundingClientRect();
    } catch (_) {
      rect = null;
    }
    desc.push({
      rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      visible: videoVisible(v, rect),
      paused: v.paused,
      readyState: v.readyState
    });
  }
  const idx = det.pickVideoAtPoint(desc, x, y);
  return idx >= 0 ? els[idx] : null;
}

function captureM3u8(url) {
  if (!url || /m3u8/i.test(url) === false) return;
  if (capturedM3u8.indexOf(url) < 0) {
    capturedM3u8.push(url);
    scheduleVideoReport();
  }
}

// 从「每个可访问文档」各自的 performance 时间线里捞 .m3u8。
// 关键：iframe 内的播放器发起的 m3u8 请求只记在该 iframe 自己的 performance 上，
// 只读顶层 window.performance 会完全漏掉（本站播放器即在 iframe 内）。
function scanPerformanceForM3u8() {
  const docs = accessibleDocuments();
  for (let d = 0; d < docs.length; d++) {
    let entries = null;
    try {
      const win = docs[d].defaultView;
      if (!win || !win.performance) continue;
      entries = win.performance.getEntriesByType('resource');
    } catch (_) {
      entries = null; // 某些环境不支持资源计时 / 跨域访问受限
    }
    if (!entries) continue;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].name) captureM3u8(entries[i].name);
    }
  }
}

function scanVideos() {
  const docs = accessibleDocuments();
  // 顺带把右键监听器补装到新出现的同源 iframe 文档上（页面可能后插入播放器 iframe）
  for (let d = 0; d < docs.length; d++) ensureDocListener(docs[d]);

  const nodes = allVideoElements();
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i];
    if (!videoRegistry.has(v)) {
      videoRegistry.add(v);
      try {
        v.addEventListener('loadedmetadata', scheduleVideoReport, true);
        v.addEventListener('play', scheduleVideoReport, true);
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
      list.push({ sources, title: topTitle(), pageUrl: docBaseUrl(v.ownerDocument) });
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
ensureDocListener(document); // 主文档（同源 iframe 的监听器由 scanVideos 补装）
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
