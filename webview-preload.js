'use strict';

const { ipcRenderer } = require('electron');

/**
 * webview 内部注入脚本（最小权限）。
 * 行为：页面内「可导航链接」的左键 / 中键 / Ctrl+左键点击，一律在新建标签页打开；
 * 同页锚点、javascript:、mailto: 等保持原生行为。
 *
 * 【实现注意】
 * 1) 判定元素时不用 `el instanceof HTMLAnchorElement`。webview 以 contextIsolation=true
 *    运行，预加载处于「隔离世界」，跨世界的构造函数身份比较依赖 Electron/Chromium 的具体
 *    实现（实测 31.7.7 可用，但该写法本身脆弱、不同版本或沙箱配置下不可靠）。
 *    这里统一改用 nodeType + tagName 字符串判定，不依赖构造函数身份，行为稳定。
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
  try {
    return new URL(href, location.href).href;
  } catch (_) {
    return href;
  }
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

// 4. 右键菜单：把当前链接信息/坐标发送给外壳渲染
document.addEventListener(
  'contextmenu',
  (e) => {
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
