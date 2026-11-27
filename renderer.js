'use strict';

const tabBar = document.getElementById('tab-bar');
const container = document.getElementById('webview-container');
const urlInput = document.getElementById('url');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const homeBtn = document.getElementById('home');
const goBtn = document.getElementById('go');
const bookmarkBtn = document.getElementById('bookmark');
const devtoolsBtn = document.getElementById('devtools');
const historyBtn = document.getElementById('history');
const historyPanel = document.getElementById('history-panel');
const historyListEl = document.getElementById('history-list');
const historyClearBtn = document.getElementById('history-clear');
const contextMenu = document.getElementById('context-menu');
const contextMenuList = document.getElementById('context-menu-list');
const lockEl = document.getElementById('lock');
const faviconEl = document.getElementById('favicon');
const loadingBar = document.getElementById('loading');
const bookmarksBar = document.getElementById('bookmarks-bar');
const findBtn = document.getElementById('find');
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCountEl = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const findCloseBtn = document.getElementById('find-close');
const downloadsBtn = document.getElementById('downloads');
const downloadsPanel = document.getElementById('downloads-panel');
const downloadsList = document.getElementById('downloads-list');
const downloadsClearBtn = document.getElementById('downloads-clear');
const dlBadge = document.getElementById('dl-badge');
const settingsBtn = document.getElementById('settings');
const zoomBtn = document.getElementById('zoom');
const pinBtn = document.getElementById('pin');
const deboldBtn = document.getElementById('debold');
const zoomMenu = document.getElementById('zoom-menu');
const zoomMenuList = document.getElementById('zoom-menu-list');
const settingsPanel = document.getElementById('settings-panel');
const setThemeSel = document.getElementById('set-theme');
const setHomeInput = document.getElementById('set-home');
const setEngineSel = document.getElementById('set-engine');
const setRestoreChk = document.getElementById('set-restore');
const setNewTabChk = document.getElementById('set-newtab');
const setClearHistoryBtn = document.getElementById('set-clear-history');
const setClearBookmarksBtn = document.getElementById('set-clear-bookmarks');
const setClearAllBtn = document.getElementById('set-clear-all');
const setDlDirLabel = document.getElementById('set-dl-dir');
const setDlChooseBtn = document.getElementById('set-dl-choose');
const setAskSaveChk = document.getElementById('set-ask-save');
const videoDlBtn = document.getElementById('video-dl');
const savePageBtn = document.getElementById('save-page');
const eraserBtn = document.getElementById('eraser');
const setImportBookmarksBtn = document.getElementById('set-import-bookmarks');
const setExportBookmarksBtn = document.getElementById('set-export-bookmarks');
const impFileInput = document.getElementById('set-import-file');
const toastEl = document.getElementById('toast');
// 收藏夹弹出层
const bmPopover = document.getElementById('bm-popover');
const bmCrumbs = document.getElementById('bm-crumbs');
const bmList = document.getElementById('bm-list');
const bmHeader = document.getElementById('bm-header');
const bmNewFolderBtn = document.getElementById('bm-new-folder');
const bmAddCurrentBtn = document.getElementById('bm-add-current');
const bmCloseBtn = document.getElementById('bm-popover-close');

const HOME_URL = 'https://www.example.com';
const WEBVIEW_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_BOOKMARKS = [
  { title: 'Example', url: 'https://www.example.com' },
  { title: 'Electron', url: 'https://www.electronjs.org' },
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'Bing', url: 'https://www.bing.com' }
];

let tabSeq = 0;
let tabs = [];
let activeTabId = null;
let closedTabs = []; // 最近关闭的标签（用于 Ctrl+Shift+T 恢复）

// 常驻「新建标签页」按钮
const newTabBtn = document.createElement('button');
newTabBtn.className = 'tab new';
newTabBtn.textContent = '+';
newTabBtn.title = '新建标签页';
newTabBtn.addEventListener('click', () => createTab(homeUrl()));
tabBar.appendChild(newTabBtn);

// ---------- 工具函数 ----------
/**
 * 切换按钮里的图标 symbol。工具栏统一用 <svg class="icon"><use href="#i-xxx">，
 * 状态变化只换 href，不改按钮尺寸、线宽和着色规则（currentColor）。
 */
function setButtonIcon(el, symbol) {
  if (!el) return;
  el.innerHTML =
    '<svg class="icon" aria-hidden="true" focusable="false"><use href="#' +
    symbol +
    '"></use></svg>';
}

function normalizeUrl(input) {
  const url = (input || '').trim();
  if (!url) return '';
  if (/^(https?:\/\/|about:|file:|data:|mailto:)/i.test(url)) return url;
  if (url.includes('.') || url.includes(':') || url.includes('/')) return 'https://' + url;
  return searchUrl() + encodeURIComponent(url);
}

// 网页发起的非常规协议只能交给白名单内的系统处理器。
// 与 preload.js 的 EXTERNAL_URL_RE 保持一致：脏 URL 不跨进程传递，
// preload 侧再校验一次作为最后防线。
const EXTERNAL_URL_RE = /^(https?:\/\/|mailto:|tel:)/i;
function openExternalUrl(url) {
  if (typeof url !== 'string') return false;
  const target = url.trim();
  if (!EXTERNAL_URL_RE.test(target)) return false;
  if (window.electronAPI && window.electronAPI.openExternal) {
    window.electronAPI.openExternal(target);
  }
  return true;
}

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function activeWebview() {
  const t = activeTab();
  return t ? t.webview : null;
}

function showFavicon(src) {
  if (!src) return hideFavicon();
  faviconEl.src = src;
  faviconEl.classList.add('show');
}

function hideFavicon() {
  faviconEl.classList.remove('show');
}

function updateLock(url) {
  const secure = /^https:/i.test(url);
  setButtonIcon(lockEl, secure ? 'i-lock' : 'i-unlock');
  lockEl.title = secure ? '安全连接 (HTTPS)' : '未加密连接';
}

// ---------- 标签页管理 ----------
function createTab(url, setActive = true) {
  const id = ++tabSeq;
  const tab = {
    id,
    url: url || HOME_URL,
    title: '新标签页',
    favicon: '',
    loading: false,
    zoomLevel: 0,
    debold: false, // 是否已开启「去粗体」
    webview: null
  };
  const webview = document.createElement('webview');
  webview.className = 'webview';
  webview.setAttribute('allowpopups', '');
  if (window.electronAPI && window.electronAPI.getWebviewPreloadPath) {
    webview.setAttribute('preload', window.electronAPI.getWebviewPreloadPath());
  }
  webview.useragent = WEBVIEW_UA;
  webview.src = url || HOME_URL;
  container.appendChild(webview);
  tab.webview = webview;
  tabs.push(tab);
  wireWebview(tab);
  renderTabElement(tab);
  if (setActive) setActiveTab(id);
  else saveTabs();
  return tab;
}

function renderTabElement(tab) {
  let el = document.getElementById('tab-' + tab.id);
  if (!el) {
    el = document.createElement('button');
    el.id = 'tab-' + tab.id;
    el.className = 'tab';
    el.innerHTML =
      '<img class="tab-favicon" alt="" /><span class="tab-title"></span><span class="tab-close" title="关闭">×</span>';
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) closeTab(tab.id);
      else setActiveTab(tab.id);
    });
    tabBar.insertBefore(el, newTabBtn);
  }
  el.querySelector('.tab-title').textContent = tab.title || tab.url;
  const fav = el.querySelector('.tab-favicon');
  if (tab.favicon) {
    fav.src = tab.favicon;
    fav.style.display = 'inline-block';
  } else {
    fav.style.display = 'none';
  }
}

function setActiveTab(id) {
  // 目标 ID 不存在时回退到最后一个标签。绝不让 activeTabId 指向不存在的 ID：
  // 那样所有 webview 都不带 .active，内容区全白，且缩放/查找/关闭等快捷键全失效。
  if (!tabs.some((x) => x.id === id) && tabs.length) {
    id = tabs[tabs.length - 1].id;
  }
  activeTabId = id;
  tabs.forEach((t) => {
    const isActive = t.id === id;
    if (t.webview) t.webview.classList.toggle('active', isActive);
    const te = document.getElementById('tab-' + t.id);
    if (te) te.classList.toggle('active', isActive);
  });
  const t = activeTab();
  if (!t) return;
  urlInput.value = t.url;
  updateLock(t.url);
  document.title = (t.title && t.title !== '新标签页' ? t.title + ' - ' : '') + 'MiniBrowser';
  if (t.favicon) showFavicon(t.favicon);
  else hideFavicon();
  refreshBookmarkStar();
  updateZoomIndicator();
  updateDeboldButton();
  // 切标签后缩放菜单里的档位就不再对应当前标签了，直接收起。
  hideZoomMenu();
  // did-start/stop-loading 只更新活动标签的加载条，后台标签的状态变化不会反映到工具栏。
  // 切标签时必须按新标签的 loading 状态补齐，否则会显示上一个标签的转圈/✕。
  loadingBar.classList.toggle('active', !!t.loading);
  setButtonIcon(reloadBtn, t.loading ? 'i-stop' : 'i-reload');
  // 查找条开着时切标签：清空旧页计数并对新页重新查找，
  // 否则数字还是上一页的，而新页面没有任何高亮。
  if (findBar.classList.contains('hidden')) stopFindOn(t.webview);
  else runFind(true);
  // 擦除模式下切标签：把橡皮擦应用到新标签的页面，否则切过去就没反应
  if (eraserActive) applyEraser(t.webview, true);
  saveTabs();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = id === activeTabId;
  const t = tabs[idx];
  if (t.url && t.url !== homeUrl()) {
    closedTabs.push({ url: t.url, title: t.title || t.url });
    if (closedTabs.length > 20) closedTabs.shift();
  }
  try {
    if (t.webview) t.webview.remove();
  } catch (_) {
    /* ignore */
  }
  tabs.splice(idx, 1);
  const te = document.getElementById('tab-' + id);
  if (te) te.remove();
  saveTabs();
  if (tabs.length === 0) {
    createTab(homeUrl());
    return;
  }
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveTab(next.id);
  }
}

function saveTabs() {
  if (!tabs.length) return;
  try {
    const payload = {
      tabs: tabs.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon })),
      activeTabId,
      // ID 是自增的，关掉中间标签后会留空洞；恢复时重新编号无法对齐。
      // 存数组下标才可靠。activeTabId 仍保留，兼容旧数据与外部读取。
      activeIndex: tabs.findIndex((t) => t.id === activeTabId)
    };
    localStorage.setItem('mb_tabs', JSON.stringify(payload));
  } catch (_) {
    /* ignore */
  }
}

function restoreTabs() {
  try {
    const raw = localStorage.getItem('mb_tabs');
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !data.tabs || !data.tabs.length) return false;
    const rebuilt = data.tabs.map((t) => createTab(t.url, false));
    // 优先用下标定位；旧数据没有 activeIndex 时退回按 ID 找。
    let idx = typeof data.activeIndex === 'number' ? data.activeIndex : -1;
    if (idx < 0 || idx >= rebuilt.length) {
      idx = rebuilt.findIndex((t) => t.id === data.activeTabId);
    }
    const target = rebuilt[idx >= 0 ? idx : rebuilt.length - 1];
    if (target) setActiveTab(target.id);
    return true;
  } catch (_) {
    return false;
  }
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
}

/**
 * 把浮层菜单定位到锚点附近，并**保证完整可见**。
 *
 * 【为什么要实测尺寸，而不是用写死的估算值】
 * 旧实现是「窗口高 - 写死的估算高度」来夹取 top：
 *   const maxY = Math.max(0, window.innerHeight - 240);
 * 菜单项会随功能增减，实际高度经常超过这个估算值，
 * 底部就被窗口边缘截断 —— 表现为「右键位置靠近下方时菜单显示不全」。
 * （截图里的通用菜单有 11 项 + 3 个分隔线，实测约 310px，远超 240 的估算。）
 *
 * 【现在的行为与 Chrome 一致】
 *   1. 先显示再测量实际尺寸（隐藏时 getBoundingClientRect 全是 0）；
 *   2. 下方放不下就**向上弹**（底边对齐锚点）；
 *   3. 上方也放不下（菜单比视口还高）就贴顶，并限制最大高度 + 允许滚动；
 *   4. 水平方向同理：右侧放不下就翻到左侧。
 *
 * @param {HTMLElement} el 菜单元素
 * @param {number} x 锚点横坐标（宿主视口坐标）
 * @param {number} y 锚点纵坐标
 * @param {object} [opts]
 * @param {'point'|'below'} [opts.mode]
 *   'point'（默认）：以锚点为菜单左上角，Chrome 风格的右键菜单；
 *   'below'：显示在锚点**下方**（用于锚定到某个按钮的菜单），
 *            下方放不下时翻到锚点上方。
 * @param {number} [opts.anchorTop] 'below' 模式下锚点矩形的上沿（用于向上翻转）
 */
/**
 * 顶部外壳（工具栏 / 书签栏 / 标签栏）中仍可见部分的下沿。
 * 这些区域是 -webkit-app-region: drag，浮层压在上面时物理点击可能拖窗口。
 * 无框模式下它们被隐藏，返回 0。
 */
function getVisibleShellBottom() {
  let bottom = 0;
  ['.toolbar', '#bookmarks-bar', '#tab-bar'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  });
  return bottom;
}

function positionContextMenu(el, x, y, opts) {
  const o = opts || {};
  const margin = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 先显示才量得到实际尺寸；量之前清掉上一次的 max-height/overflow，
  // 否则「上次被限高」的菜单这次会按限高后的尺寸定位。
  el.style.maxHeight = '';
  el.style.overflowY = '';
  el.classList.remove('hidden');
  el.style.left = '0px';
  el.style.top = '0px';

  const rect = el.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  // ---- 水平 ----
  let left = x;
  if (left + w + margin > vw) left = x - w; // 右侧放不下 → 翻到左侧
  if (left < margin) left = margin; // 翻到左侧还越界 → 贴左
  if (left + w + margin > vw) left = Math.max(margin, vw - w - margin); // 兜底贴右

  // ---- 垂直 ----
  let top;
  if (o.mode === 'below') {
    top = y; // y 是锚点矩形的下沿
    if (top + h + margin > vh) {
      // 下方放不下 → 翻到锚点上方
      top = (typeof o.anchorTop === 'number' ? o.anchorTop : y) - h;
    }
  } else {
    top = y; // y 是点击点
    if (top + h + margin > vh) top = y - h; // 下方放不下 → 向上弹
  }
  if (top < margin) top = margin; // 上方也放不下 → 贴顶

  // 避开顶部拖拽区：右键点靠近窗口上沿时，菜单会盖在工具栏/标签栏上。
  // 截图实测：只有落在那一块上的菜单项点不动，其它项正常 —— 是位置问题，
  // 不是菜单项的事件绑定问题。整体推到外壳下方即可彻底避开。
  const shellBottom = getVisibleShellBottom();
  if (top < shellBottom + margin) top = shellBottom + margin;

  // ---- 兜底：菜单仍会超出底边 ----
  // 两种情况：
  //   a) 锚点本身在视口外（点击点 y > 视口高，向上翻后底边仍越界）；
  //   b) 菜单比视口还高。
  if (top + h + margin > vh) {
    if (h + margin * 2 > vh) {
      // 菜单比视口还高 → 限高 + 允许滚动
      el.style.maxHeight = Math.max(120, vh - margin * 2) + 'px';
      el.style.overflowY = 'auto';
      top = margin;
    } else {
      top = Math.max(margin, vh - h - margin); // 夹进视口
    }
  }

  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

function showContextMenu(x, y, linkUrl) {
  if (!linkUrl) return;
  contextMenuList.innerHTML = '';

  function item(label, action) {
    const li = document.createElement('li');
    li.textContent = label;
    li.addEventListener('click', () => {
      try {
        action();
      } catch (_) {
        /* ignore */
      }
      hideContextMenu();
    });
    contextMenuList.appendChild(li);
  }

  function divider() {
    const li = document.createElement('li');
    li.className = 'divider';
    contextMenuList.appendChild(li);
  }

  item('在新标签页中打开', () => createTab(linkUrl));
  item('在新窗口中打开', () => {
    if (window.electronAPI && window.electronAPI.createWindow) {
      window.electronAPI.createWindow(linkUrl);
    }
  });
  divider();
  item('复制链接地址', () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(linkUrl);
    }
  });

  positionContextMenu(contextMenu, x, y);
}

