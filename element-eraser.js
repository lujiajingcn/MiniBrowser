'use strict';

/**
 * 橡皮擦：删除页面中选中的元素及其全部子元素。
 *
 * 【为什么不直接用 DevTools 的 Ctrl+Shift+C 拾取器】
 * 需求描述是「打开开发者工具，ctrl+shift+c，但开发者工具页面不显示」。
 * 实测这条路走不通，原因有三：
 *   1) <webview> 的 openDevTools() 只能docked / undocked / detach，
 *      OpenDevToolsOptions 里没有「不显示窗口」的选项（见 electron.d.ts:20070），
 *      一开就会弹出 DevTools 窗口，与「页面不显示」矛盾；
 *   2) 即使 detach 后立刻 closeDevTools()，拾取器随DevTools 前端一起销毁，
 *      拿不到「当前悬停/选中的元素」；
 *   3) DevTools 拾取器选中元素后只能改样式 / 复制外链，
 *      **没有「删除该元素及子元素」的能力**，这个需求它本身就不满足。
 * 因此这里在 guest 页面里自绘一个拾取器：视觉与交互对齐 DevTools 的
 * 元素检查器（悬停高亮 + 顶部信息条），但点击直接删除元素。
 *
 * 【实现要点】
 * - 用 document.elementFromPoint 反查元素，天然支持「鼠标在哪就选哪」；
 * - 高亮框用一个 position:fixed 的覆盖层绘制，**不改动页面自身样式**，
 *   避免污染页面、也避免被页面的 CSS（如 transform 父级）影响定位；
 * - 覆盖层使用 Shadow DOM 隔离，防止被页面同名样式干扰；
 * - 删除用 el.remove()，它会连同全部子元素一起移除（需求要求）。
 */

/** 触发阈值：鼠标移动超过该距离才更新高亮，避免抖动时闪烁。 */
const MOVE_THRESHOLD = 3;

/** 一次运行期内的状态。 */
let overlay = null; // 高亮覆盖层（Shadow DOM 容器）
let infoBar = null; // 顶部信息条
let hovered = null; // 当前悬停的元素
let enabled = false; // 橡皮擦是否处于激活状态
let lastX = 0;
let lastY = 0;

const OVERLAY_ID = '__mb_eraser_overlay__';

