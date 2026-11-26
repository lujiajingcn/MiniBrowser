'use strict';

/**
 * 诊断：通用右键菜单里的「关闭当前标签页」是否真的关掉标签。
 *
 * 【覆盖】
 *   A 菜单里存在该项，点击后标签数 -1、激活标签切到相邻标签、菜单收起
 *   B 关掉最后一个标签时仍保留一个首页标签（与 Ctrl+W 行为一致）
 *   C 被关掉的标签进入「最近关闭」列表（可用 Ctrl+Shift+T 恢复）
 *
 * 用法：node diag-close-tab-menu.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);

  // ---------- 准备：只剩一个标签，再开第二个作为待关闭目标 ----------
  const prep = JSON.parse(await wc.executeJavaScript(`
    (() => {
      if (!tabs.length) createTab('about:blank');
      while (tabs.length > 1) closeTab(tabs[tabs.length - 1].id);
      setActiveTab(tabs[0].id);
      createTab('about:blank');
      return JSON.stringify({
        count: tabs.length, active: activeTabId,
        first: tabs[0] && tabs[0].id, second: tabs[1] && tabs[1].id,
      });
    })();
  `));
  log.push(['准备', JSON.stringify(prep)]);
  exp(prep.count === 2 && prep.active === prep.second, '前置：应有两个标签且激活第二个');

  // ---------- A/B：弹出菜单后点击新菜单项 ----------
  const clicked = JSON.parse(await wc.executeJavaScript(`
    (() => {
      showPageContextMenu(100, 100);
      const menu = document.getElementById('context-menu');
      const list = document.getElementById('context-menu-list');
      const items = Array.from(list.querySelectorAll('li')).map(li => li.textContent);
      const li = Array.from(list.querySelectorAll('li')).find(el => el.textContent === '关闭当前标签页');
      if (!li) return JSON.stringify({ ok: false, reason: '菜单项不存在', items });
      const before = { count: tabs.length, active: activeTabId };
      li.click();
      return JSON.stringify({
        ok: true, items, before,
        countAfter: tabs.length, activeAfter: activeTabId,
        menuHidden: menu.classList.contains('hidden'),
        closedCount: closedTabs.length,
      });
    })();
  `));
  log.push(['菜单项', JSON.stringify(clicked.items)]);
  log.push(['点击结果', JSON.stringify({
    count: clicked.countAfter, active: clicked.activeAfter,
    menuHidden: clicked.menuHidden, closedCount: clicked.closedCount,
  })]);
  exp(clicked.ok === true, '菜单中应存在「关闭当前标签页」');
  exp(clicked.countAfter === 1, '点击后应只剩一个标签，实际 ' + clicked.countAfter);
  exp(clicked.activeAfter === prep.first, '关闭后应切到剩下的那个标签');
  exp(clicked.menuHidden === true, '点击后菜单应收起');
  exp(clicked.closedCount > 0, '被关闭的标签应进入最近关闭列表');

  // ---------- C：关掉最后一个标签仍保留一个 ----------
  const last = JSON.parse(await wc.executeJavaScript(`
    (() => {
      showPageContextMenu(100, 100);
      const li = Array.from(document.querySelectorAll('#context-menu-list li'))
        .find(el => el.textContent === '关闭当前标签页');
      if (!li) return JSON.stringify({ ok: false });
      li.click();
      return JSON.stringify({
        ok: true, count: tabs.length, active: activeTabId,
        hasWebview: !!(tabs[0] && tabs[0].webview),
      });
    })();
  `));
  log.push(['最后一个标签', JSON.stringify(last)]);
  exp(last.ok === true && last.count === 1 && !!last.active,
    '关闭最后一个标签后应自动补一个首页标签');

  console.log('\n======== 右键菜单「关闭当前标签页」 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(16, ' ') + v));
  console.log('================================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：菜单项存在，点击后标签被关闭，最后一个标签会补首页。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