// ---------- 无框模式（隐藏工具栏/收藏夹/标签栏，仅留网页内容）----------
// 通过右键菜单「进入/退出无框模式」切换；状态持久化，重启后保持。
function applyFrameless(on) {
  document.body.classList.toggle('frameless', !!on);
  try {
    localStorage.setItem('mb_frameless', on ? '1' : '0');
  } catch (_) {
    /* 隐私模式等 localStorage 不可用时忽略 */
  }
}

function toggleFrameless() {
  applyFrameless(!document.body.classList.contains('frameless'));
}

// ---------- 无框模式2（无框 + 四角直角标识页面范围）----------
// 与「无框模式」的差别：同样隐藏工具栏/收藏夹栏/标签栏，
// 但在窗口四角显示「∟」形直角，用于标识页面范围——
// 无框后窗口没有系统标题栏，用户缺少「窗口在哪、页面到哪」的边界参照。
//
// 三种模式互斥：进入任一模式前先退出其它模式，
// 否则 frameless + frameless2 同时生效时，直角标识会被无框模式的
// 全屏网页盖住（或反之），出现「进入模式2 后直角消失」这类难以排查的现象。
function applyFrameless2(on) {
  const next = !!on;
  document.body.classList.toggle('frameless2', next);
  try {
    localStorage.setItem('mb_frameless2', next ? '1' : '0');
    // 持久化也要互斥：否则两个键同时为 '1'，重启恢复时会出现模式叠加。
    // 这里不直接改localStorage 的 mb_frameless（那会让模式1 的 UI 文案失真），
    // 而是在 enterFrameless2() 里调applyFrameless(false) 统一收口。
  } catch (_) {
    /* 隐私模式等 localStorage 不可用时忽略 */
  }
}

function isFrameless2() {
  return document.body.classList.contains('frameless2');
}

/** 进入无框模式2：先退出无框模式1（两者互斥），再开启模式2。 */
function enterFrameless2() {
  if (document.body.classList.contains('frameless')) applyFrameless(false);
  applyFrameless2(true);
}

/** 退出无框模式2。 */
function exitFrameless2() {
  applyFrameless2(false);
}

function toggleFrameless2() {
  if (isFrameless2()) exitFrameless2();
  else enterFrameless2();
}

// ---------- 透明模式（窗口与页面背景透明，透出桌面）----------
// 依赖主进程将 BrowserWindow 设为 transparent:true。普通模式下各部件自带不透明背景，外观不变；
// 仅当 body 带上 .transparent 类时，外壳与网页背景变为透明。
// 网页背景透明通过向每个 <webview> 注入 CSS 实现（html,body 背景透明）。
const TRANSPARENT_PAGE_CSS =
  'html, body { background-color: transparent !important; background-image: none !important; }';

// ---------- 完全透明模式（透明模式的加强版）----------
// 透明模式只把 html/body 的背景清掉，页面内部元素（div/section/表格/卡片等）
// 自带的背景色、背景图仍在，视觉上仍有大块色块。
// 完全透明模式在此基础上更进一步：**只保留文字**，所有图形内容一律不显示，
// 整个网页变成「悬浮在桌面上的纯文字」。
//
// 实现要点：
// - 用 * 通配 + !important，压过页面自身样式（页面规则通常也带 !important，
//   此时靠「后注入」取胜：insertCSS 注入的样式在页面样式表之后，优先级更高）；
// - 同时清 background-image（渐变/纹理背景也是「不透明」的一大来源）；
// - 图形元素用 **visibility: hidden** 而非 display: none：
//   display:none 会让元素脱离文档流、图片占位消失、整页文字重排，
//   视觉上会「塌掉」；visibility:hidden 保留占位与文字位置，只是不显示图形，
//   符合「透明」的语义（东西还在那儿，只是不画出来）。
//   附带好处：visibility:hidden 的元素不接收鼠标事件，不会出现「看不见但能点」。
// - 文字本身不受影响：只针对媒体/图形类元素，不动 color 与 text-* 属性。
// - box-shadow 不清：它是装饰性阴影而非背景，清掉会让页面结构难以辨认。
const FULL_TRANSPARENT_PAGE_CSS = `
html, body, body * {
  background-color: transparent !important;
  background-image: none !important;
}
/* 伪元素的背景图（很多站点用它做装饰性小图标）同样清掉 */
html::before, html::after, body::before, body::after, body *::before, body *::after {
  background-image: none !important;
}
/* 隐藏一切图形内容，只留文字 */
img, picture, svg, canvas, video, audio, iframe, embed, object,
input[type="image"], input[type="file"], area, map, track {
  visibility: hidden !important;
}
/* 边框图/遮罩图（clip-path 之外常见的图形来源） */
body * {
  border-image: none !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
}
/* 文字可读性保障：完全透明后网页文字直接浮在桌面上，
   桌面壁纸明暗不可控 —— 深色壁纸配深色文字会完全看不见。
   这里不改 color（避免与站点自身配色打架），而是给文字加一圈
   极淡的对比描边：亮暗两种底色下都能读出轮廓。
   实测 0.3px 描边对元素宽度的影响为 0px（不会引起重排）。
   说明：描边施加在元素上，未含直接文字的容器同样会得到描边属性，
   但因容器本身无字形故无视觉影响；这比逐个判断「是否含直接文本节点」代价低得多。 */
html, body, body * {
  -webkit-text-stroke: 0.3px rgba(128, 128, 128, 0.55);
}`;

// ---------- 去粗体 ----------
// 把当前页面的粗体字全部降为常规字重。
//
// 用 * 通配 + !important，而不是只挑 b/strong/h1 这类语义标签：
//   语义标签会漏掉大量用 class 加粗的元素（.fw-bold、.text-bold、
//   .font-semibold 等，各站点命名五花八门），以及内联 style 写的
//   font-weight:600/700 —— 而这些恰恰是页面上「粗体」的主要来源。
//
// 已知副作用：原本用 font-weight:300/200 的**细体**字会被一并提为常规字重。
// CSS 无法只对「计算值 ≥ 600」的元素生效（没有这样的选择器），
// 只能在「全量降为 normal」与「逐个猜语义标签」之间取舍。
// 细体字在网页里远比粗体字少见，这个副作用总体可接受。
const DEBOLD_PAGE_CSS = `
*, *::before, *::after {
  font-weight: normal !important;
}`;

/**
 * 每个 webview 记录各类注入 CSS 的 key。
 * webview -> Map<名称, insertCSS 返回的真正 key>
 */
const _injectedCssKeys = new WeakMap();

/**
 * 给 webview 注入 / 移除一段 CSS，并记录 key 以便撤销。
 *
 * 【三个要点，全部实测踩过】
 *
 * 1) webview.insertCSS(code) 返回的是 **Promise<string>**（那把唯一 key），
 *    不是字符串本身。
 *    早先的实现把返回值直接存进 Map —— 存进去的其实是那个 Promise 对象，
 *    后续 removeInsertedCSS(Promise) 会静默失败 → 样式永远撤不掉，
 *    表现为「透明模式开了就关不掉」。
 *    必须用 .then() 拿到真正的 key 再存。
 *
 * 2) insertCSS 注入的样式**在页面导航后会被清除**。
 *    页面还没加载时注入的样式会落在 about:blank 上，等真页面加载完就没了 ——
 *    所以导航完成后必须 force 重新注入，否则开关只在「首次打开时」有效。
 *
 * 3) force 重注入时旧的 key 已随导航失效，要直接丢弃重来，
 *    不能因为「Map 里已经有」就跳过。
 *
 * @param {object} webview 目标 webview
 * @param {string} name 用途标识（同一 webview 下互不干扰）
 * @param {string} css 要注入的 CSS
 * @param {boolean} on 是否开启
 * @param {boolean} force 是否强制重新注入（导航后用）
 */
