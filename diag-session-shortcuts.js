'use strict';

/**
 * 会话恢复与快捷键修复验证。
 *
 * A. ID 空洞会话恢复：关掉中间标签后保存的 activeTabId 与重建后的 ID 不对齐，
 *    修复后应按下标恢复，且有且只有一个活动标签。
 * B. 快捷键统一处理函数：Ctrl+T / Ctrl+W / Ctrl+Shift+T 走同一逻辑。
 * C. guest 转发的 mb-shortcut 通道能触发同一处理函数。
 *
 * 使用独立 userData，避免与真实 profile 或其他诊断脚本互相污染。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'minibrowser-diag-session-' + process.pid));

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    show: false, width: 1100, height: 750,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2000);

  // ---- A：制造 ID 空洞后重启 ----
  const prep = JSON.parse(await wc.executeJavaScript(`
    (() => {
      if (!tabs.length) createTab('about:blank');
      while (tabs.length > 1) closeTab(tabs[tabs.length - 1].id);
      createTab('https://example.com/a', false);
      createTab('https://example.com/b', false);
      createTab('https://example.com/c', false);
      closeTab(tabs[1].id); // 中间标签 → ID 出现空洞
      setActiveTab(tabs[tabs.length - 1].id);
      const saved = JSON.parse(localStorage.getItem('mb_tabs') || 'null');
      return JSON.stringify({
        ids: tabs.map(t => t.id), active: activeTabId,
        savedActiveId: saved && saved.activeTabId,
        savedIndex: saved && saved.activeIndex,
        savedCount: saved && saved.tabs.length
      });
    })();
  `));
  log.push(['A 保存前', JSON.stringify(prep)]);
  exp(typeof prep.savedIndex === 'number', 'A：mb_tabs 应保存 activeIndex');
  exp(prep.savedActiveId > prep.savedCount, 'A：前置条件，旧 activeTabId 应大于标签数（ID 空洞）');

  await wc.reload();
  await wait(2200);
  const restored = JSON.parse(await wc.executeJavaScript(`
    (() => JSON.stringify({
      count: tabs.length,
      ids: tabs.map(t => t.id),
      active: activeTabId,
      webviewActive: document.querySelectorAll('webview.active').length,
      tabActive: document.querySelectorAll('.tab.active').length,
      url: urlInput.value
    }))();
  `));
  log.push(['A 恢复后', JSON.stringify(restored)]);
  exp(restored.count === prep.savedCount, 'A：恢复后的标签数应与保存时一致');
  exp(restored.webviewActive === 1 && restored.tabActive === 1,
    'A：应有且只有一个活动标签，实际 webview=' + restored.webviewActive + ' tab=' + restored.tabActive);
  exp(restored.ids.includes(restored.active), 'A：activeTabId 应指向存在的标签');
  exp(/example\.com/.test(restored.url), 'A：地址栏应显示恢复的活动页 URL，实际 ' + restored.url);

  // ---- B：统一快捷键处理函数 ----
  const shortcut = JSON.parse(await wc.executeJavaScript(`
    (() => {
      const before = tabs.length;
      handleAppShortcut(true, false, 't');
      const afterNew = tabs.length;
      // 首页标签按设计不进「最近关闭」列表，换一个非首页标签来验证 Ctrl+Shift+T。
      createTab('https://example.com/shortcut', true);
      const beforeClose = tabs.length;
      handleAppShortcut(true, false, 'w');
      const afterClose = tabs.length;
      const beforeReopen = tabs.length;
      handleAppShortcut(true, true, 't');
      return JSON.stringify({ before, afterNew, beforeClose, afterClose, beforeReopen,
        afterReopen: tabs.length });
    })();
  `));
  log.push(['B 快捷键', JSON.stringify(shortcut)]);
  exp(shortcut.afterNew === shortcut.before + 1, 'B：Ctrl+T 应新建一个标签');
  exp(shortcut.afterClose === shortcut.beforeClose - 1, 'B：Ctrl+W 应关闭当前标签');
  exp(shortcut.afterReopen === shortcut.beforeReopen + 1, 'B：Ctrl+Shift+T 应恢复最近关闭的标签');

  // ---- C：guest 转发的 mb-shortcut 通道 ----
  const forwarded = JSON.parse(await wc.executeJavaScript(`
    (() => {
      const wv = document.querySelector('webview');
      if (!wv) return JSON.stringify({ ok: false });
      const before = tabs.length;
      const ev = new Event('ipc-message');
      ev.channel = 'mb-shortcut';
      ev.args = [{ ctrl: true, shift: false, key: 't' }];
      wv.dispatchEvent(ev);
      return JSON.stringify({ ok: true, before, after: tabs.length });
    })();
  `));
  log.push(['C guest 转发', JSON.stringify(forwarded)]);
  exp(forwarded.ok, 'C：应能找到 webview 元素');
  exp(forwarded.after === forwarded.before + 1, 'C：mb-shortcut 应走同一套快捷键逻辑新建标签');

  console.log('\n======== 会话恢复与快捷键 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(20, ' ') + v));
  console.log('==========================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：ID 空洞恢复后仍有活动标签，快捷键与 guest 转发均生效。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
