'use strict';

const { ipcRenderer } = require('electron');
// >>> BEGIN INLINED video-detect.js (由 tools/inline-video-detect.js 生成，请勿手改) >>>
// 本段由 tools/inline-video-detect.js 从 video-detect.js 自动生成。
// 理由见该脚本注释：<webview> 的 preload 沙箱无法 require 外部模块，
// 不内联会导致整个 preload 加载失败、页内能力全部失效。
// 请修改 video-detect.js 后重新运行 node tools/inline-video-detect.js
//
// 注意：这里刻意**不套 IIFE** —— 内联的函数与 const det 需要对外可见，
// 供下方 webview-preload 的其余代码使用。
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


const det = { classifyVideoUrl, normalizeUrl, collectVideoSources, findVideoInPath, shouldAttachPageM3u8, pickVideoAtPoint };
// <<< END INLINED video-detect.js <<<

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

// 判断橡皮擦是否正在页面主世界工作。
// 橡皮擦开启时会在 <html> 上挂 data-mb-eraser="1"（见 element-eraser.js）。
// 这是主世界 ↔ 隔离世界之间最简单可靠的通信方式：不用跨世界直接调用函数，
// 只看 DOM 属性，任何一方都能随时读到。
function isEraserActive() {
  try {
    const el = document.documentElement;
    return !!(el && el.getAttribute('data-mb-eraser') === '1');
  } catch (_) {
    return false;
  }
}

// 1. 左键点击所有可导航链接 → 新标签
document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0) return; // 只处理左键
    // 橡皮擦工作期间让路：此时点击是「删除这个元素」而不是「打开这个链接」。
    // 不让路的话，本处理器与橡皮擦都在 click 捕获阶段竞争，而本处理器注册更早
    // （页面加载时就装了），会先把链接开去新标签，橡皮擦再删除元素 ——
    // 表现为「点链接既开了页面、元素也消失」。
    if (isEraserActive()) return;
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
    // 橡皮擦工作期间让路（理由同第1 项）
    if (isEraserActive()) return;
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

// 6. Alt + 左键 → 拖动宿主窗口。
//    <webview> 是独立 guest 渲染进程，鼠标事件不会冒泡到外壳 document，
//    外壳自己听不到网页内的 mousedown，必须在这里检测后经 sendToHost 转出去。
//
//    【为什么要「移动后才判定为拖动」】
//    Alt+左键在网页里本身是有意义的原生操作（Chrome/Firefox 的
//    「Alt+左键 = 保存链接到本地」）。若按下就立刻上报并 preventDefault，
//    会把「点链接下载」这个正常功能一并废掉。
//    因此这里只记录起点，等鼠标真的移动超过阈值（DRAG_THRESHOLD）才认定为拖动；
//    纯点击（未移动）则完全不干预网页行为。
//    中途的位置更新交给主进程轮询屏幕坐标，本文件只上报 start / end 两个时刻。
const DRAG_THRESHOLD = 4; // px，超过即认为是拖动意图

let altDragPending = null; // { x, y } 已按下Alt+左键但尚未越过阈值

function onAltDragMouseDown(e) {
  if (e.button !== 0 || !e.altKey) return;
  // 橡皮擦工作期间让路：Alt+左键此时是「删除这个元素」，
  // 不能同时被当成「拖动窗口」的起点，否则会出现「元素没删掉、窗口却在动」。
  if (isEraserActive()) return;
  altDragPending = { x: e.clientX, y: e.clientY };
}

function onAltDragMouseMove(e) {
  if (!altDragPending) return;
  const dx = e.clientX - altDragPending.x;
  const dy = e.clientY - altDragPending.y;
  if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
  // 越过阈值 → 认定为拖动窗口，拦下网页后续行为
  const start = altDragPending;
  altDragPending = null;
  ipcRenderer.sendToHost('mb-window-drag', { action: 'start', x: start.x, y: start.y });
  e.preventDefault();
  e.stopPropagation();
}

function onAltDragMouseUp(e) {
  if (e.button !== 0) return;
  const wasPending = !!altDragPending;
  altDragPending = null;
  // 只有「已认定为拖动」才需要通知结束；纯点击什么都不做
  if (wasPending) return;
  ipcRenderer.sendToHost('mb-window-drag', { action: 'end' });
}

// 7. 左键点击页面 → 通知外壳关闭右键菜单。
//    外壳在 renderer.js 里监听了 document 的 click 来实现「点菜单外关闭菜单」，
//    但 <webview> 是独立 guest 渲染进程，网页内的点击**不会冒泡到外壳 document**，
//    于是网页内容区点击时菜单不关闭（工具栏等外壳区域却是好的）。
//    这里检测左键点击后经 sendToHost 转发，由外壳统一关闭菜单。
//
//    注意只在「菜单已打开」时才上报（外壳侧也会再判一次，这里先省掉无效 IPC）：
//    无法从 guest 得知菜单状态，故每次左键都发，由外壳判断是否需要关闭。
//    用 mousedown 而非 click：菜单在 pointerdown 阶段就该消失，
//    等click 会等到 mouseup 之后，视觉上「点下去菜单还在、松手才消失」。
function onPagePointerDown(e) {
  // 只处理左键（其它按键不应关闭菜单）；触屏的 pointerdown 事件 button 为 0，同样适用
  if (e.button !== 0) return;
  ipcRenderer.sendToHost('mb-page-pointer-down', {});
}

function onAltDragKeyUp(e) {
  // Alt 先松开时也要结束拖动，否则窗口会黏着鼠标不放
  if (e.key === 'Alt') {
    altDragPending = null;
    ipcRenderer.sendToHost('mb-window-drag', { action: 'end' });
  }
}