function setInjectedCss(webview, name, css, on, force) {
  if (!webview || typeof webview.insertCSS !== 'function') return;
  let store = _injectedCssKeys.get(webview);
  if (!store) {
    store = new Map();
    _injectedCssKeys.set(webview, store);
  }
  const key = store.get(name);
  // 每次操作递增代号：insertCSS 是异步的，快速关闭再开启时，
  // 迟到的 Promise 不能用旧 key 覆盖新状态（否则样式关不掉）。
  const genKey = name + ':gen';
  const gen = (store.get(genKey) || 0) + 1;
  store.set(genKey, gen);

  if (!on) {
    // 无论 key 是否已到达都要标记关闭；晚到的 key 会在 then 里被移除。
    store.delete(name);
    if (key != null) {
      try {
        const p = webview.removeInsertedCSS(key);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }
    return;
  }
  if (key != null && !force) return;
  store.delete(name); // 强制重注入：旧 key 已失效
  try {
    const p = webview.insertCSS(css);
    if (p && typeof p.then === 'function') {
      p.then((k) => {
        if (store.get(genKey) !== gen) {
          // 期间已被关闭或又发起了一次注入：这个 key 已过期，立即移除，避免样式残留。
          if (k) {
            try {
              const r = webview.removeInsertedCSS(k);
              if (r && typeof r.catch === 'function') r.catch(() => {});
            } catch (_) {
              /* ignore */
            }
          }
          return;
        }
        if (k) store.set(name, k);
      }).catch(() => {
        /* 某些页面 CSP 下 insertCSS 可能失败，忽略 */
      });
    }
  } catch (_) {
    /* ignore */
  }
}

function isTransparent() {
  return document.body.classList.contains('transparent');
}

/** 是否处于完全透明模式。 */
function isFullTransparent() {
  return document.body.classList.contains('full-transparent');
}

/**
 * 当前所处的透明档位。
 *   0 = 普通视图
 *   1 = 普通透明模式（窗口/页面背景透明，页面元素仍保留自己的底色）
 *   2 = 完全透明模式（在普通透明基础上清掉所有元素底色，只留文字）
 *
 * 【为什么要单独算一个档位，而不是直接看 transparent 类】
 * 完全透明在**实现上**依附普通透明 —— 外壳 body 的底色是靠 .transparent
 * 清掉的（见 styles.css 里 body.transparent{background:transparent}），
 * 所以进入完全透明时 transparent 类会顺带被打开。
 * 但对外而言它们是同一根轴上的两个**互斥档位**：此刻生效的是完全透明，
 * 普通透明并没有被单独开启。若菜单文案直接取 isTransparent()，
 * 点一次「进入完全透明模式」，旁边那项就会自己翻成「退出透明模式」——
 * 用户从没开过它，却被告知它已开启，点它还会把完全透明一起拽下来。
 * 因此菜单文案一律按档位给（与上面「无框模式 / 无框模式2」的处理方式一致）。
 */
function transparentLevel() {
  if (isFullTransparent()) return 2;
  if (isTransparent()) return 1;
  return 0;
}

// 对单个 webview 注入/移除透明 CSS。
function applyPageTransparent(webview, on, force) {
  setInjectedCss(webview, 'transparent', TRANSPARENT_PAGE_CSS, on, force);
}

/**
 * 对单个 webview 注入/移除「完全透明」CSS。
 * 与透明模式分开管理各自的 key：两者可叠加（完全透明必然包含透明），
 * 但退出时要能各自独立撤销，不能互相影响。
 */
function applyPageFullTransparent(webview, on, force) {
  setInjectedCss(webview, 'full-transparent', FULL_TRANSPARENT_PAGE_CSS, on, force);
}

/**
 * 对单个 webview 注入/移除「去粗体」CSS。
 *
 * 【两个必须注意的点（都是实测踩出来的）】
 *
 * 1) webview.insertCSS(code) 返回的是 **Promise<string>**（那个唯一 key），
 *    不是字符串本身。早期实现把返回值直接存进 Map，存的其实是那个 Promise 对象，
 *    后续 removeInsertedCSS(Promise) 会静默失败 → 样式永远撤不掉。
 *    必须用 .then() 拿到真正的 key 再存。
 *
 * 2) insertCSS 注入的样式**在页面导航后会被清除**，
 *    所以导航完成后必须强制重新注入，否则开关只在首次打开时有效。
 *    （force=true 时旧的 key 已随导航失效，直接丢弃重注入。）
 */
function applyPageDebold(webview, on, force) {
  // 主文档：insertCSS（浏览器侧 API，不依赖 preload 是否加载成功）
  setInjectedCss(webview, 'debold', DEBOLD_PAGE_CSS, on, force);
  // 同源 iframe：insertCSS 管不到（iframe 是独立文档），
  // 由 preload 遍历 accessibleDocuments 补注入。
  try {
    if (webview && typeof webview.send === 'function') {
      webview.send('mb-debold-frames', { on: !!on });
    }
  } catch (_) {
    /* preload 尚未就绪时会失败，dom-ready 时会补发 */
  }
}

/**
 * 应用某一透明档位的全部副作用：body class + 持久化 + 页面 CSS 注入。
 *
 * @param {number} level 0=普通视图 1=普通透明 2=完全透明
 */
function applyTransparentLevel(level) {
  const lv = level === 2 ? 2 : (level === 1 ? 1 : 0);
  const plain = lv >= 1;
  const full = lv === 2;

  document.body.classList.toggle('transparent', plain);
  document.body.classList.toggle('full-transparent', full);

  try {
    localStorage.setItem('mb_transparent', plain ? '1' : '0');
    localStorage.setItem('mb_full_transparent', full ? '1' : '0');
  } catch (_) {
    /* 隐私模式等 localStorage 不可用时忽略 */
  }

  tabs.forEach((t) => {
    if (!t.webview) return;
    // 两套 CSS 各自独立管理 key：完全透明档位下两套都要注入
    //（普通透明那套清 html/body 底色，完全透明那套清所有元素底色）。
    applyPageTransparent(t.webview, plain);
    applyPageFullTransparent(t.webview, full);
  });
}

/**
 * 切换透明档位。
 *
 * 【档位模型，取代原来「两个独立开关」的做法】
 * 普通透明与完全透明是**同一根轴上的两档**，不是两个独立开关：
 * 完全透明 = 普通透明 + 清掉所有元素底色（只留文字）。
 * 所以进入完全透明必然连带把普通透明也打开 —— 外壳 body 的底色是靠
 * .transparent 清掉的（styles.css 里 body.transparent{background:transparent}），
 * 页面背景同理。
 *
 * 但对外只应呈现「当前生效的是哪一档」。早先把菜单文案直接取
 * isTransparent()，于是点一次「进入完全透明模式」，旁边那项就自己
 * 翻成「退出透明模式」—— 用户从没单独开过普通透明，却被告知它已开启，
 * 点它还会把完全透明一起拽下来。现在菜单一律按 transparentLevel() 给文案。
 *
 * @param {number} level 0=普通视图 1=普通透明 2=完全透明
 * @param {object} [opts] keepAuto=true 时沿用已持久化的「普通透明是否自动开启」
 *   标记（启动恢复用，否则会因透明类已先恢复而误判）
 */
function setTransparentLevel(level, opts) {
  const lv = level === 2 ? 2 : (level === 1 ? 1 : 0);
  const wasTransparent = isTransparent();
  const wasFull = isFullTransparent();

  if (lv === 2) {
    // 进入完全透明：记下普通透明是不是用户自己开的。
    // 不是（原本没开）→ 退出完全透明时直接回普通视图；
    // 是（原本就开着）→ 退出后回到普通透明，保持用户原本的选择。
    let autoOn = false;
    try {
      autoOn = localStorage.getItem('mb_full_auto_transparent') === '1';
    } catch (_) {
      /* 隐私模式下 localStorage 不可用时按「非自动」处理 */
    }
    if (!(opts && opts.keepAuto)) autoOn = !wasTransparent;
    applyTransparentLevel(2);
    try {
      localStorage.setItem('mb_full_auto_transparent', autoOn ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
    return;
  }

  applyTransparentLevel(lv);
  // 离开完全透明时清掉自动标记；普通透明档位之间的切换不动它
  //（启动恢复时要靠它还原「退出完全透明后回哪一档」）。
  if (wasFull && lv < 2) {
    try {
      localStorage.setItem('mb_full_auto_transparent', '0');
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 兼容入口：开关「普通透明」这一档。
 * on=true 至少保证普通透明开着（在完全透明档位下则保持完全透明不变）。
 * on=false 退出普通透明 —— 完全透明依赖它，所以一并退回普通视图。
 */
function applyTransparent(on) {
  if (on) {
    if (transparentLevel() >= 1) return;
    setTransparentLevel(1);
  } else {
    setTransparentLevel(0);
  }
}

/**
 * 「透明模式」这一项的动作。
 *
 * 处于完全透明档位时，这一项的文案是「进入透明模式」，
 * 语义是**降一档**到普通透明，而不是把两个模式一起关掉
 * （与同一菜单里「无框模式 / 无框模式2」互斥档位的处理方式一致）。
 */
function toggleTransparent() {
  const lv = transparentLevel();
  if (lv === 2) {
    setTransparentLevel(1);
    return;
  }
  setTransparentLevel(lv === 1 ? 0 : 1);
}

/**
 * 兼容入口：开关「完全透明」这一档。
 * 退出时回到用户原本显式选择的那一档：
 * 原本只开了完全透明 → 回普通视图；原本也开着普通透明 → 回普通透明。
 */
function applyFullTransparent(on, opts) {
  if (on) {
    setTransparentLevel(2, opts);
    return;
  }
  if (!isFullTransparent()) return; // 本来就没开完全透明，无事可做
  let autoOn = false;
  try {
    autoOn = localStorage.getItem('mb_full_auto_transparent') === '1';
  } catch (_) {
    /* ignore */
  }
  setTransparentLevel(autoOn ? 0 : 1);
}

function toggleFullTransparent() {
  applyFullTransparent(!isFullTransparent());
}

// 通用右键菜单：页面空白/选中文字、或外壳工具栏右键时弹出，
// 提供无框模式开关与常用导航项（刷新/后退/前进/开发者工具）。
function showPageContextMenu(x, y) {
  contextMenuList.innerHTML = '';

  function item(label, action) {
    const li = document.createElement('li');
    li.textContent = label;
    li.addEventListener('click', () => {
      try {
        action();
      } catch (_) {
        /* ignore */
      }
      hideContextMenu();
    });
    contextMenuList.appendChild(li);
  }

  function divider() {
    const li = document.createElement('li');
    li.className = 'divider';
    contextMenuList.appendChild(li);
  }

  const on = document.body.classList.contains('frameless');
  item(on ? '退出无框模式' : '进入无框模式', () => {
    // 与无框模式2互斥：进入模式1 前先退出模式2，避免两个模式叠加
    if (!on && isFrameless2()) exitFrameless2();
    toggleFrameless();
  });
  // 「进入无框模式2」紧跟在「进入无框模式」下方
  const on2 = isFrameless2();
  item(on2 ? '退出无框模式2' : '进入无框模式2', toggleFrameless2);
  // 透明模式 / 完全透明模式：同一根轴上的两档，文案按「当前生效的是哪一档」给。
  // 不能直接用 isTransparent() —— 完全透明会连带打开普通透明（外壳 body 底色
  // 依赖 .transparent），直接用它会让「进入透明模式」在点了「进入完全透明模式」
  // 之后自己翻成「退出透明模式」，而用户从没单独开过普通透明。
  const lvT = transparentLevel();
  item(lvT === 1 ? '退出透明模式' : '进入透明模式', toggleTransparent);
  // 「进入完全透明模式」紧跟在「进入透明模式」下方
  const lvFT = transparentLevel() === 2;
  item(lvFT ? '退出完全透明模式' : '进入完全透明模式', toggleFullTransparent);
  divider();
  item('刷新', () => {
    const t = activeTab();
    if (t) {
      if (t.loading) t.webview.stop();
      else t.webview.reload();
    }
  });
  item('后退', () => {
    const wv = activeWebview();
    if (wv) wv.goBack();
  });
  item('前进', () => {
    const wv = activeWebview();
    if (wv) wv.goForward();
  });
  item('关闭当前标签页', () => {
    // 与 Ctrl+W 走同一条路径：会记录到「最近关闭」、恢复相邻标签，
    // 且关掉最后一个标签时自动补一个首页标签，不会留下空窗口。
    if (activeTabId) closeTab(activeTabId);
  });
  divider();
  item('开发者工具', () => {
    const wv = activeWebview();
    if (wv) wv.openDevTools();
  });
  divider();
  // 「钉在桌面」也放在右键菜单里 —— 无框模式(1/2)下工具栏是隐藏的，
  // 那里没有图钉按钮可点。
  item(isWindowPinned() ? '取消钉在桌面' : '钉在桌面（窗口置顶）', () => {
    setPinned();
  });
  divider();
  item('最小化窗口', () => {
    if (window.electronAPI && window.electronAPI.windowControl) window.electronAPI.windowControl('min');
  });
  item('关闭窗口', () => {
    if (window.electronAPI && window.electronAPI.windowControl) window.electronAPI.windowControl('close');
  });
  item('隐藏窗口', () => {
    // 隐藏后进程与下载继续运行；要重新显示，需在 cmd 中运行 show.js 连接本地服务
    if (window.electronAPI && window.electronAPI.hideWindow) window.electronAPI.hideWindow();
  });

  positionContextMenu(contextMenu, x, y);
}

// 点菜单之外 → 关闭菜单。用mousedown 而非 click：
// 菜单是浮在页面之上的高层 UI，等到 click（mouseup 之后）才消失的话，
// 视觉上会「按下去菜单还在、松手才消失」，手感发木。
//网页内容区的点击不在这里覆盖（guest 进程不冒泡），由 webview-preload 转发
// mb-page-pointer-down 走 ipc-message 分支处理，两侧时机保持一致。
document.addEventListener('mousedown', (e) => {
  if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
  // 缩放菜单：点它自己或缩放按钮以外的地方都收起。
  // 缩放按钮的 click 里也做了 stopPropagation，这里再挡一次，
  // 避免「点按钮关菜单」与「点按钮开菜单」互相打架。
  if (zoomMenu && !zoomMenu.classList.contains('hidden') &&
      !zoomMenu.contains(e.target) && e.target !== zoomBtn) {
    hideZoomMenu();
  }
});

// 外壳区域（工具栏 / 收藏夹 / 标签栏 / 面板）右键也弹出无框模式菜单；
// 输入框、可编辑区域、右键菜单自身则保留系统默认行为。
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (!t) return;
  if (contextMenu.contains(t)) {
    e.preventDefault(); // 菜单本身上右键：抑制系统菜单，保留我们的菜单
    return;
  }
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  e.preventDefault();
  showPageContextMenu(e.clientX, e.clientY);
});

function wireWebview(tab) {
  const wv = tab.webview;

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    if (tab.id === activeTabId) {
      loadingBar.classList.add('active');
      setButtonIcon(reloadBtn, 'i-stop');
    }
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    if (tab.id === activeTabId) {
      loadingBar.classList.remove('active');
      setButtonIcon(reloadBtn, 'i-reload');
    }
  });
  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    restoreZoomFor(tab); // 套用该站点记忆的缩放
    // insertCSS 注入的样式在导航后会被清除，
    // 所有开着的注入类开关都要强制重新注入一次（force=true，
    // 因为旧 key 已随导航失效，不能因为「已注入过」就跳过）。
    if (tab.debold) applyPageDebold(tab.webview, true, true);
    if (isTransparent()) applyPageTransparent(tab.webview, true, true);
    if (isFullTransparent()) applyPageFullTransparent(tab.webview, true, true);
    if (tab.id === activeTabId) {
      urlInput.value = e.url;
      updateLock(e.url);
      refreshBookmarkStar();
    }
    renderTabElement(tab);
    addHistory(e.url, tab.title);
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (tab.id === activeTabId) {
      urlInput.value = e.url;
      refreshBookmarkStar();
    }
  });
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    if (tab.id === activeTabId) {
      document.title = (e.title ? e.title + ' - ' : '') + 'MiniBrowser';
    }
    updateHistoryTitle(tab.url, e.title);
    renderTabElement(tab);
    saveTabs();
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons.length) {
      tab.favicon = e.favicons[0];
      renderTabElement(tab);
      if (tab.id === activeTabId) showFavicon(tab.favicon);
      saveTabs();
    }
  });
  // 页面内查找的匹配结果回传
  wv.addEventListener('found-in-page', (e) => {
    const r = e.result || {};
    if (typeof r.matches !== 'number') return;
    // 切标签后旧标签可能还在上报查找结果，不能让它覆盖当前页的计数。
    if (tab.id !== activeTabId) return;
    updateFindCount(r.matches, r.activeMatchOrdinal);
  });
  wv.addEventListener('new-window', (e) => {
    e.preventDefault();
    if (/^(https?:|about:|file:)/i.test(e.url)) openUrlFromPage(e.url);
    else openExternalUrl(e.url);
  });
  // 接收 webview-preload.js 通过 sendToHost 转发的新窗口请求 / 右键菜单
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'mb-new-window') {
      const payload = e.args && e.args[0] ? e.args[0] : {};
      const url = payload.url;
      if (!url) return;
      if (/^(https?:|about:|file:)/i.test(url)) openUrlFromPage(url);
      else openExternalUrl(url);
      return;
    }
    if (e.channel === 'mb-find') {
      // 页面内按 Ctrl/Cmd+F 或 Esc，由 webview-preload 转发过来
      const payload = e.args && e.args[0] ? e.args[0] : {};
      if (payload.action === 'close') closeFindBar();
      else openFindBar();
      return;
    }
    if (e.channel === 'mb-shortcut') {
      // 网页聚焦时宿主收不到 keydown，guest 转发到这里走同一套快捷键逻辑。
      const payload = e.args && e.args[0] ? e.args[0] : {};
      handleAppShortcut(!!payload.ctrl, !!payload.shift, payload.key);
      return;
    }
    if (e.channel === 'mb-page-handler-error') {
      // guest 里的页内处理器抛了异常。
      // 这类错误在页面上**完全不可见**（用户只会觉得「右键没反应」），
      // 必须在这里记下来，否则排查时毫无线索。
      const payload = (e.args && e.args[0]) || {};
      console.error('[page-handler] ' + (payload.handler || '?') + ' 抛异常: ' +
        (payload.message || '') + (payload.stack ? '\n' + payload.stack : ''));
      return;
    }
    if (e.channel === 'mb-window-drag') {
      // 网页内容区（guest 进程）里的 Alt+左键，由 webview-preload 检测后转发。
      // 复用宿主的同一套开始/结束逻辑，主进程侧无需区分事件来自哪个进程。
      const payload = (e.args && e.args[0]) || {};
      const hook = window.__mbAltDrag;
      if (!hook) return;
      if (payload.action === 'start') hook.begin(payload.x || 0, payload.y || 0);
      else hook.end();
      return;
    }
    if (e.channel === 'mb-page-pointer-down') {
      // 网页内容区左键点击 → 关闭浮层。
      // 必须在 mousedown 阶段就关掉：浮层是高层 UI，若等 click（mouseup 之后）
      // 才消失，视觉上会「点下去浮层还在、松手才消失」。
      hideContextMenu();
      // 收藏夹弹层同理：它原本只在**外壳 document** 上监听 click，
      // 而 <webview> 是独立 guest 进程，网页内的点击不会冒泡到外壳 document，
      // 表现为「点网页内容区，收藏弹层不消失」。
      // 与右键菜单共用这个通道，两者都是「点外部关闭」的浮层。
      closeBookmarksPopover();
      // 设置/历史/下载面板原本只在外壳 document 上监听点击，
      // 点网页内容区时同样关不掉，这里一并收起（与外壳点击的行为保持一致）。
      closePanelsOnOutsideClick();
      return;
    }
    if (e.channel === 'mb-context-menu') {
      const payload = e.args && e.args[0] ? e.args[0] : {};
      const link = payload.link;
      const rect = wv.getBoundingClientRect();
      const x = rect.left + (payload.x || 0);
      const y = rect.top + (payload.y || 0);
      if (link && link.url) showContextMenu(x, y, link.url);
      else showPageContextMenu(x, y); // 页面空白/选中文字：通用菜单（含无框模式开关）
      return;
    }
    if (e.channel === 'mb-videos-updated') {
      lastPageVideos = (e.args && e.args[0]) || [];
      if (pendingVideoDownload) {
        pendingVideoDownload = false;
        // 页面有多个视频时，弹出选择面板让用户挑下载哪一个；单个则直接下载
        if (lastPageVideos.length > 1) showVideoPicker(lastPageVideos);
        else downloadFromCachedVideos();
      }
      return;
    }
    if (e.channel === 'mb-video-context-menu') {
      const payload = e.args && e.args[0] ? e.args[0] : {};
      showVideoContextMenu(payload, wv);
      return;
    }
  });
  wv.addEventListener('will-navigate', (e) => {
    const u = e.url;
    if (!/^(https?:|about:|file:)/i.test(u)) {
      e.preventDefault();
      openExternalUrl(u);
    }
  });
  // 透明模式：webview 就绪后按当前透明状态注入/保持页面背景透明 CSS
  // 页面自身的缩放变化（Ctrl+滚轮等 Chromium 原生缩放）也要同步到按钮上。
  //
  // 原生缩放不经过应用，tab.zoomLevel 不会变，按钮会一直显示 100%，
  // 而页面其实已经被放大 —— 用户看到「按钮显示 100%、页面却不是 100%」，
  // 点按钮也只会重置应用自己的档位，状态始终对不上。
  // 这里把 webview 报告的实际 level 同步回来，两者就一致了。
  wv.addEventListener('zoom-changed', (e) => {
    if (typeof e.zoomLevel !== 'number') return;
    tab.zoomLevel = e.zoomLevel;
    if (tab.id === activeTabId) updateZoomIndicator();
  });

  wv.addEventListener('dom-ready', () => {
    if (isTransparent()) applyPageTransparent(wv, true);
    // 去粗体：preload 此刻才刚就绪，之前发的 mb-debold-frames 消息它听不到
    // （webview.send 在 preload 加载完成前发出会丢失），这里补发一次。
    // 用 force=true 让主文档的 insertCSS 也重新注入一遍 —— 导航会清掉旧样式。
    if (tab.debold) applyPageDebold(wv, true, true);
    // 完全透明模式同理：页面导航后需重新注入「清掉所有元素背景」的 CSS，
    // 否则表现为「刷新后退回普通透明模式」。
    if (isFullTransparent()) applyPageFullTransparent(wv, true);
    // 页面导航后主世界上下文会被清空，之前注入的橡皮擦脚本随之消失。
    // 若用户正处于擦除模式，必须重新注入，否则表现为「刷新后橡皮擦失灵」。
    // WeakSet 记的是「这个 webview 曾经注入过」，导航后要主动失效重来。
    // 不限定活动标签：后台标签导航完，切回来时也应立即可用。
    if (eraserActive) {
      eraserInjected.delete(wv);
      applyEraser(wv, true);
    }
  });
}

