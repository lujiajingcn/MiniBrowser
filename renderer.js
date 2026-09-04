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
const toastEl = document.getElementById('toast');

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
function normalizeUrl(input) {
  const url = (input || '').trim();
  if (!url) return '';
  if (/^(https?:\/\/|about:|file:|data:|mailto:)/i.test(url)) return url;
  if (url.includes('.') || url.includes(':') || url.includes('/')) return 'https://' + url;
  return searchUrl() + encodeURIComponent(url);
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
  lockEl.textContent = secure ? '🔒' : '🔓';
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
  // 切换标签时清掉该页面残留的查找高亮（查找条处于关闭状态时）
  if (findBar.classList.contains('hidden')) stopFindOn(t.webview);
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
      activeTabId
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
    data.tabs.forEach((t) => createTab(t.url, false));
    if (data.activeTabId) setActiveTab(data.activeTabId);
    return true;
  } catch (_) {
    return false;
  }
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
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

  const maxX = Math.max(0, window.innerWidth - 180);
  const maxY = Math.max(0, window.innerHeight - 120);
  contextMenu.style.left = Math.min(x, maxX) + 'px';
  contextMenu.style.top = Math.min(y, maxY) + 'px';
  contextMenu.classList.remove('hidden');
}

document.addEventListener('click', (e) => {
  if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

function wireWebview(tab) {
  const wv = tab.webview;

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    if (tab.id === activeTabId) {
      loadingBar.classList.add('active');
      reloadBtn.textContent = '✕';
    }
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    if (tab.id === activeTabId) {
      loadingBar.classList.remove('active');
      reloadBtn.textContent = '⟳';
    }
  });
  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    restoreZoomFor(tab); // 套用该站点记忆的缩放
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
    updateFindCount(r.matches, r.activeMatchOrdinal);
  });
  wv.addEventListener('new-window', (e) => {
    e.preventDefault();
    if (/^(https?:|about:|file:)/i.test(e.url)) openUrlFromPage(e.url);
    else if (window.electronAPI) window.electronAPI.openExternal(e.url);
  });
  // 接收 webview-preload.js 通过 sendToHost 转发的新窗口请求 / 右键菜单
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'mb-new-window') {
      const payload = e.args && e.args[0] ? e.args[0] : {};
      const url = payload.url;
      if (!url) return;
      if (/^(https?:|about:|file:)/i.test(url)) openUrlFromPage(url);
      else if (window.electronAPI) window.electronAPI.openExternal(url);
      return;
    }
    if (e.channel === 'mb-find') {
      // 页面内按 Ctrl/Cmd+F 或 Esc，由 webview-preload 转发过来
      const payload = e.args && e.args[0] ? e.args[0] : {};
      if (payload.action === 'close') closeFindBar();
      else openFindBar();
      return;
    }
    if (e.channel === 'mb-context-menu') {
      const payload = e.args && e.args[0] ? e.args[0] : {};
      const link = payload.link;
      if (!link || !link.url) return;
      const rect = wv.getBoundingClientRect();
      const x = rect.left + (payload.x || 0);
      const y = rect.top + (payload.y || 0);
      showContextMenu(x, y, link.url);
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
      if (window.electronAPI) window.electronAPI.openExternal(u);
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
bookmarkBtn.addEventListener('click', toggleBookmark);
devtoolsBtn.addEventListener('click', () => {
  const wv = activeWebview();
  if (wv) wv.openDevTools();
});
videoDlBtn.addEventListener('click', () => {
  requestAndDownloadVideo();
});

function navigate(input) {
  const wv = activeWebview();
  if (!wv) return;
  const url = normalizeUrl(input);
  if (!url) return;
  wv.src = url;
  urlInput.blur();
}

// ---------- 收藏夹 ----------
function getBookmarks() {
  try {
    const raw = localStorage.getItem('mb_bookmarks');
    if (raw) return JSON.parse(raw);
  } catch (_) {
    /* ignore */
  }
  return DEFAULT_BOOKMARKS.slice();
}

function saveBookmarks(list) {
  localStorage.setItem('mb_bookmarks', JSON.stringify(list));
}

function renderBookmarks() {
  const list = getBookmarks();
  bookmarksBar.innerHTML = '';
  list.forEach((bm) => {
    const item = document.createElement('button');
    item.className = 'bookmark';
    item.title = bm.url;

    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = bm.title;
    label.addEventListener('click', () => {
      const wv = activeWebview();
      if (wv) wv.src = bm.url;
      urlInput.value = bm.url;
    });
    item.appendChild(label);

    const del = document.createElement('span');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = '删除收藏';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      saveBookmarks(getBookmarks().filter((x) => x.url !== bm.url));
      renderBookmarks();
    });
    item.appendChild(del);

    bookmarksBar.appendChild(item);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'bookmark add';
  addBtn.textContent = '+';
  addBtn.title = '收藏当前页';
  addBtn.addEventListener('click', addCurrentBookmark);
  bookmarksBar.appendChild(addBtn);
}

function addCurrentBookmark() {
  const url = urlInput.value;
  if (!url) return;
  const list = getBookmarks();
  if (list.some((x) => x.url === url)) return;
  const t = activeTab();
  list.push({ title: (t && t.title) || url, url });
  saveBookmarks(list);
  renderBookmarks();
  refreshBookmarkStar();
}

function toggleBookmark() {
  const url = urlInput.value;
  if (!url) return;
  const list = getBookmarks();
  const idx = list.findIndex((x) => x.url === url);
  if (idx >= 0) {
    list.splice(idx, 1);
    bookmarkBtn.textContent = '☆';
  } else {
    const t = activeTab();
    list.push({ title: (t && t.title) || url, url });
    bookmarkBtn.textContent = '★';
  }
  saveBookmarks(list);
  renderBookmarks();
}

function refreshBookmarkStar() {
  const url = urlInput.value;
  const list = getBookmarks();
  bookmarkBtn.textContent = list.some((x) => x.url === url) ? '★' : '☆';
}

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
    main.textContent = '下载视频（' + (chosen.kind === 'hls' ? 'HLS 流' : '视频文件') + '）';
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
  const maxX = Math.max(0, window.innerWidth - 180);
  const maxY = Math.max(0, window.innerHeight - 120);
  contextMenu.style.left = Math.min(x, maxX) + 'px';
  contextMenu.style.top = Math.min(y, maxY) + 'px';
  contextMenu.classList.remove('hidden');
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
    if (rec.state === 'interrupted') return rec.error ? '失败 · ' + rec.error : '已中断';
    if (rec.pct) return '下载中 ' + rec.pct + '%';
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
      // 视频下载由 ffmpeg 子进程执行，无法暂停/继续（主进程也未实现），只提供取消
      if (rec.kind === 'video') {
        addDlAction(actions, rec, '取消', 'cancel');
      } else {
        addDlAction(actions, rec, rec.paused ? '继续' : '暂停', rec.paused ? 'resume' : 'pause');
        addDlAction(actions, rec, '取消', 'cancel');
      }
    } else if (rec.state === 'completed') {
      addDlAction(actions, rec, '打开', 'open');
      addDlAction(actions, rec, '打开文件夹', 'folder');
    } else if (rec.state === 'interrupted') {
      // 视频下载主进程未实现「重试」，仅提供「打开文件夹」定位失败产物；文件下载保留重试
      if (rec.kind !== 'video') addDlAction(actions, rec, '重试', 'retry');
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
      startedAt: Date.now()
    });
  } else {
    const rec = downloadsMap.get(payload.id);
    if (!rec) return;
    if (payload.type === 'updated') {
      rec.state = payload.state || rec.state;
      rec.paused = !!payload.paused;
      // 视频下载由主进程直接给百分比（HLS 无法预知总字节），优先用其上报值
      if (typeof payload.pct === 'number') {
        rec.pct = Math.max(0, Math.min(100, payload.pct));
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

// 主进程设置的本地缓存：再次打开面板时先套用上次已知值，避免闪现错误的默认值
let mainSettingsCache = null;

function applyMainSettings(s) {
  if (!s) return;
  const dir = s.downloadDir || '';
  setDlDirLabel.textContent = dir || '默认（下载）';
  setDlDirLabel.title = dir || '系统默认「下载」目录';
  setAskSaveChk.checked = !!s.askWhereToSave;
}

// 下载目录 / 是否询问保存位置由主进程持久化，需异步拉取
async function loadMainSettings() {
  if (!window.electronAPI || !window.electronAPI.getMainSettings) return;
  if (mainSettingsCache) applyMainSettings(mainSettingsCache);
  else setDlDirLabel.textContent = '读取中…'; // 首次打开时不要显示可能错误的默认值
  try {
    const s = await window.electronAPI.getMainSettings();
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
      setDlDirLabel.textContent = dir;
      setDlDirLabel.title = dir;
    }
  } catch (_) {
    /* 用户取消或对话框不可用 */
  }
});

setAskSaveChk.addEventListener('change', () => {
  if (window.electronAPI && window.electronAPI.setMainSetting) {
    window.electronAPI.setMainSetting('askWhereToSave', setAskSaveChk.checked);
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
  localStorage.removeItem('mb_bookmarks');
  renderBookmarks();
  refreshBookmarkStar();
});
setClearAllBtn.addEventListener('click', () => {
  localStorage.removeItem('mb_history');
  localStorage.removeItem('mb_bookmarks');
  localStorage.removeItem('mb_tabs');
  renderBookmarks();
  refreshBookmarkStar();
  if (!historyPanel.classList.contains('hidden')) renderHistory();
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

zoomBtn.addEventListener('click', resetZoom);

// ---------- 初始化 ----------
applyTheme(); // index.html 的引导脚本已抢先套用一次，这里补齐下拉框等 UI 状态
renderBookmarks();

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
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    if (closedTabs.length) {
      const last = closedTabs.pop();
      createTab(last.url);
    }
  } else if (!e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    createTab(homeUrl());
  } else if (!e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  } else if (!e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (findBar.classList.contains('hidden')) openFindBar();
    else closeFindBar();
  } else if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    changeZoom(ZOOM_STEP); // Ctrl/Cmd + 加号：放大
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    changeZoom(-ZOOM_STEP); // Ctrl/Cmd + 减号：缩小
  } else if (!e.shiftKey && e.key === '0') {
    e.preventDefault();
    resetZoom(); // Ctrl/Cmd + 0：重置
  }
});