/** 生成一段 CSS。放在 Shadow DOM 里，与页面样式完全隔离。 */
const SHADOW_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.box {
  position: fixed;
  pointer-events: none;
  border: 1px solid #ff3b30;
  background: rgba(255, 59, 48, 0.18);
  z-index: 2147483647;
  transition: all 0.04s linear;
  display: none;
}
.bar {
  position: fixed;
  top: 0; left: 0;
  max-width: 100%;
  padding: 4px 10px;
  background: rgba(20, 20, 20, 0.92);
  color: #fff;
  font: 12px/1.6 Consolas, "Courier New", monospace;
  z-index: 2147483647;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom-right-radius: 4px;
  display: none;
}
.bar .tag { color: #ff6b6b; }
.bar .id { color: #7ec8ff; }
.bar .cls { color: #9fe870; }
`;

/** 创建覆盖层与信息条（幂等）。 */
function ensureOverlay() {
  if (overlay && overlay.isConnected) return;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  // 覆盖层本身不参与命中测试，否则 elementFromPoint 永远只能命中它
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  // 必须用 mode:'open'：closed 模式下 host.shadowRoot 恒为 null，
  // 下方的 paint() 里overlay.shadowRoot.querySelector('.box') 会永远拿不到元素，
  // 表现为「元素能被删除，但悬停没有高亮框」（已实测踩过）。
  // 这里的「隔离」需求 open 已能满足：Shadow DOM 本就屏蔽外部样式选择器进入。
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = SHADOW_CSS;

  const box = document.createElement('div');
  box.className = 'box';

  const bar = document.createElement('div');
  bar.className = 'bar';

  root.append(style, box, bar);
  (document.body || document.documentElement).appendChild(host);

  overlay = host;
  infoBar = bar;
}

/** 移除覆盖层（停用时调用）。 */
function removeOverlay() {
  if (overlay && overlay.isConnected) overlay.remove();
  overlay = null;
  infoBar = null;
}

/** 把元素描述成 DevTools 风格的文本：div#id.a.b */
function describe(el) {
  if (!el || el.nodeType !== 1) return '';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = (el.getAttribute && el.getAttribute('class')) || '';
  const first = cls.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  for (const c of first) s += '.' + c;
  return s;
}

/** 更新高亮框与信息条。 */
function paint(el) {
  if (!overlay) return;
  const box = overlay.shadowRoot.querySelector('.box');
  const bar = infoBar;
  if (!el || !el.isConnected) {
    box.style.display = 'none';
    bar.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  // getBoundingClientRect 是视口坐标，正好对应 position:fixed 覆盖层
  box.style.display = 'block';
  box.style.left = r.left + 'px';
  box.style.top = r.top + 'px';
  box.style.width = Math.max(r.width, 1) + 'px';
  box.style.height = Math.max(r.height, 1) + 'px';

  const size = Math.round(r.width) + ' × ' + Math.round(r.height);
  // 尺寸后只补class 部分：tag 与 #id 上面已单独输出，
  // 若这里再拼完整的 describe(el) 会得到「div#victim ... div#victim」的重复文本。
  const cls = ((el.getAttribute && el.getAttribute('class')) || '').trim();
  const clsShort = cls.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
  bar.style.display = 'block';
  // 贴近视口顶部；靠近底部时上移，避免信息条遮住目标元素
  bar.innerHTML =
    '<span class="tag">' + escapeHtml(el.tagName.toLowerCase()) + '</span>' +
    (el.id ? '<span class="id">#' + escapeHtml(el.id) + '</span>' : '') +
    (clsShort ? '<span class="cls">.' + escapeHtml(clsShort) + '</span>' : '') +
    ' <span style="opacity:.75">' + escapeHtml(size) + '</span>';
  const barH = bar.offsetHeight || 22;
  bar.style.top = r.top < barH + 4 ? Math.max(r.bottom + 4, 0) + 'px' : r.top - barH + 'px';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** 找到鼠标位置对应的元素（跳过橡皮擦自己的覆盖层）。 */
function elementAt(x, y) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
  for (const el of stack) {
    if (!el || el.nodeType !== 1) continue;
    // 跳过覆盖层宿主节点，否则高亮框会把自己框住
    if (el.id === OVERLAY_ID) continue;
    if (el.tagName === 'HTML' || el.tagName === 'BODY') {
      // 命中 body/html 说明鼠标在页面空白处，仍允许删除（清空页面主体），
      // 但跳过，让用户能看到自己点的是空白而不是误删整个页面。
      continue;
    }
    return el;
  }
  return null;
}

function onMouseMove(e) {
  if (!enabled) return;
  if (Math.abs(e.clientX - lastX) < MOVE_THRESHOLD && Math.abs(e.clientY - lastY) < MOVE_THRESHOLD) {
    return;
  }
  lastX = e.clientX;
  lastY = e.clientY;
  hovered = elementAt(e.clientX, e.clientY);
  paint(hovered);
}

/**
 * 橡皮擦开启时在 <html> 上挂的标记属性。
 *
 * 用途：让 webview-preload 的「链接点击拦截」知道橡皮擦正在工作，从而**让路**。
 * 见 webview-preload.js 中 onAnchorClick 的说明：那里同时挂了 click 捕获监听，
 * 且注册时机比橡皮擦早（页面加载时就注册），若两者都在 click 阶段竞争，
 * 链接会先被「打开新标签」，之后橡皮擦才删除元素 —— 表现为「点链接会开页面，但元素也删了」。
 * 这里用标记做跨世界（主世界 ↔ 隔离世界）通信，是最可靠的单一开关。
 */
const ERASER_FLAG_ATTR = 'data-mb-eraser';

/** 当前橡皮擦是否处于激活状态（供 webview-preload 查询）。 */
function isEraserActiveOnPage() {
  try {
    const el = document.documentElement;
    return !!(el && el.getAttribute(ERASER_FLAG_ATTR) === '1');
  } catch (_) {
    return false;
  }
}

// mousedown 已删除顶层元素后，浏览器仍可能在共同祖先上派发 click，
// 按坐标再命中一次会连删下层元素（一次点击删掉多层）。用短时间窗抑制这次 click。
let suppressClickUntil = 0;

function onClick(e) {
  if (!enabled) return;
  if (Date.now() < suppressClickUntil) {
    suppressClickUntil = 0;
    return;
  }
  const target = elementAt(e.clientX, e.clientY);
  if (!target) return;
  // 阻止默认行为与冒泡：避免误触发链接跳转 / 表单提交
  e.preventDefault();
  e.stopPropagation();
  try {
    target.remove(); // remove() 会连同全部子元素一起删除
  } catch (_) {
    /* 元素已被页面移除等情况，忽略 */
  }
  hovered = null;
  paint(null);
}

/**
 * 按下即删除（mousedown），而不是等click。
 *
 * 原因：链接的默认跳转与网页自己的 click 处理器都在 click 阶段（mouseup 之后）触发，
 * 那一刻再删除元素已经晚了 —— 链接可能已被打开、页面已开始导航。
 * 在 mousedown 阶段删除元素，后续的 mouseup/click 事件目标已从文档树上摘除，
 * 链接不会��触发。实测点击 <a> 时确认为此路径。
 */
function onMouseDown(e) {
  if (!enabled) return;
  if (e.button !== 0) return;
  const target = elementAt(e.clientX, e.clientY);
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    target.remove();
    suppressClickUntil = Date.now() + 500;
  } catch (_) {
    /* ignore */
  }
  hovered = null;
  paint(null);
}

function onKeyDown(e) {
  // Esc 退出橡皮擦，交互对齐 DevTools 拾取器
  if (e.key === 'Escape') stop();
}

function onScroll() {
  // 页面滚动后旧的 getBoundingClientRect 失效，重算一次
  if (enabled) paint(hovered);
}

/** 激活橡皮擦。 */
function start() {
  if (enabled) return;
  enabled = true;
  ensureOverlay();
  document.addEventListener('mousemove', onMouseMove, true);
  // mousedown 即删除；click 保留作为兜底（某些页面会吞掉 mousedown 的默认行为）
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKeyDown, true);
  // 屏蔽图片/链接的默认拖拽，否则按下即触发 dragstart，干扰删除
  document.addEventListener('dragstart', preventDefault, true);
  document.documentElement.style.cursor = 'crosshair';
  // 通知 guest 侧（webview-preload）让出链接点击，见 ERASER_FLAG_ATTR 说明
  try {
    document.documentElement.setAttribute(ERASER_FLAG_ATTR, '1');
  } catch (_) {
    /* ignore */
  }
}

/** 停用橡皮擦并清理全部痕迹。 */
function stop() {
  if (!enabled) return;
  enabled = false;
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mousedown', onMouseDown, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('scroll', onScroll, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('dragstart', preventDefault, true);
  document.documentElement.style.cursor = '';
  try {
    document.documentElement.removeAttribute(ERASER_FLAG_ATTR);
  } catch (_) {
    /* ignore */
  }
  hovered = null;
  removeOverlay();
}

function preventDefault(e) {
  e.preventDefault();
}

function isActive() {
  return enabled;
}

// ---------- 双模式导出 ----------
// 这个文件有**两个运行环境**，导出写法必须同时满足：
//  1) 被 executeJavaScript 注入到页面主世界 → 运行在浏览器里，
//     此时 module / exports 未定义，裸写 module.exports 会抛
//     "module is not defined"，导致整个注入失败、橡皮擦完全不可用；
//  2) 被 Node 直接 require 做单元测试 → 需要拿到 start/stop。
// 因此先挂 window 供宿主注入时取用，再在有 module 的环境补上导出。
if (typeof window !== 'undefined') {
  window.__mbEraserStart = start;
  window.__mbEraserStop = stop;
  window.__mbEraserIsActive = isActive;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { start, stop, isActive };
}