// ---------- 工具栏事件（作用于当前活动标签） ----------
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(urlInput.value);
});
goBtn.addEventListener('click', () => navigate(urlInput.value));
homeBtn.addEventListener('click', () => {
  const wv = activeWebview();
  if (!wv) return;
  wv.src = homeUrl();
  urlInput.value = homeUrl();
});
reloadBtn.addEventListener('click', () => {
  const t = activeTab();
  if (!t) return;
  if (t.loading) t.webview.stop();
  else t.webview.reload();
});
backBtn.addEventListener('click', () => {
  const wv = activeWebview();
  if (wv) wv.goBack();
});
forwardBtn.addEventListener('click', () => {
  const wv = activeWebview();
  if (wv) wv.goForward();
});
bookmarkBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleBookmark();
});
devtoolsBtn.addEventListener('click', () => {
  const wv = activeWebview();
  if (wv) wv.openDevTools();
});
videoDlBtn.addEventListener('click', () => {
  requestAndDownloadVideo();
});

savePageBtn.addEventListener('click', (e) => {
  // 阻止冒泡：否则同一个 click 会触发 document 的「点菜单外关闭」逻辑，导致菜单刚弹出就被关掉（表现为「点击没反应」）
  e.stopPropagation();
  showSavePageMenu(savePageBtn);
});

// ---------- 橡皮擦（删除页面元素）----------
// 交互：点按钮进入「擦除模式」→ 鼠标悬停高亮目标元素 → 点击删除该元素及其全部子元素。
// 再点一次按钮（或在页面里按 Esc）退出擦除模式。
//
// 实现说明（为什么不用 DevTools 的 Ctrl+Shift+C 拾取器）：
// <webview> 的 openDevTools() 只有 docked/undocked/detach 三种模式，
// 没有「不显示窗口」的选项；即使 detach 后立刻 closeDevTools()，拾取器也随DevTools 前端销毁。
// 更关键的是 DevTools 拾取器本身**没有删除 DOM 节点的能力**，只能改样式/复制外链。
// 因此这里在页面主世界自绘拾取器，视觉与交互对齐 DevTools 元素检查器，但点击直接删除。
//
// 橡皮擦（删除页面元素）状态。提前到全局变量区声明：setActiveTab() 等
// 靠前的函数也会读它，避免声明顺序靠后引起的 TDZ 困扰。
let eraserActive = false;
/** 已注入过橡皮擦脚本的 webview，避免重复注入（重复注入会导致监听器叠加、一次点击删多次）。 */
const eraserInjected = new WeakSet();

// 注入方式：把本地 element-eraser.js 读成文本，用 executeJavaScript 注入到页面**主世界**。
// 必须注入主世界而非隔离世界（preload），因为要操作页面真实的 DOM。

/** 读取本地橡皮擦脚本源码（浏览器端无 fs，走同步 XHR）。 */
function loadEraserSource() {
  if (loadEraserSource._cached) return loadEraserSource._cached;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'element-eraser.js', false); // 同步：注入必须一次完成
    xhr.send(null);
    loadEraserSource._cached = xhr.responseText;
  } catch (_) {
    loadEraserSource._cached = null;
  }
  return loadEraserSource._cached;
}

/**
 * 向指定 webview 注入橡皮擦脚本并设置启用状态。
 * @param {boolean} on 是否启用（false 时只停用，不重复注入）
 */
function applyEraser(wv, on) {
  if (!wv || typeof wv.executeJavaScript !== 'function') return;
  // 停用时无需注入脚本，直接调用已挂载的全局函数即可
  if (!on) {
    if (!eraserInjected.has(wv)) return;
    wv.executeJavaScript('try{ window.__mbEraserToggle && window.__mbEraserToggle(false); }catch(e){}')
      .catch(() => {});
    return;
  }

  if (eraserInjected.has(wv)) {
    wv.executeJavaScript('try{ window.__mbEraserToggle && window.__mbEraserToggle(true); }catch(e){}')
      .catch(() => {});
    return;
  }

  const src = loadEraserSource();
  if (!src) {
    toast('橡皮擦脚本加载失败');
    return;
  }
  // 注入脚本：element-eraser.js 执行时会把 start/stop 挂到 window 上，
  // 这里只补一个统一切换入口 __mbEraserToggle，启停都走它。
  // 注：页面内按 Esc 只会停用页面侧的拾取器，不回传宿主（主世界拿不到 ipcRenderer，
  // executeJavaScript 也无法把回调带回宿主）。为避免「按钮亮着但功能已关」的状态不一致，
  // 退出统一由按钮控制。
  const code =
    'try{' +
    src +
    '\n;window.__mbEraserToggle=function(on){try{on?window.__mbEraserStart():window.__mbEraserStop();}catch(e){}};' +
    'window.__mbEraserToggle(true);' +
    '}catch(e){console.error("[mb] eraser inject failed", e);}';
  wv.executeJavaScript(code)
    .then(() => {
      eraserInjected.add(wv);
    })
    .catch((err) => {
      console.error('[mb] eraser inject failed', err);
      toast('橡皮擦无法作用于该页面');
    });
}

/** 更新按钮的选中态（aria-pressed + title 提示）。 */
function setEraserButtonState(on) {
  eraserActive = !!on;
  if (!eraserBtn) return;
  eraserBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  eraserBtn.title = on
    ? '橡皮擦已开启：点击页面元素即可删除（再次点击按钮退出）'
    : '橡皮擦：选中后点击页面元素即可删除该元素及其全部子元素';
}

/** 对当前活动标签页的 webview 应用橡皮擦状态。 */
function applyEraserToActiveTab(on) {
  const wv = activeWebview();
  if (wv) applyEraser(wv, on);
}

eraserBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const next = !eraserActive;
  setEraserButtonState(next);
  applyEraserToActiveTab(next);
  if (next) toast('橡皮擦已开启：点击页面元素即可删除');
});

// 无边框窗口控制：最小化 / 最大化切换 / 关闭（系统标题栏已隐藏，由工具栏按钮承接）
if (window.electronAPI && window.electronAPI.windowControl) {
  const winMin = document.getElementById('win-min');
  const winMax = document.getElementById('win-max');
  const winClose = document.getElementById('win-close');
  if (winMin) winMin.addEventListener('click', () => window.electronAPI.windowControl('min'));
  if (winMax) winMax.addEventListener('click', () => window.electronAPI.windowControl('max'));
  if (winClose) winClose.addEventListener('click', () => window.electronAPI.windowControl('close'));
}

function navigate(input) {
  const wv = activeWebview();
  if (!wv) return;
  const url = normalizeUrl(input);
  if (!url) return;
  wv.src = url;
  urlInput.blur();
}

// ---------- 收藏夹（支持文件夹，树形结构） ----------
// 内存中持有唯一 live 根节点：所有读写都作用在同一棵树上，避免重复解析造成引用不一致。
let _bmRoot = null;

function getBookmarks() {
  if (!_bmRoot) {
    try {
      const raw = localStorage.getItem('mb_bookmarks');
      if (raw) _bmRoot = window.BookmarksIO.normalizeRoot(JSON.parse(raw));
    } catch (_) {
      /* ignore */
    }
    if (!_bmRoot) {
      _bmRoot = {
        type: 'folder',
        title: '',
        children: DEFAULT_BOOKMARKS.map((b) => ({ type: 'bookmark', title: b.title, url: b.url }))
      };
    }
  }
  return _bmRoot;
}

function saveBookmarks(root) {
  _bmRoot = root;
  localStorage.setItem('mb_bookmarks', JSON.stringify(root));
}

function resetBookmarks() {
  _bmRoot = null;
  localStorage.removeItem('mb_bookmarks');
}

// 在树中查找包含 target 节点的父文件夹（target 为根时返回 null）。
function findParentFolder(root, target) {
  for (const c of root.children || []) {
    if (c === target) return root;
    if (c.type === 'folder') {
      const f = findParentFolder(c, target);
      if (f) return f;
    }
  }
  return null;
}

// 把源树合并进目标树：同名文件夹递归合并，书签按 url 全局去重。
function mergeBookmarks(target, src) {
  let added = 0;
  const seen = new Set(window.BookmarksIO.flattenBookmarks(target).map((b) => b.url));
  (function walk(t, s) {
    (s.children || []).forEach((sc) => {
      if (sc.type === 'bookmark') {
        if (!seen.has(sc.url)) {
          t.children.push({ type: 'bookmark', title: sc.title, url: sc.url });
          seen.add(sc.url);
          added++;
        }
      } else {
        let f = t.children.find((c) => c.type === 'folder' && c.title === sc.title);
        if (!f) {
          f = { type: 'folder', title: sc.title, children: [] };
          t.children.push(f);
          added++;
        }
        walk(f, sc);
      }
    });
  })(target, src);
  return added;
}

function renderBookmarks() {
  const root = getBookmarks();
  bookmarksBar.innerHTML = '';
  root.children.forEach((node) => {
    if (node.type === 'folder') {
      const item = document.createElement('button');
      item.className = 'bookmark folder';
      item.title = '打开文件夹：' + node.title;
      item.textContent = '📁 ' + node.title;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        openBookmarksPopover(node);
      });
      bookmarksBar.appendChild(item);
      return;
    }
    const item = document.createElement('button');
    item.className = 'bookmark';
    item.title = node.url;

    // 收藏夹栏也显示站点图标（书签节点里的 icon 字段，
    // 老书签没有就按站点约定猜 /favicon.ico）。
    // 与收藏夹面板的区别：栏里空间紧凑，加载失败就**直接隐藏图标**，
    // 不像面板那样回退成 🔗 文字。
    const iconSrc = node.icon || guessFaviconUrl(node.url);
    if (iconSrc) {
      const icon = document.createElement('img');
      icon.className = 'bm-bar-favicon';
      icon.alt = '';
      icon.loading = 'lazy';
      icon.addEventListener('error', () => icon.remove());
      icon.src = iconSrc;
      item.appendChild(icon);
      // 超时兜底：请求被挂起时（代理拦截等）既不 error 也不 load，
      // 图标会一直空着 —— 超时未完成就当失败处理。
      setTimeout(() => {
        if (icon.isConnected && !icon.complete) icon.remove();
      }, 4000);
    }

    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = node.title;
    label.addEventListener('click', () => {
      const wv = activeWebview();
      if (wv) wv.src = node.url;
      urlInput.value = node.url;
    });
    item.appendChild(label);

    const del = document.createElement('span');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = '删除收藏';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      window.BookmarksIO.removeBookmarkByUrl(getBookmarks(), node.url);
      saveBookmarks(getBookmarks());
      renderBookmarks();
      refreshBookmarkStar();
    });
    item.appendChild(del);

    bookmarksBar.appendChild(item);
  });
  // 管理全部收藏夹
  const manage = document.createElement('button');
  manage.className = 'bookmark manage';
  manage.textContent = '📂';
  manage.title = '管理收藏夹';
  manage.addEventListener('click', (e) => {
    e.stopPropagation();
    openBookmarksPopover(getBookmarks());
  });
  bookmarksBar.appendChild(manage);
}

// ---------- 收藏夹弹出层（浏览 / 新建文件夹 / 收藏到此处 / 删除 / 重命名 / 编辑书签） ----------
let _bmCurrent = null; // 当前查看的文件夹节点（树中真实引用）
let _bmEditing = null; // 正在编辑的书签节点（树中真实引用）；null 表示不在编辑态
// 文件夹新建/重命名的行内编辑态：{ node, parent, isNew }。
// Electron 不支持 window.prompt（直接抛错），必须用行内输入框代替。
let _bmFolderEdit = null;

function openBookmarksPopover(folder) {
  _bmCurrent = folder || getBookmarks();
  _bmEditing = null;
  _bmFolderEdit = null;
  renderBookmarksPopover();
  bmPopover.classList.remove('hidden');
}

function closeBookmarksPopover() {
  bmPopover.classList.add('hidden');
  _bmCurrent = null;
  _bmEditing = null;
  _bmFolderEdit = null;
}

/**
 * 猜一个站点的 favicon 地址。
 *
 * 用于**收藏之前**就存在的老书签（那时还没记录 icon），
 * 以及页面还没上报 favicon 就被收藏的情况 ——
 * 大多数站点都在根目录放 /favicon.ico，猜对了就有图标，
 * 猜错了 <img> 加载失败会自动回退到 🔗（见渲染处），不会显示破图。
 *
 * @param {string} url 页面地址
 * @returns {string} 猜测的图标地址，无从猜测时返回空串
 */
function guessFaviconUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin + '/favicon.ico';
  } catch (_) {
    return '';
  }
}