// 把右键处理器装到某个文档上（幂等）
function ensureDocListener(doc) {
  if (!doc || listenedDocs.has(doc)) return;
  listenedDocs.add(doc);
  try {
    doc.addEventListener('contextmenu', onContextMenu, true);
    // Alt+拖动窗口：同样要覆盖同源 iframe（mousedown/mousemove 都不跨 frame冒泡）
    doc.addEventListener('mousedown', onAltDragMouseDown, true);
    doc.addEventListener('mousemove', onAltDragMouseMove, true);
    doc.addEventListener('mouseup', onAltDragMouseUp, true);
    doc.addEventListener('keyup', onAltDragKeyUp, true);
    // 点页面关闭右键菜单：mousedown 也要覆盖同源 iframe（与上面同理）
    doc.addEventListener('mousedown', onPagePointerDown, true);
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

// ---------- 橡皮擦（删除页面元素）----------
// 说明：橡皮擦**不需要** preload 参与。
// 宿主（renderer.js）把 element-eraser.js 注入页面**主世界**并挂载
// window.__mbEraserToggle / __mbEraserStart / __mbEraserStop，直接控制启停。
// 之所以不用 preload（隔离世界）实现：删除元素要操作页面真实 DOM，
// 而 <webview> 未提供 sendToGuest（宿主→guest 的直接通道），
// executeJavaScript 是唯一可靠路径，且它本身就作用于主世界。

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

// ---------- 去粗体：穿透同源 iframe ----------
//
// 宿主的 insertCSS 是**浏览器侧** API，只作用于**主文档**，
// 同源 iframe 里的粗体它管不到（iframe 是独立的文档）。
// 这里由宿主通过 mb-debold-frames 下发开关，本 preload 遍历
// accessibleDocuments()（主文档 + 同源 iframe 递归 + shadow root 里的 iframe），
// 给每个**子文档**插入/移除一个 <style>。
//
// 主文档不在这里处理：宿主那边已用 insertCSS 处理过，
// 那是浏览器侧 API，**不依赖 preload 是否加载成功**，比这条 IPC 通道可靠。

const DEBOLD_FRAME_CSS = `
*, *::before, *::after {
  font-weight: normal !important;
}`;
const DEBOLD_STYLE_ID = 'mb-debold-style';

let deboldEnabled = false;
// 已绑定 load 监听的 frame，避免重复绑定
const deboldBoundFrames = new WeakSet();
// 延迟重试的定时器（iframe 加载完成时刻不可控）
let deboldRetryTimers = [];

/** 给某个文档创建（或复用）承载去粗体样式的 <style>。 */
function deboldStyleFor(doc) {
  let el = doc.getElementById(DEBOLD_STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = DEBOLD_STYLE_ID;
    (doc.head || doc.documentElement).appendChild(el);
  }
  return el;
}

/**
 * 给文档内的 iframe 绑定 load 监听。
 *
 * iframe 可能在样式注入**之后**才加载完成 —— 那时新文档里没有我们的
 * <style>，粗体又回来了。绑定 load 后在加载完成的瞬间补注入一次。
 */
function bindFrameLoads(doc) {
  let frames = null;
  try {
    frames = doc.querySelectorAll('iframe, frame');
  } catch (_) {
    return;
  }
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || deboldBoundFrames.has(f)) continue;
    deboldBoundFrames.add(f);
    try {
      f.addEventListener('load', () => {
        if (deboldEnabled) injectDeboldNow();
      });
    } catch (_) {
      /* ignore */
    }
  }
}

/** 立即对所有可访问的**子文档**注入/移除去粗体样式。 */
function injectDeboldNow() {
  const docs = accessibleDocuments();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (!doc || doc === document) continue; // 主文档交给宿主的 insertCSS
    try {
      if (deboldEnabled) {
        const el = deboldStyleFor(doc);
        if (el.textContent !== DEBOLD_FRAME_CSS) el.textContent = DEBOLD_FRAME_CSS;
        bindFrameLoads(doc);
      } else {
        const el = doc.getElementById(DEBOLD_STYLE_ID);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    } catch (_) {
      /* 跨域 / 已销毁的文档，忽略 */
    }
  }
}

function clearDeboldRetries() {
  for (let i = 0; i < deboldRetryTimers.length; i++) clearTimeout(deboldRetryTimers[i]);
  deboldRetryTimers = [];
}

/**
 * 设置去粗体开关。
 * @param {boolean} on 是否开启
 */
function applyDeboldToFrames(on) {
  deboldEnabled = !!on;
  clearDeboldRetries();
  injectDeboldNow();
  if (!on) return;
  // iframe 的加载完成时刻不可控：宿主发出开关时，iframe 可能还在加载，
  // 此刻遍历到的只是它的初始空文档，真正的文档加载完成后并没有我们的 style。
  // load 监听只能覆盖「绑定之后才加载」的情况，而绑定时 iframe 可能已经加载完了
  // —— 所以再安排几次延迟重试兜住各种时序。
  const delays = [300, 1000, 2500];
  for (let i = 0; i < delays.length; i++) {
    deboldRetryTimers.push(setTimeout(() => {
      if (deboldEnabled) injectDeboldNow();
    }, delays[i]));
  }
}

// 宿主下发去粗体开关（工具栏「去粗体」按钮）
ipcRenderer.on('mb-debold-frames', (_e, payload) => {
  const on = !!(payload && payload.on);
  try {
    applyDeboldToFrames(on);
  } catch (_) {
    /* ignore */
  }
});