function renderBookmarksPopover() {
  // 面包屑：根 -> ... -> 当前文件夹
  bmCrumbs.innerHTML = '';
  const root = getBookmarks();
  const path = [];
  (function findPath(node, trail) {
    if (node === _bmCurrent) {
      // 命中时把沿途文件夹写回 path，否则子目录层级永远显示不出来，
      // 用户也无法点面包屑回到上级。root 时 trail 为空，只显示根屑，符合预期。
      path.push(...trail);
      return true;
    }
    for (const c of node.children || []) {
      if (c.type === 'folder' && findPath(c, trail.concat(c))) return true;
    }
    return false;
  })(root, []);
  const rootCrumb = document.createElement('span');
  rootCrumb.className = 'bm-crumb';
  rootCrumb.textContent = '全部书签';
  rootCrumb.addEventListener('click', () => openBookmarksPopover(root));
  bmCrumbs.appendChild(rootCrumb);
  path.forEach((f) => {
    const sep = document.createElement('span');
    sep.className = 'bm-crumb-sep';
    sep.textContent = '›';
    bmCrumbs.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'bm-crumb';
    c.textContent = f.title || '未命名文件夹';
    c.addEventListener('click', () => openBookmarksPopover(f));
    bmCrumbs.appendChild(c);
  });

  bmList.innerHTML = '';
  // 新建文件夹时还没有树节点，编辑行放在列表开头。
  if (_bmFolderEdit && _bmFolderEdit.isNew) {
    bmList.appendChild(renderFolderEditRow());
  }
  // 兜底：_bmCurrent 可能为 null —— 例如刚收藏完时 closeBookmarksPopover()
  // 已经把它清空，而后续又有代码来刷新面板（此前会直接抛
  // "Cannot read properties of null (reading 'children')"，整个刷新中断）。
  if (!_bmCurrent) _bmCurrent = getBookmarks();
  if (!_bmCurrent.children.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-empty';
    empty.textContent = '此文件夹为空';
    bmList.appendChild(empty);
  }
  _bmCurrent.children.forEach((node) => {
    // 正在重命名这个文件夹 → 渲染行内输入框取代普通行
    if (_bmFolderEdit && !_bmFolderEdit.isNew && _bmFolderEdit.node === node) {
      bmList.appendChild(renderFolderEditRow());
      return;
    }
    // 正在编辑这一条 → 渲染编辑表单，取代普通行
    if (_bmEditing === node) {
      bmList.appendChild(renderBookmarkEditRow(node));
      return;
    }
    const row = document.createElement('div');
    row.className = 'bm-row ' + (node.type === 'folder' ? 'bm-row-folder' : 'bm-row-bm');

    const main = document.createElement('button');
    main.className = 'bm-row-main';
    // 书签带站点图标（收藏时从 tab.favicon 记下），没有图标时退回 🔗 文字标记。
    if (node.type === 'folder') {
      main.textContent = '📁 ' + node.title;
    } else {
      // 老书签没有 icon → 猜站点根目录的 /favicon.ico；
      // 加载失败会自动回退成 🔗（见下面的 error 处理）。
      const iconSrc = node.icon || guessFaviconUrl(node.url);
      if (iconSrc) {
        const icon = document.createElement('img');
        icon.className = 'bm-favicon';
        icon.alt = '';
        icon.loading = 'lazy';
        // 统一的回退动作：去掉破图，换成 🔗 文字标记。
        const fallbackToLink = () => {
          if (!icon.isConnected) return;
          icon.remove();
          main.textContent = '🔗 ' + node.title;
        };
        icon.addEventListener('error', fallbackToLink);
        icon.src = iconSrc;
        main.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'bm-row-label';
        label.textContent = node.title;
        main.appendChild(label);
        // 超时兜底：有些环境下请求会被**挂起**（代理拦截、网络不通），
        // 此时既不触发 error 也不触发 load，complete 一直为 false ——
        // 图标就会一直空着（浏览器画个破图或什么都不画）。
        // 所以额外加一个超时：还没加载完就按失败处理。
        setTimeout(() => {
          if (icon.isConnected && !icon.complete) fallbackToLink();
        }, 4000);
      } else {
        main.textContent = '🔗 ' + node.title;
      }
    }
    main.title = node.type === 'folder' ? '打开文件夹：' + node.title : node.url;
    if (node.type === 'folder') {
      main.addEventListener('click', (e) => {
        e.stopPropagation();
        openBookmarksPopover(node);
      });
    } else {
      main.addEventListener('click', (e) => {
        e.stopPropagation();
        bmOpenBookmark(node);
      });
    }
    row.appendChild(main);

    if (node.type === 'folder') {
      const rename = document.createElement('button');
      rename.className = 'bm-row-act';
      rename.textContent = '✎';
      rename.title = '重命名文件夹';
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        bmRenameFolder(node);
      });
      row.appendChild(rename);
    } else {
      // 书签：编辑标题与地址
      const edit = document.createElement('button');
      edit.className = 'bm-row-act';
      edit.textContent = '✎';
      edit.title = '编辑书签';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        bmStartEditBookmark(node);
      });
      row.appendChild(edit);
    }
    const del = document.createElement('button');
    del.className = 'bm-row-act bm-row-del';
    del.textContent = node.type === 'folder' ? '🗑' : '×';
    del.title = node.type === 'folder' ? '删除文件夹' : '删除收藏';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node.type === 'folder') bmDeleteFolder(node);
      else {
        window.BookmarksIO.removeBookmarkByUrl(getBookmarks(), node.url);
        saveBookmarks(getBookmarks());
        renderBookmarks();
        renderBookmarksPopover();
        refreshBookmarkStar();
      }
    });
    row.appendChild(del);

    bmList.appendChild(row);
  });

  renderBmHeader();
}

/**
 * 渲染书签的编辑表单行（标题 + 地址 + 保存 / 取消）。
 *
 * 做成**行内编辑**而非弹窗：被编辑的就是列表里的这一行，
 * 原地替换最自然，也不会像 prompt 那样只能改一个字段。
 *
 * @param {object} node 被编辑的书签节点（树中真实引用）
 * @returns {HTMLElement} 表单行元素
 */
function renderBookmarkEditRow(node) {
  const row = document.createElement('div');
  row.className = 'bm-row bm-edit-row';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'bm-edit-title';
  titleInput.value = node.title || '';
  titleInput.placeholder = '名称';

  const urlInputEl = document.createElement('input');
  urlInputEl.type = 'text';
  urlInputEl.className = 'bm-edit-url';
  urlInputEl.value = node.url || '';
  urlInputEl.placeholder = 'https://…';

  const save = document.createElement('button');
  save.className = 'bm-edit-btn bm-edit-save';
  save.textContent = '保存';
  save.title = '保存修改';

  const cancel = document.createElement('button');
  cancel.className = 'bm-edit-btn';
  cancel.textContent = '取消';
  cancel.title = '取消修改';

  function commit() {
    const t = titleInput.value.trim();
    const u = urlInputEl.value.trim();
    if (!u) {
      toast('地址不能为空');
      urlInputEl.focus();
      return;
    }
    if (!t) {
      toast('名称不能为空');
      titleInput.focus();
      return;
    }
    // 地址全局唯一：改成别的书签已有的地址会让收藏夹出现重复项，
    // 且 findBookmarkByUrl / removeBookmarkByUrl 只会命中第一个，行为混乱。
    //
    // 注意：**不能**用「findBookmarkByUrl(root,u) !== node」来判断重复 ——
    // 那是对象引用比较。收藏夹里若已存在**同一个 URL 的多个条目**
    // （历史数据或导入产生），findBookmarkByUrl 返回的是第一个命中项，
    // 它可能不是当前正在编辑的 node，于是会把「编辑自己」误判成
    // 「地址被别的收藏占用」，导致保存被拒。
    // 正确做法：找出所有占用该地址的节点，看是否**存在不是 node 的那一个**。
    const root = getBookmarks();
    const others = [];
    (function collect(n) {
      for (const c of (n && n.children) || []) {
        if (c.type === 'bookmark') {
          if (c.url === u && c !== node) others.push(c);
        } else {
          collect(c);
        }
      }
    })(root);
    if (others.length) {
      toast('该地址已被其它收藏占用');
      urlInputEl.focus();
      return;
    }
    node.title = t;
    node.url = u;
    saveBookmarks(root);
    _bmEditing = null;
    renderBookmarks();
    renderBookmarksPopover();
    refreshBookmarkStar();
    toast('已保存');
  }

  save.addEventListener('click', (e) => {
    e.stopPropagation();
    commit();
  });
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    _bmEditing = null;
    renderBookmarksPopover();
  });

  // 回车保存，Esc 取消
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); _bmEditing = null; renderBookmarksPopover(); }
  });
  urlInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); _bmEditing = null; renderBookmarksPopover(); }
  });

  row.appendChild(titleInput);
  row.appendChild(urlInputEl);
  row.appendChild(save);
  row.appendChild(cancel);

  // 渲染后聚焦标题并全选，便于直接改写
  setTimeout(() => {
    titleInput.focus();
    titleInput.select();
  }, 0);

  return row;
}

/** 进入书签编辑态。 */
function bmStartEditBookmark(node) {
  _bmEditing = node;
  renderBookmarksPopover();
}

function renderBmHeader() {
  const url = urlInput.value;
  bmHeader.innerHTML = '';
  if (!url) {
    const info = document.createElement('div');
    info.className = 'bm-header-info';
    info.textContent = '当前没有可收藏的页面';
    bmHeader.appendChild(info);
    return;
  }
  const marked = window.BookmarksIO.findBookmarkByUrl(getBookmarks(), url);
  const info = document.createElement('div');
  info.className = 'bm-header-info';
  const t = activeTab();
  const titleEl = document.createElement('div');
  titleEl.className = 'bm-header-title';
  titleEl.textContent = (t && t.title) || url;
  const urlEl = document.createElement('div');
  urlEl.className = 'bm-header-url';
  urlEl.textContent = url;
  info.appendChild(titleEl);
  info.appendChild(urlEl);
  bmHeader.appendChild(info);

  const btn = document.createElement('button');
  if (marked) {
    btn.className = 'bm-header-btn';
    btn.textContent = '★ 取消收藏';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.BookmarksIO.removeBookmarkByUrl(getBookmarks(), url);
      saveBookmarks(getBookmarks());
      renderBookmarks();
      renderBookmarksPopover();
      refreshBookmarkStar();
    });
  } else {
    btn.className = 'bm-header-btn accent';
    btn.textContent = '⭐ 收藏到此文件夹';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bmAddCurrent();
    });
  }
  bmHeader.appendChild(btn);
}

/**
 * 文件夹新建/重命名的行内编辑行。
 * 不能再用 window.prompt：Electron 里它直接抛 "prompt() is and will not be supported"，
 * 输入框根本不会出现，用户完全无法新建或重命名文件夹。
 * 样式复用书签编辑行的 bm-edit-row / bm-edit-title / bm-edit-btn。
 */
function renderFolderEditRow() {
  const row = document.createElement('div');
  row.className = 'bm-row bm-edit-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bm-edit-title';
  input.maxLength = 80;
  input.placeholder = '文件夹名称';
  input.value = _bmFolderEdit.isNew ? '新建文件夹' : (_bmFolderEdit.node.title || '');

  const save = document.createElement('button');
  save.className = 'bm-edit-btn bm-edit-save';
  save.textContent = '保存';
  const cancel = document.createElement('button');
  cancel.className = 'bm-edit-btn';
  cancel.textContent = '取消';

  const commit = () => {
    if (!_bmFolderEdit) return;
    const name = input.value.trim() || '新建文件夹';
    if (_bmFolderEdit.isNew) {
      _bmFolderEdit.parent.children.push({ type: 'folder', title: name, children: [] });
    } else {
      _bmFolderEdit.node.title = name;
    }
    _bmFolderEdit = null;
    saveBookmarks(getBookmarks());
    renderBookmarks();
    renderBookmarksPopover();
    toast('已保存');
  };
  const abort = () => {
    _bmFolderEdit = null;
    renderBookmarksPopover();
  };

  save.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); abort(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); abort(); }
  });

  row.appendChild(input);
  row.appendChild(save);
  row.appendChild(cancel);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return row;
}

function bmAddFolder() {
  _bmFolderEdit = { node: null, parent: _bmCurrent, isNew: true };
  renderBookmarksPopover();
}

function bmRenameFolder(folder) {
  _bmFolderEdit = { node: folder, parent: _bmCurrent, isNew: false };
  renderBookmarksPopover();
}

function bmDeleteFolder(folder) {
  if (!window.confirm('删除文件夹「' + folder.title + '」及其全部内容？')) return;
  const parent = findParentFolder(getBookmarks(), folder);
  if (!parent) return; // 不允许删除根
  const idx = parent.children.indexOf(folder);
  if (idx >= 0) parent.children.splice(idx, 1);
  if (_bmCurrent === folder) _bmCurrent = parent;
  saveBookmarks(getBookmarks());
  renderBookmarks();
  renderBookmarksPopover();
}

function bmAddCurrent() {
  const url = urlInput.value;
  if (!url) {
    toast('当前没有可收藏的页面');
    closeBookmarksPopover();
    return;
  }
  const root = getBookmarks();
  if (window.BookmarksIO.findBookmarkByUrl(root, url)) {
    toast('该地址已在收藏夹中');
    closeBookmarksPopover();
    return;
  }
  const t = activeTab();
  // 目标文件夹：正常路径下 _bmCurrent 由 openBookmarksPopover() 赋值，
  // 但理论上可能为 null（弹层未打开时误调用），兜底退回根节点。
  const target = _bmCurrent || getBookmarks();
  // 先取目标文件夹标题：closeBookmarksPopover() 会把 _bmCurrent 置为 null，
  // 之后再取就拿不到了。
  const targetTitle = target.title || '全部书签';
  target.children.push({
    type: 'bookmark',
    title: (t && t.title) || url,
    url,
    // 站点图标：tab.favicon 由 page-favicon-updated 事件实时更新；
    // 页面还没来得及上报时按站点约定猜一个（/favicon.ico）。
    icon: (t && t.favicon) || guessFaviconUrl(url),
  });
  saveBookmarks(root);
  renderBookmarks();
  // 收藏完成后收起弹层：这是一次性操作，做完就没必要让浮层继续挡着页面。
  // 与 bmOpenBookmark() 的处理一致（那里也是操作完即 closeBookmarksPopover()）。
  // 注意顺序：先 renderBookmarks() 刷新收藏夹栏，再关闭弹层；
  // 不要在关闭后再调 renderBookmarksPopover()，那会把内容渲染进一个已隐藏的浮层里。
  closeBookmarksPopover();
  refreshBookmarkStar();
  toast('已收藏到「' + targetTitle + '」');
}

function bmOpenBookmark(node) {
  const wv = activeWebview();
  if (wv) wv.src = node.url;
  urlInput.value = node.url;
  closeBookmarksPopover();
}

function toggleBookmark() {
  const url = urlInput.value;
  if (!url) return;
  const root = getBookmarks();
  if (window.BookmarksIO.findBookmarkByUrl(root, url)) {
    // 已收藏 -> 一键取消
    window.BookmarksIO.removeBookmarkByUrl(root, url);
    saveBookmarks(root);
    renderBookmarks();
    refreshBookmarkStar();
    toast('已取消收藏');
  } else {
    // 未收藏 -> 打开弹出层，选文件夹后收藏
    openBookmarksPopover(root);
  }
}

function refreshBookmarkStar() {
  const url = urlInput.value;
  const marked = !!url && !!window.BookmarksIO.findBookmarkByUrl(getBookmarks(), url);
  // 两种状态：实心星（已收藏）/ 中空星（未收藏），并同步提示文字与可访问性标签
  setButtonIcon(bookmarkBtn, marked ? 'i-star-filled' : 'i-star');
  bookmarkBtn.title = marked ? '取消收藏' : '收藏当前页';
  bookmarkBtn.setAttribute('aria-label', marked ? '取消收藏' : '收藏当前页');
}

// 弹出层动作按钮（仅绑定一次）
if (bmNewFolderBtn) {
  bmNewFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bmAddFolder();
  });
}
if (bmAddCurrentBtn) {
  bmAddCurrentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bmAddCurrent();
  });
}
if (bmCloseBtn) {
  bmCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeBookmarksPopover();
  });
}
// 点击弹出层外部关闭。
// 用 mousedown 而非 click：弹出层是浮在页面之上的高层 UI，
// 等到 click（mouseup 之后）才消失的话，视觉上会「按下去浮层还在、松手才消失」。
//
// 注意：这里只覆盖**外壳区域**（工具栏/收藏夹栏/标签栏/面板）的点击。
// 网页内容区在独立的 guest 进程里，其点击不冒泡到外壳 document，
// 由 webview-preload 检测后经 mb-page-pointer-down 通道转发处理。
document.addEventListener('mousedown', (e) => {
  if (!bmPopover.classList.contains('hidden') && !bmPopover.contains(e.target)) {
    closeBookmarksPopover();
  }
});
// Esc 关闭弹出层
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bmPopover.classList.contains('hidden')) {
    closeBookmarksPopover();
  }
});


// ---------- 历史记录 ----------
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('mb_history') || '[]');
  } catch (_) {
    return [];
  }
}

function addHistory(url, title) {
  if (!/^https?:/i.test(url)) return;
  let h = getHistory().filter((x) => x.url !== url);
  h.unshift({ url, title: title || url, time: Date.now() });
  if (h.length > 200) h = h.slice(0, 200);
  localStorage.setItem('mb_history', JSON.stringify(h));
}

// did-navigate 早于 page-title-updated，写入时只能拿到上一个页面的标题。
// 标题到达后回填对应 URL 的历史条目，否则历史面板里全是「新标签页」或旧站名。
function updateHistoryTitle(url, title) {
  if (!title || !/^https?:/i.test(url)) return;
  try {
    const h = getHistory();
    const hit = h.find((x) => x.url === url);
    if (!hit || hit.title === title) return;
    hit.title = title;
    localStorage.setItem('mb_history', JSON.stringify(h));
  } catch (_) {
    /* ignore */
  }
}

function renderHistory() {
  const h = getHistory();
  historyListEl.innerHTML = '';
  if (!h.length) {
    historyListEl.innerHTML = '<li class="history-empty">暂无记录</li>';
    return;
  }
  h.forEach((it) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'h-title';
    t.textContent = it.title;
    const u = document.createElement('span');
    u.className = 'h-url';
    u.textContent = it.url;
    li.appendChild(t);
    li.appendChild(u);
    li.addEventListener('click', () => {
      const wv = activeWebview();
      if (wv) wv.src = it.url;
      urlInput.value = it.url;
      historyPanel.classList.add('hidden');
    });
    historyListEl.appendChild(li);
  });
}

historyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  renderHistory();
  showPanel(historyPanel);
});
historyClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  localStorage.removeItem('mb_history');
  renderHistory();
});
document.addEventListener('click', (e) => {
  if (
    !historyPanel.classList.contains('hidden') &&
    !historyPanel.contains(e.target) &&
    e.target !== historyBtn
  ) {
    historyPanel.classList.add('hidden');
  }
});

// ---------- 演示用：自动点击页面第一个导航链接 ----------
// 仅由主进程 --auto-demo 模式调用，用于验证「新标签打开链接」功能。
window.mbAutoDemoClick = function () {
  const wv = document.querySelector('webview.active') || document.querySelector('webview');
  if (!wv) return Promise.resolve('no-webview');
  const code =
    '(function(){' +
    "  var sels = ['#s-top-left a', '.s-top-left a', 'a[href*=\"news.baidu.com\"]', '#u > a', '.mnav'];" +
    '  for (var i=0;i<sels.length;i++){' +
    '    var a = document.querySelector(sels[i]);' +
    '    if (a && a.href){ a.click(); return "clicked:" + (a.textContent||a.href); }' +
    '  }' +
    "  var any = document.querySelector('a[href]');" +
    '  if (any){ any.click(); return "clicked:first-link"; }' +
    "  return 'wait';" +
    '})()';
  return wv.executeJavaScript(code);
};

// ---------- 页面内查找 (Ctrl/Cmd+F) ----------
// 依赖 webview 的 findInPage / stopFindInPage，匹配结果通过 found-in-page 事件回传。
let findText = '';

function stopFindOn(wv) {
  if (!wv) return;
  try {
    wv.stopFindInPage('clearSelection');
  } catch (_) {
    /* 页面未就绪等场景忽略 */
  }
}

function updateFindCount(matches, ordinal) {
  if (!findCountEl) return;
  if (!matches) {
    findCountEl.textContent = '无匹配';
    findCountEl.classList.add('empty');
  } else {
    findCountEl.textContent = ordinal + ' / ' + matches;
    findCountEl.classList.remove('empty');
  }
}

function openFindBar() {
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
  // 输入框里已有内容时，打开即重新高亮
  if (findInput.value) runFind(true);
}

function closeFindBar() {
  findBar.classList.add('hidden');
  stopFindOn(activeWebview());
  findText = '';
  if (findCountEl) {
    findCountEl.textContent = '';
    findCountEl.classList.remove('empty');
  }
}

/**
 * 执行一次查找。
 * @param {boolean} forward true=查找下一处，false=上一处
 */
function runFind(forward) {
  const wv = activeWebview();
  if (!wv) return;
  const text = findInput.value;
  if (!text) {
    stopFindOn(wv);
    findText = '';
    findCountEl.textContent = '';
    findCountEl.classList.remove('empty');
    return;
  }
  findText = text;
  try {
    // 注意（Electron 31.7.7 实测）：传 findNext:false 时**不会**触发 found-in-page 事件，
    // 会导致「首次搜索」和「无匹配」两种情况拿不到计数（计数停留在空值或上一次结果）。
    // 因此这里始终传 findNext:true —— 关键字变化时 Chromium 仍会开启新的查找会话
    // 并从首个匹配开始定位，行为符合预期。
    wv.findInPage(text, { forward: !!forward, findNext: true });
  } catch (_) {
    updateFindCount(0, 0);
  }
}

findInput.addEventListener('input', () => runFind(true));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runFind(!e.shiftKey); // Shift+Enter 上一处
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});
findNextBtn.addEventListener('click', () => runFind(true));
findPrevBtn.addEventListener('click', () => runFind(false));
findCloseBtn.addEventListener('click', closeFindBar);
findBtn.addEventListener('click', () => {
  if (findBar.classList.contains('hidden')) openFindBar();
  else closeFindBar();
});

// ---------- 页面视频下载 ----------
// 视频源由 webview-preload 探测并通过 mb-videos-updated / mb-video-context-menu 上报。
let lastPageVideos = []; // 最近一次上报的页面视频列表
let pendingVideoDownload = false; // 工具栏按钮触发后，待上报回来即下载

// 从一组源里挑「最适合下载」的那个：HLS 优先（能转封装为 MP4），其次 mp4，最后兜底
function pickVideoSource(sources) {
  if (!sources || !sources.length) return null;
  const hls = sources.find((s) => s.kind === 'hls');
  if (hls) return hls;
  const mp4 = sources.find((s) => s.kind === 'mp4');
  if (mp4) return mp4;
  return sources[0];
}

function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.classList.add('hidden');
  }, 2600);
}

// 发起一次视频下载请求（descriptor 至少含 url / kind）
function invokeDownloadVideo(source, title) {
  if (!source || !source.url) return;
  if (!window.electronAPI || !window.electronAPI.downloadVideo) return;
  const wv = activeWebview();
  const pageUrl = wv ? wv.src || '' : '';
  window.electronAPI
    .downloadVideo({
      url: source.url,
      kind: source.kind === 'hls' ? 'hls' : 'direct',
      title: title || 'video',
      referer: pageUrl,
      pageUrl: pageUrl,
      ua: WEBVIEW_UA
    })
    .catch(() => {});
  downloadsPanel.classList.remove('hidden'); // 展示下载进度
}

// 工具栏「下载页面视频」：先让 guest 上报当前页面视频源，再挑最佳源下载
function requestAndDownloadVideo() {
  const wv = activeWebview();
  if (!wv) return;
  pendingVideoDownload = true;
  try {
    wv.send('mb-request-videos');
  } catch (_) {
    /* ignore */
  }
  // 兜底：若 400ms 内没有任何上报，用已缓存的列表尝试
  setTimeout(() => {
    if (!pendingVideoDownload) return;
    pendingVideoDownload = false;
    if (lastPageVideos.length > 1) showVideoPicker(lastPageVideos);
    else downloadFromCachedVideos();
  }, 400);
}

function downloadFromCachedVideos() {
  const sources = lastPageVideos.reduce((acc, v) => acc.concat(v.sources || []), []);
  const chosen = pickVideoSource(sources);
  if (chosen) invokeDownloadVideo(chosen, lastPageVideos[0] && lastPageVideos[0].title);
  else toast('当前页面未检测到可下载的视频');
}

// 多视频时弹出选择面板，让用户挑选「下载哪一个视频 / 哪一个源」
let videoPickerEl = null;
let videoPickerList = null;

function ensureVideoPickerDom() {
  if (videoPickerEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'video-picker-overlay hidden';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeVideoPicker();
  });

  const modal = document.createElement('div');
  modal.className = 'video-picker';

  const head = document.createElement('div');
  head.className = 'vp-head';
  const title = document.createElement('div');
  title.className = 'vp-title';
  title.textContent = '选择要下载的视频';
  const close = document.createElement('button');
  close.className = 'vp-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeVideoPicker);
  head.appendChild(title);
  head.appendChild(close);

  const sub = document.createElement('div');
  sub.className = 'vp-sub';
  sub.id = 'vp-sub';

  const list = document.createElement('ul');
  list.className = 'vp-list';

  const foot = document.createElement('div');
  foot.className = 'vp-foot';
  const cancel = document.createElement('button');
  cancel.className = 'vp-cancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeVideoPicker);
  foot.appendChild(cancel);

  modal.appendChild(head);
  modal.appendChild(sub);
  modal.appendChild(list);
  modal.appendChild(foot);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoPickerEl && !videoPickerEl.classList.contains('hidden')) {
      closeVideoPicker();
    }
  });

  videoPickerEl = overlay;
  videoPickerList = list;
}

function closeVideoPicker() {
  if (videoPickerEl) videoPickerEl.classList.add('hidden');
}

function showVideoPicker(list) {
  ensureVideoPickerDom();
  videoPickerList.innerHTML = '';
  const sub = document.getElementById('vp-sub');
  if (sub) sub.textContent = '检测到 ' + list.length + ' 个视频，点击其中一个源开始下载';

  list.forEach((v, i) => {
    const sources = v.sources || [];
    if (!sources.length) return;
    const group = document.createElement('li');
    group.className = 'vp-group';
    group.textContent = '视频 ' + (i + 1);
    videoPickerList.appendChild(group);
    sources.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'vp-item';
      const label = document.createElement('span');
      label.className = 'vp-kind';
      label.textContent = s.kind === 'hls' ? 'HLS 流' : s.kind === 'mp4' ? 'MP4' : '视频';
      const host = document.createElement('span');
      host.className = 'vp-host';
      host.textContent = hostOf(s.url);
      li.appendChild(label);
      li.appendChild(host);
      li.addEventListener('click', () => {
        invokeDownloadVideo(s, v.title);
        closeVideoPicker();
      });
      videoPickerList.appendChild(li);
    });
  });

  videoPickerEl.classList.remove('hidden');
}

// 右键视频弹出的菜单
function showVideoContextMenu(payload, wv) {
  const sources = (payload && payload.sources) || [];
  const chosen = pickVideoSource(sources);
  contextMenuList.innerHTML = '';
  if (!chosen) {
    const li = document.createElement('li');
    li.className = 'disabled';
    li.textContent = '无可下载的视频源';
    contextMenuList.appendChild(li);
  } else {
    const main = document.createElement('li');
    // 文案统一以「下载」开头，并显式说明产物始终是 MP4（HLS 流会转封装为 MP4）
    main.textContent =
      '下载（' + (chosen.kind === 'hls' ? 'HLS 流 → MP4' : '保存为 MP4') + '）' +
      (payload && payload.playing ? ' · 正在播放' : '');
    main.addEventListener('click', () => {
      invokeDownloadVideo(chosen, payload.title);
      hideContextMenu();
    });
    contextMenuList.appendChild(main);
    // 多个源时逐个列出，便于选择清晰度/线路
    sources.forEach((s) => {
      if (s === chosen) return;
      const li = document.createElement('li');
      li.textContent = '下载：' + (s.kind === 'hls' ? 'HLS 流' : '视频') + ' · ' + hostOf(s.url);
      li.addEventListener('click', () => {
        invokeDownloadVideo(s, payload.title);
        hideContextMenu();
      });
      contextMenuList.appendChild(li);
    });
  }
  const rect = wv ? wv.getBoundingClientRect() : { left: 0, top: 0 };
  const x = rect.left + (payload.x || 0);
  const y = rect.top + (payload.y || 0);
  positionContextMenu(contextMenu, x, y);
}

// 保存页面（离线查看）：把当前活动 webview 的页面存为本地文件，断网可双击打开
function activeGuestId() {
  const wv = activeWebview();
  if (!wv) return 0;
  try {
    if (typeof wv.getWebContentsId === 'function') return wv.getWebContentsId();
    const wc = wv.getWebContents && wv.getWebContents();
    if (wc && wc.id) return wc.id;
  } catch (_) {
    /* ignore */
  }
  return 0;
}

function fileNameOf(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function showSavePageMenu(anchorEl) {
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  contextMenuList.innerHTML = '';

  function item(label, action) {
    const li = document.createElement('li');
    li.textContent = label;
    li.addEventListener('click', () => {
      try {
        action();
      } catch (_) {
        /* ignore */
      }
      hideContextMenu();
    });
    contextMenuList.appendChild(li);
  }

  item('完整网页（HTML + 资源，兼容性最佳）', () => doSavePage('HTMLComplete'));
  item('网页存档（.mhtml 单文件）', () => doSavePage('MHTML'));

  positionContextMenu(contextMenu, rect.left, rect.bottom + 4, {
    mode: 'below',
    anchorTop: rect.top,
  });
}

async function doSavePage(type) {
  const id = activeGuestId();
  if (!id) {
    toast('未能获取当前页面，无法保存');
    return;
  }
  if (savePageBtn) savePageBtn.disabled = true;
  try {
    if (!window.electronAPI || !window.electronAPI.savePage) {
      toast('保存功能不可用');
      return;
    }
    const res = await window.electronAPI.savePage(id, type);
    if (res && res.ok) {
      toast('已保存页面：' + fileNameOf(res.path) + '（断网可打开）');
    } else {
      toast('保存失败：' + ((res && res.error) || '未知错误'));
    }
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  } finally {
    if (savePageBtn) savePageBtn.disabled = false;
  }
}

// ---------- 下载管理 ----------
const downloadsMap = new Map(); // id -> 下载记录

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

function downloadStatusText(rec) {
  if (rec.kind === 'video') {
    if (rec.state === 'completed') return '已完成 · MP4';
    if (rec.state === 'cancelled') return '已取消';
    if (rec.state === 'interrupted') return rec.error ? '失败 · ' + rec.error : '已中断 · 可重试';
    if (rec.state === 'paused') return '已暂停 · ' + (rec.pct || 0) + '% · 可继续';
    if (rec.pct) return '下载中 ' + rec.pct + '%';
    if (rec.note) return rec.note + '…';
    return '准备中…';
  }
  if (rec.state === 'completed') return '已完成 · ' + formatBytes(rec.totalBytes || rec.receivedBytes);
  if (rec.state === 'cancelled') return '已取消';
  if (rec.state === 'interrupted') return '已中断 · 可重试';
  if (rec.paused) return '已暂停 · ' + rec.pct + '%';
  if (!rec.totalBytes) return formatBytes(rec.receivedBytes);
  return formatBytes(rec.receivedBytes) + ' / ' + formatBytes(rec.totalBytes) + ' · ' + rec.pct + '%';
}

function updateDlBadge() {
  if (!dlBadge) return;
  let active = 0;
  downloadsMap.forEach((r) => {
    if (!r.done) active += 1;
  });
  if (active > 0) {
    dlBadge.textContent = String(active);
    dlBadge.classList.remove('hidden');
  } else {
    dlBadge.classList.add('hidden');
  }
}

function addDlAction(container, rec, label, action) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    // 视频下载走独立通道（取消/打开/打开文件夹由主进程视频模块处理）
    const api =
      rec.kind === 'video' && window.electronAPI && window.electronAPI.videoDownloadAction
        ? window.electronAPI.videoDownloadAction
        : window.electronAPI && window.electronAPI.downloadAction;
    if (api) api(rec.id, action);
  });
  container.appendChild(b);
}

function renderDownloads() {
  if (!downloadsList) return;
  const list = Array.from(downloadsMap.values()).sort((a, b) => b.startedAt - a.startedAt);
  downloadsList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'dl-empty';
    li.textContent = '暂无下载';
    downloadsList.appendChild(li);
    updateDlBadge();
    return;
  }
  list.forEach((rec) => {
    const li = document.createElement('li');
    li.className =
      'dl-item' + (rec.done ? ' done' : '') + (rec.state === 'interrupted' ? ' interrupted' : '');

    const name = document.createElement('div');
    name.className = 'dl-name';
    name.textContent = rec.filename; // 用 textContent，避免文件名被当作 HTML 解析
    name.title = rec.savePath || rec.url || '';
    li.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'dl-meta';
    meta.textContent = downloadStatusText(rec);
    li.appendChild(meta);

    const bar = document.createElement('div');
    bar.className = 'dl-bar';
    const fill = document.createElement('i');
    fill.style.width = (rec.pct || 0) + '%';
    bar.appendChild(fill);
    li.appendChild(bar);

    const actions = document.createElement('div');
    actions.className = 'dl-actions';
    if (!rec.done) {
      // 视频下载由 ffmpeg 子进程执行：暂停 = 杀分段进程 + 记断点，恢复时用 -ss 续下
      // 并在末尾 concat 拼接（详见主进程 video-download.js），因此视频条目同样有
      // 暂停/继续；失败态的「重试」= 从最后一个分段断点继续，已下载部分不必重下。
      const isPaused = rec.state === 'paused' || rec.paused;
      addDlAction(actions, rec, isPaused ? '继续' : '暂停', isPaused ? 'resume' : 'pause');
      addDlAction(actions, rec, '取消', 'cancel');
    } else if (rec.state === 'completed') {
      addDlAction(actions, rec, '打开', 'open');
      addDlAction(actions, rec, '打开文件夹', 'folder');
    } else if (rec.state === 'interrupted') {
      // 视频重试 = 从最后一个分段的断点继续，已下载部分不必重下
      addDlAction(actions, rec, '重试', 'retry');
      addDlAction(actions, rec, '打开文件夹', 'folder');
    }
    li.appendChild(actions);

    downloadsList.appendChild(li);
  });
  updateDlBadge();
}

function applyDownloadEvent(payload) {
  if (!payload || !payload.id) return;
  if (payload.type === 'added') {
    downloadsMap.set(payload.id, {
      id: payload.id,
      filename: payload.filename,
      savePath: payload.savePath,
      url: payload.url,
      totalBytes: payload.totalBytes || 0,
      receivedBytes: 0,
      state: 'progressing',
      paused: false,
      done: false,
      pct: 0,
      kind: payload.kind || 'file',
      error: payload.error || '',
      note: '',
      startedAt: Date.now()
    });
  } else {
    const rec = downloadsMap.get(payload.id);
    if (!rec) return;
    if (payload.type === 'updated') {
      rec.state = payload.state || rec.state;
      rec.paused = !!payload.paused;
      // 失败/取消后主进程会先发 done（rec.done=true），用户点「重试」又发回
      // state:'progressing'。这里必须把 done 复位，否则按钮会一直停在「重试」上，
      // 看起来像卡住了。
      if (payload.state === 'progressing' || payload.state === 'paused') {
        rec.done = false;
        rec.error = '';
      }
      // 视频下载由主进程直接给百分比（HLS 无法预知总字节），优先用其上报值
      if (typeof payload.pct === 'number') {
        rec.pct = Math.max(0, Math.min(100, payload.pct));
        // note：主进程的阶段性说明（如「直接转封装失败，正在转码重试」），出现进度即清除
        rec.note = payload.note || '';
      } else {
        rec.receivedBytes = payload.receivedBytes || 0;
        if (payload.totalBytes) rec.totalBytes = payload.totalBytes;
        rec.pct = rec.totalBytes
          ? Math.min(100, Math.round((rec.receivedBytes / rec.totalBytes) * 100))
          : 0;
      }
    } else if (payload.type === 'done') {
      rec.state = payload.state;
      rec.done = true;
      if (payload.state === 'completed') rec.pct = 100;
    }
  }
  renderDownloads();
}

if (window.electronAPI && window.electronAPI.onDownloadEvent) {
  window.electronAPI.onDownloadEvent((payload) => {
    const isNew = payload && payload.type === 'added';
    applyDownloadEvent(payload);
    // 新下载开始时自动展开面板，让用户能看到进度
    if (isNew) downloadsPanel.classList.remove('hidden');
  });
}

downloadsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  showPanel(downloadsPanel);
});
downloadsClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  downloadsMap.forEach((rec, id) => {
    if (rec.done) downloadsMap.delete(id);
  });
  renderDownloads();
});
document.addEventListener('click', (e) => {
  if (
    !downloadsPanel.classList.contains('hidden') &&
    !downloadsPanel.contains(e.target) &&
    e.target !== downloadsBtn
  ) {
    downloadsPanel.classList.add('hidden');
  }
});
renderDownloads();

// ---------- 设置 ----------
// 全部保存在 localStorage('mb_settings')，读取时与默认值合并，避免旧数据缺字段。
// 主题取值：system = 跟随系统，light / dark = 强制
const THEME_MODES = ['system', 'light', 'dark'];
const DEFAULT_SETTINGS = {
  homeUrl: 'https://www.example.com',
  searchEngine: 'bing',
  restoreSession: true,
  openLinksInNewTab: true,
  theme: 'system',
  zoomLevels: {} // 站点域名 -> 缩放档位，实现「按站点记忆缩放」
};

const SEARCH_ENGINES = {
  bing: 'https://www.bing.com/search?q=',
  google: 'https://www.google.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd='
};

function getSettings() {
  try {
    const raw = localStorage.getItem('mb_settings');
    if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (_) {
    /* 数据损坏时回落默认值 */
  }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings() {
  try {
    localStorage.setItem('mb_settings', JSON.stringify(settings));
  } catch (_) {
    /* 忽略写入失败 */
  }
}

let settings = getSettings();

function homeUrl() {
  return settings.homeUrl || DEFAULT_SETTINGS.homeUrl;
}

function searchUrl() {
  return SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.bing;
}

// 主页地址补全协议，容错用户只输入域名
function normalizeHomeUrl(value) {
  const t = (value || '').trim();
  if (!t) return '';
  if (/^(https?:\/\/|about:|file:)/i.test(t)) return t;
  return 'https://' + t;
}

// ---------- 主题 ----------
// 深浅色由 <html data-theme> 驱动，具体配色全部在 styles.css 的变量表里。
// 「跟随系统」用 matchMedia 读取系统偏好，这样改动立即生效、无需经过主进程。
const systemDarkQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function themeMode() {
  return THEME_MODES.indexOf(settings.theme) >= 0 ? settings.theme : 'system';
}

function applyTheme() {
  const mode = themeMode();
  const dark = mode === 'dark' || (mode === 'system' && !!(systemDarkQuery && systemDarkQuery.matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (setThemeSel) setThemeSel.value = mode;
}

// 仅在「跟随系统」时响应系统主题变化；用户显式选了浅/深色则不跟随。
if (systemDarkQuery) {
  const onSystemThemeChange = () => {
    if (themeMode() === 'system') applyTheme();
  };
  if (systemDarkQuery.addEventListener) {
    systemDarkQuery.addEventListener('change', onSystemThemeChange);
  } else if (systemDarkQuery.addListener) {
    systemDarkQuery.addListener(onSystemThemeChange); // 旧版 Chromium 回退
  }
}

// 页面内链接的落地行为：按设置决定「新标签打开」还是「当前标签打开」。
// 注意：拦截始终由 webview-preload 完成，这里只负责决定落到哪里，
// 因此该开关不需要通知预加载脚本，改动即时生效。
function openUrlFromPage(url) {
  if (settings.openLinksInNewTab) {
    createTab(url);
    return;
  }
  const wv = activeWebview();
  if (wv) {
    wv.src = url;
    urlInput.value = url;
  }
}

// 三个浮层面板互斥：打开一个时收起其它
function showPanel(panel) {
  [historyPanel, downloadsPanel, settingsPanel].forEach((p) => {
    if (p !== panel) p.classList.add('hidden');
  });
  panel.classList.toggle('hidden');
}

// 网页内容区（guest 进程）左键点击时收起浮层面板。
// 外壳区域的点击由各面板自己的 document click 监听处理；
// <webview> 内的点击不冒泡到外壳，只能由 webview-preload 经
// mb-page-pointer-down 转发到这里。三个面板共用 showPanel 做互斥，
// 关闭行为也应一致（都只是加 hidden，不需要额外清理）。
function closePanelsOnOutsideClick() {
  [settingsPanel, historyPanel, downloadsPanel].forEach((p) => {
    if (p) p.classList.add('hidden');
  });
}

// 主进程设置的本地缓存：再次打开面板时先套用上次已知值，避免闪现错误的默认值
let mainSettingsCache = null;

function applyMainSettings(s) {
  if (!s) return;
  const dir = s.downloadDir || '';
  setDlDirLabel.textContent = dir || '默认（下载）';
  setDlDirLabel.title = dir || '系统默认「下载」目录';
  setAskSaveChk.checked = !!s.askWhereToSave;
}

// 下载目录 / 是否询问保存位置由主进程持久化，需异步拉取。
// 用递增序号丢弃迟到的旧响应：否则「打开面板 → 立刻改目录」时，
// 旧请求返回会把刚改好的标签覆盖成旧路径。
let mainSettingsSeq = 0;
async function loadMainSettings() {
  if (!window.electronAPI || !window.electronAPI.getMainSettings) return;
  if (mainSettingsCache) applyMainSettings(mainSettingsCache);
  else setDlDirLabel.textContent = '读取中…'; // 首次打开时不要显示可能错误的默认值
  const seq = ++mainSettingsSeq;
  try {
    const s = await window.electronAPI.getMainSettings();
    if (seq !== mainSettingsSeq) return;
    mainSettingsCache = s;
    applyMainSettings(s);
  } catch (_) {
    /* 读取失败时保留界面上的占位文案 */
  }
}

setDlChooseBtn.addEventListener('click', async () => {
  if (!window.electronAPI || !window.electronAPI.chooseDownloadDir) return;
  try {
    const dir = await window.electronAPI.chooseDownloadDir();
    if (dir) {
      // 只改 DOM 会让下次 openSettingsPanel 用旧缓存闪回旧路径。
      mainSettingsCache = { ...(mainSettingsCache || {}), downloadDir: dir };
      setDlDirLabel.textContent = dir || '默认（下载）';
      setDlDirLabel.title = dir || '系统默认「下载」目录';
    }
  } catch (_) {
    /* 用户取消或对话框不可用 */
  }
});

setAskSaveChk.addEventListener('change', () => {
  if (window.electronAPI && window.electronAPI.setMainSetting) {
    const value = setAskSaveChk.checked;
    const previous = mainSettingsCache ? mainSettingsCache.askWhereToSave : false;
    mainSettingsCache = { ...(mainSettingsCache || {}), askWhereToSave: value };
    Promise.resolve(window.electronAPI.setMainSetting('askWhereToSave', value))
      .catch(() => {
        // 写盘失败：复选框和缓存一起回滚，避免界面显示与实际设置不一致。
        setAskSaveChk.checked = !!previous;
        if (mainSettingsCache) mainSettingsCache.askWhereToSave = !!previous;
        toast('保存设置失败');
      });
  }
});

function openSettingsPanel() {
  applyTheme(); // 同步主题下拉框的显示值
  setHomeInput.value = settings.homeUrl;
  setEngineSel.value = SEARCH_ENGINES[settings.searchEngine] ? settings.searchEngine : 'bing';
  setRestoreChk.checked = !!settings.restoreSession;
  setNewTabChk.checked = !!settings.openLinksInNewTab;
  loadMainSettings(); // 下载目录等主进程设置
  showPanel(settingsPanel);
}

setThemeSel.addEventListener('change', () => {
  settings.theme = THEME_MODES.indexOf(setThemeSel.value) >= 0 ? setThemeSel.value : 'system';
  saveSettings();
  applyTheme();
});
setHomeInput.addEventListener('change', () => {
  settings.homeUrl = normalizeHomeUrl(setHomeInput.value) || DEFAULT_SETTINGS.homeUrl;
  setHomeInput.value = settings.homeUrl;
  saveSettings();
});
setEngineSel.addEventListener('change', () => {
  settings.searchEngine = SEARCH_ENGINES[setEngineSel.value] ? setEngineSel.value : 'bing';
  saveSettings();
});
setRestoreChk.addEventListener('change', () => {
  settings.restoreSession = setRestoreChk.checked;
  saveSettings();
});
setNewTabChk.addEventListener('change', () => {
  settings.openLinksInNewTab = setNewTabChk.checked;
  saveSettings();
});
setClearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem('mb_history');
  if (!historyPanel.classList.contains('hidden')) renderHistory();
});
setClearBookmarksBtn.addEventListener('click', () => {
  resetBookmarks();
  renderBookmarks();
  refreshBookmarkStar();
});
setClearAllBtn.addEventListener('click', () => {
  localStorage.removeItem('mb_history');
  resetBookmarks();
  localStorage.removeItem('mb_tabs');
  renderBookmarks();
  refreshBookmarkStar();
  if (!historyPanel.classList.contains('hidden')) renderHistory();
});
// 导入收藏夹：选 Netscape 书签 HTML，按文件夹结构合并去重后追加
setImportBookmarksBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (impFileInput) impFileInput.click();
});
if (impFileInput) {
  impFileInput.addEventListener('change', () => {
    const file = impFileInput.files && impFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsedRoot = window.BookmarksIO.parseNetscapeBookmarks(String(reader.result || ''));
      const flat = window.BookmarksIO.flattenBookmarks(parsedRoot);
      if (!flat.length) {
        toast('未从文件中解析到书签链接');
      } else {
        const added = mergeBookmarks(getBookmarks(), parsedRoot);
        saveBookmarks(getBookmarks());
        renderBookmarks();
        refreshBookmarkStar();
        const folders = window.BookmarksIO.countFolders(parsedRoot);
        toast(
          `已导入 ${added} 项（含 ${folders} 个文件夹，当前共 ` +
            window.BookmarksIO.flattenBookmarks(getBookmarks()).length +
            ' 个书签）'
        );
      }
      impFileInput.value = '';
    };
    reader.onerror = () => { toast('读取文件失败'); impFileInput.value = ''; };
    reader.readAsText(file, 'utf-8');
  });
}
// 导出收藏夹：交给主进程弹保存框并写出 Netscape 书签 HTML
setExportBookmarksBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.electronAPI.exportBookmarks(getBookmarks())
    .then((res) => {
      if (res && res.ok) toast('已导出收藏夹：' + res.path);
      else if (res && res.canceled) toast('已取消导出');
      else toast('导出失败：' + ((res && res.error) || '未知错误'));
    })
    .catch((err) => toast('导出失败：' + ((err && err.message) || err)));
});
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettingsPanel();
});
document.addEventListener('click', (e) => {
  if (
    !settingsPanel.classList.contains('hidden') &&
    !settingsPanel.contains(e.target) &&
    e.target !== settingsBtn
  ) {
    settingsPanel.classList.add('hidden');
  }
});

// ---------- 缩放 ----------
// Electron 的 setZoomLevel 以「档位」为单位，档位 n 约等于 1.2^n 倍。
const ZOOM_MIN = -5;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1;

function zoomPercent(level) {
  return Math.round(Math.pow(1.2, level || 0) * 100);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function updateZoomIndicator() {
  if (!zoomBtn) return;
  const t = activeTab();
  zoomBtn.textContent = zoomPercent(t ? t.zoomLevel || 0 : 0) + '%';
}

function applyZoomToTab(tab) {
  if (!tab || !tab.webview) return;
  try {
    tab.webview.setZoomLevel(tab.zoomLevel || 0);
  } catch (_) {
    /* 页面尚未就绪时忽略 */
  }
  if (tab.id === activeTabId) updateZoomIndicator();
}

// 把当前标签的缩放档位记到该站点名下
function rememberZoom(tab) {
  const host = hostOf(tab.url);
  if (!host) return;
  if (!settings.zoomLevels) settings.zoomLevels = {};
  if (tab.zoomLevel) settings.zoomLevels[host] = tab.zoomLevel;
  else delete settings.zoomLevels[host];
  saveSettings();
}

// 导航到新页面时，套用该站点记忆的缩放档位
function restoreZoomFor(tab) {
  const host = hostOf(tab.url);
  const saved = host && settings.zoomLevels ? settings.zoomLevels[host] : undefined;
  tab.zoomLevel = typeof saved === 'number' ? saved : 0;
  applyZoomToTab(tab);
}

function changeZoom(delta) {
  const t = activeTab();
  if (!t) return;
  const cur = t.zoomLevel || 0;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cur + delta));
  if (next === cur) return;
  t.zoomLevel = next;
  applyZoomToTab(t);
  rememberZoom(t);
}

function resetZoom() {
  const t = activeTab();
  if (!t) return;
  t.zoomLevel = 0;
  applyZoomToTab(t);
  rememberZoom(t);
}

/**
 * 缩放档位与百分比的换算。
 *
 * Electron 的 setZoomLevel(level) 里 level=0 表示 100%，实际倍数是 1.2^level。
 * 现有实现一直用**整数**档位（Ctrl/Cmd + 加减号按 ±1 档走），
 * 但整数档位只能落在 58% / 69% / 83% / 100% / 120% / 144% / 173% … 上，
 * 这些数字不直观，做不出 Chrome 那样「50% / 75% / 125% / 150%」的菜单。
 *
 * 因此这里允许 level 取**浮点**：菜单给百分比，用 log 反算 level 即可精确命中。
 * 数据模型没变（存的仍是 level），所以历史设置里已保存的 0 / 1 / 2 等旧值
 * 依然表示 100% / 120% / 144%，**无需任何兼容处理**。
 */
const ZOOM_PERCENT_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

/** 百分比 → Electron 的 zoom level */
function levelForPercent(pct) {
  return Math.log(pct / 100) / Math.log(1.2);
}

/** 当前的缩放百分比（取整显示用） */
function currentZoomPercent(tab) {
  const t = tab || activeTab();
  return zoomPercent(t ? t.zoomLevel || 0 : 0);
}

/** 按百分比设置缩放。 */
function setZoomPercent(pct) {
  const t = activeTab();
  if (!t) return;
  t.zoomLevel = levelForPercent(pct);
  applyZoomToTab(t);
  rememberZoom(t);
}

/** 隐藏缩放菜单。 */
function hideZoomMenu() {
  if (zoomMenu) zoomMenu.classList.add('hidden');
}

/**
 * 显示缩放菜单（点缩放按钮）。
 *
 * 【为什么要菜单而不是「点击直接重置」】
 * 原实现是点一下就重置到 100%。但按钮上显示的是百分比，
 * 用户的直觉是「点这里选缩放比例」（Chrome / Edge 都是这样），
 * 结果点下去毫无变化 —— 页面本来就是 100% 时尤其明显，
 * 表现为「这个按钮无效」。
 */
function showZoomMenu() {
  if (!zoomMenu || !zoomMenuList) return;
  const t = activeTab();
  if (!t) return;
  zoomMenuList.innerHTML = '';

  const cur = currentZoomPercent(t);

  function item(label, pct, action) {
    const li = document.createElement('li');
    li.textContent = label;
    // 当前档位高亮（容差 1%，吸收取整误差）
    if (pct != null && Math.abs(pct - cur) <= 1) li.classList.add('active');
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        action();
      } catch (_) {
        /* ignore */
      }
      hideZoomMenu();
    });
    zoomMenuList.appendChild(li);
  }

  function divider() {
    const li = document.createElement('li');
    li.className = 'divider';
    zoomMenuList.appendChild(li);
  }

  ZOOM_PERCENT_PRESETS.forEach((pct) => {
    item(pct + '%', pct, () => setZoomPercent(pct));
  });
  divider();
  item('恢复默认', 100, resetZoom);

  // 定位到按钮下方；靠近屏幕底部时改为向上弹
  zoomMenu.classList.remove('hidden');
  const r = zoomBtn.getBoundingClientRect();
  const mh = zoomMenu.offsetHeight;
  const below = r.bottom + mh + 6 <= window.innerHeight;
  zoomMenu.style.left = Math.round(r.left) + 'px';
  zoomMenu.style.top = below
    ? Math.round(r.bottom + 4) + 'px'
    : Math.round(r.top - mh - 4) + 'px';
}

/** 缩放按钮：点击开菜单；再次点击（菜单已开）则收起。 */
zoomBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (zoomMenu && !zoomMenu.classList.contains('hidden')) {
    hideZoomMenu();
    return;
  }
  showZoomMenu();
});

// ---------- 钉在桌面（窗口置顶） ----------
// 当前是否已置顶。渲染层自己记一份，右键菜单文案要用；
// 真实状态以主进程为准（setPinned 的返回值 / always-on-top-changed 通知）。
let _windowPinned = false;

/** 窗口当前是否处于置顶状态。 */
function isWindowPinned() {
  return _windowPinned;
}

/**
 * 更新图钉按钮的激活态。
 * @param {boolean} on 是否已置顶
 */
function updatePinButton(on) {
  _windowPinned = !!on;
  if (!pinBtn) return;
  pinBtn.setAttribute('aria-pressed', _windowPinned ? 'true' : 'false');
  pinBtn.title = _windowPinned
    ? '取消钉住：窗口不再始终位于最前方'
    : '钉在桌面：窗口始终保持在最前方（再次点击取消）';
}

/**
 * 设置/切换窗口置顶。
 *
 * 语义与 QQ 截图的「钉在桌面」一致：**置顶但不抢焦点** ——
 * 点下之后窗口保持在最前，用户仍然可以操作下面的窗口。
 * （Electron 的 setAlwaysOnTop 文档：regardless of whether it's focused or not。）
 *
 * @param {boolean} [on] 指定状态；省略表示切换
 */
async function setPinned(on) {
  if (!window.electronAPI || !window.electronAPI.setPinned) return;
  let next;
  try {
    next = await window.electronAPI.setPinned(on);
  } catch (_) {
    return;
  }
  const pinned = !!next;
  updatePinButton(pinned);
  // 持久化：下次启动仍保持钉住（与透明模式一样存 localStorage）
  try {
    localStorage.setItem('mb_pinned', pinned ? '1' : '0');
  } catch (_) {
    /* 隐私模式等 localStorage 不可用时忽略 */
  }
}

if (pinBtn) {
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPinned();
  });
}

// 主进程通知置顶状态变化（用户可能从系统窗口菜单改过）
if (window.electronAPI && window.electronAPI.onPinnedChanged) {
  window.electronAPI.onPinnedChanged((on) => {
    updatePinButton(on);
    try {
      localStorage.setItem('mb_pinned', on ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
  });
}

// 恢复上次的钉住状态
try {
  if (localStorage.getItem('mb_pinned') === '1') setPinned(true);
} catch (_) {
  /* ignore */
}

// ---------- 去粗体 ----------
/**
 * 更新去粗体按钮的激活态（反映当前标签页的状态）。
 */
function updateDeboldButton() {
  if (!deboldBtn) return;
  const t = activeTab();
  const on = !!(t && t.debold);
  deboldBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/**
 * 切换当前标签页的「去粗体」。
 *
 * 状态挂在 tab 对象上，因此切标签时各自的开关互不影响；
 * 页面导航后 insertCSS 的样式会被清除，需要在 did-navigate 里重新注入。
 */
function toggleDebold() {
  const t = activeTab();
  if (!t || !t.webview) return;
  t.debold = !t.debold;
  applyPageDebold(t.webview, t.debold);
  updateDeboldButton();
  toast(t.debold ? '已去除粗体' : '已恢复粗体');
}

if (deboldBtn) {
  deboldBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDebold();
  });
}

// ---------- 初始化 ----------
applyTheme(); // index.html 的引导脚本已抢先套用一次，这里补齐下拉框等 UI 状态
renderBookmarks();

// 恢复上次的无框模式状态（隐藏工具栏/收藏夹/标签栏，仅留网页内容）
try {
  if (localStorage.getItem('mb_frameless') === '1') applyFrameless(true);
} catch (_) {
  /* 隐私模式下 localStorage 不可用时忽略 */
}

// 恢复上次的无框模式2 状态（无框 + 四角直角标识）。
// 必须走 enterFrameless2() 而非 applyFrameless2(true)：前者会先把模式1 关掉，
// 保证两种模式互斥（若直接调 applyFrameless2，两个 class 会同时挂上，
// 直角标识可能被模式1 的样式影响而显示异常）。
try {
  if (localStorage.getItem('mb_frameless2') === '1') enterFrameless2();
} catch (_) {
  /* ignore */
}

// 恢复上次的透明档位（普通透明 / 完全透明）。
// 必须一次性恢复，不能分两步「先恢复普通透明、再恢复完全透明」：
// 分两步的话，前一步会把 mb_full_transparent 覆写成 '0'，
// 后一步就读不到「上次停在完全透明」这个信息了。
try {
  if (localStorage.getItem('mb_full_transparent') === '1') {
    // keepAuto=true：沿用持久化的「普通透明是否为进入完全透明而自动打开」标记。
    // 若在这里重新判定，透明类已经先恢复，标记会被误判成 0，重启后退出就要点两次。
    setTransparentLevel(2, { keepAuto: true });
  } else if (localStorage.getItem('mb_transparent') === '1') {
    setTransparentLevel(1);
  }
} catch (_) {
  /* ignore */
}

// 主进程拦截到的弹窗（页面 window.open() / target="_blank"）→ 在新标签打开
// 补齐 webview-preload 在 contextIsolation 下无法拦截 window.open 的缺口
if (window.electronAPI && window.electronAPI.onOpenInTab) {
  window.electronAPI.onOpenInTab((url) => {
    if (url && /^https?:/i.test(url)) createTab(url);
  });
}

const launchUrl =
  window.electronAPI && window.electronAPI.getLaunchUrl && /^https?:/i.test(window.electronAPI.getLaunchUrl())
    ? window.electronAPI.getLaunchUrl()
    : homeUrl();

// 设置里关闭「启动时恢复上次会话」时，不读取上次的标签
const restored = settings.restoreSession ? restoreTabs() : false;
if (!restored) {
  createTab(launchUrl);
}

// 快捷键：Ctrl/Cmd+Shift+T 重新打开最近关闭的标签
// Ctrl/Cmd+T 新建标签；Ctrl/Cmd+W 关闭当前标签；Ctrl/Cmd+F 页面内查找
// Ctrl/Cmd + 「+」/「-」/「0」：放大 / 缩小 / 重置缩放
//
// <webview> 是独立 guest 进程，网页聚焦时宿主 document 收不到 keydown；
// webview-preload 把上述组合键经 mb-shortcut 转发过来，统一调用本函数。
// 宿主与 guest 共用一份逻辑，避免两边行为漂移。
function handleAppShortcut(ctrl, shift, rawKey) {
  if (!ctrl) return false;
  const key = String(rawKey || '').toLowerCase();
  if (shift && key === 't') {
    if (closedTabs.length) {
      const last = closedTabs.pop();
      createTab(last.url);
    }
  } else if (!shift && key === 't') {
    createTab(homeUrl());
  } else if (!shift && key === 'w') {
    if (activeTabId) closeTab(activeTabId);
  } else if (!shift && key === 'f') {
    if (findBar.classList.contains('hidden')) openFindBar();
    else closeFindBar();
  } else if (key === '=' || key === '+') {
    changeZoom(ZOOM_STEP); // Ctrl/Cmd + 加号：放大
  } else if (key === '-' || key === '_') {
    changeZoom(-ZOOM_STEP); // Ctrl/Cmd + 减号：缩小
  } else if (!shift && key === '0') {
    resetZoom(); // Ctrl/Cmd + 0：重置
  } else {
    return false;
  }
  return true;
}

document.addEventListener('keydown', (e) => {
  if (handleAppShortcut(e.ctrlKey || e.metaKey, e.shiftKey, e.key)) e.preventDefault();
});

// Esc：仅在无框模式（含模式2）下退出（普通浏览的 Esc 仍用于关闭查找条等，不受影响）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 缩放菜单开着时，Esc 先关菜单 —— 菜单是当前最上层的浮层，
  // 不该被无框模式的退出抢走。
  if (zoomMenu && !zoomMenu.classList.contains('hidden')) {
    e.preventDefault();
    hideZoomMenu();
    return;
  }
  if (isFrameless2()) exitFrameless2();
  else if (document.body.classList.contains('frameless')) applyFrameless(false);
});

// ---------- Alt + 左键拖动移动窗口 ----------
// 无边框窗口（frame:false）没有系统标题栏，正常情况下只能靠 CSS 的
// -webkit-app-region: drag 区域来拖动。但那只覆盖工具栏/标签栏等固定区域，
// 无法做到「在窗口任意位置按住 Alt 再左键拖动」。这里补上这个能力：
// 按下时通知主进程开始跟随鼠标，松开时结束，中间由主进程自行轮询屏幕坐标。
//
// 说明：网页内容区（<webview>）是独立 guest 渲染进程，鼠标事件不冒泡到本 document，
// 那一侧的 Alt 检测由 webview-preload.js 注入并经 mb-window-drag 通道转发过来
// （见下方 ipc-message 分支）。
(function setupAltDragToMove() {
  if (!window.electronAPI || !window.electronAPI.windowDragStart) return;

  // 与 guest 侧一致：移动超过阈值才认定为拖动。
  // 否则「Alt+左键点按钮」这种正常操作会被误判成拖动，把按钮点击吃掉。
  const DRAG_THRESHOLD = 4; // px

  let pending = null; // { x, y } 已按下 Alt+左键但尚未越过阈值
  let dragging = false; // 已认定拖动并已通知主进程

  function notifyStart(x, y) {
    dragging = true;
    window.electronAPI.windowDragStart(x, y);
  }

  function end() {
    pending = null;
    if (!dragging) return;
    dragging = false;
    window.electronAPI.windowDragEnd();
  }

  // 用捕获阶段监听：页面里任何停止冒泡的处理器都不影响窗口拖动。
  window.addEventListener(
    'mousedown',
    (e) => {
      // 只认「Alt + 左键」
      if (e.button !== 0 || !e.altKey) return;
      if (dragging) return;
      // 文本输入控件内不触发：Alt+左键在输入框/文本域里可能被用于选择单词等原生操作，
      // 抢走会破坏正常编辑体验。
      const t = e.target;
      if (t) {
        const tag = (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || t.isContentEditable) return;
      }
      pending = { x: e.clientX, y: e.clientY };
    },
    true
  );

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!pending || dragging) return;
      const dx = e.clientX - pending.x;
      const dy = e.clientY - pending.y;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      // 越过阈值 → 认定为拖动窗口，拦下本次点击的默认行为
      const start = pending;
      pending = null;
      notifyStart(start.x, start.y);
      if (e.preventDefault) e.preventDefault();
    },
    true
  );

  // 松开左键结束。注意用 window 而不是 document：
  // 拖动过程中鼠标可能已移出文档范围，绑在 document 上有时收不到 mouseup。
  window.addEventListener('mouseup', end, true);
  window.addEventListener('blur', end);

  // Alt 被提前松开（用户只松开 Alt 却还按着左键）时也要结束，
  // 否则窗口会一直黏着鼠标跑。
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Alt') end();
    },
    true
  );

  // 供 webview-preload 转发的 Alt 拖动请求复用同一套开始/结束逻辑
  window.__mbAltDrag = {
    begin(x, y) {
      if (dragging) return;
      pending = null;
      notifyStart(x, y);
    },
    end
  };
})();
