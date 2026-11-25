'use strict';

/**
 * 「收藏当前页后弹出层自动消失」端到端验证。
 *
 * 复现与验证要点：
 *  1) 打开收藏夹弹层 → 点「⭐ 收藏当前页」→ 弹层应隐藏
 *  2) 收藏**确实生效**（书签树里新增了条目、收藏夹栏刷新、星星图标变为已收藏）
 *  3) toast 文案仍正确显示目标文件夹名（因为 closeBookmarksPopover() 会把
 *     _bmCurrent 置 null，标题必须在关闭前取 —— 这是本次改动最容易踩的坑）
 *  4) 重复收藏（地址已在收藏夹中）→ 弹层也应关闭
 *  5) 弹层内「⭐ 收藏到此文件夹」按钮（另一个调用点）→ 也应关闭
 *  6) 退出弹层后可重新打开（closeBookmarksPopover 把 _bmCurrent 置 null，
 *     再次打开时必须能正确重建）
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = __dirname;
const W = 1100;
const H = 750;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
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
  wc.on('console-message', (_e, _l, m) => {
    if (m && !/Security Warning|Policy|exposes|consult|electronjs/.test(m)) {
      console.log('  [页面] ' + m);
    }
  });

  // 清掉持久化的书签与模式状态，避免上一轮遗留数据干扰
  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `).catch(() => {});

  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1600);

  const popoverOpen = () =>
    wc.executeJavaScript(
      "!document.getElementById('bm-popover').classList.contains('hidden')"
    );

  // 准备一个确定的收藏环境：清空书签、设一个已知 URL
  // 用**带时间戳的唯一 URL** —— renderer.js 的 getBookmarks() 有模块级内存缓存
  // _bmRoot，清了 localStorage 也不会立刻清掉它；用固定 URL 会与上一次运行
  // 残留的收藏撞上（表现为「该地址已在收藏夹中」而不是「已收藏到…」）。
  const TEST_URL = 'https://example.com/test-page-' + Date.now();
  await wc.executeJavaScript(`
    (() => {
      try { localStorage.removeItem('mb_bookmarks'); } catch (e) {}
      document.getElementById('url').value = ${JSON.stringify(TEST_URL)};
    })();
  `);
  await wait(300);

  // ---- 场景 1：打开弹层 → 点「收藏当前页」→ 应关闭 ----
  await wc.executeJavaScript(`
    (() => {
      // 「管理收藏夹」按钮在收藏夹栏末尾
      const manage = document.querySelector('.bookmark.manage');
      manage.click();
    })();
  `);
  await wait(400);
  log.push(['场景1 弹层已打开', await popoverOpen()]);
  exp(await popoverOpen(), '场景1：前置条件，弹层应打开');

  const hasBtn = await wc.executeJavaScript(
    "!!document.getElementById('bm-add-current')"
  );
  log.push(['场景1 存在「收藏当前页」按钮', hasBtn]);
  exp(hasBtn, '场景1：弹层里应有「收藏当前页」按钮');

  await wc.executeJavaScript(`
    document.getElementById('bm-add-current').click();
  `);
  await wait(500);

  const afterAdd = await wc.executeJavaScript(`({
    open: !document.getElementById('bm-popover').classList.contains('hidden'),
    toast: (document.getElementById('toast') || {}).textContent || '',
    toastShown: document.getElementById('toast').classList.contains('show'),
    bmBar: document.querySelectorAll('#bookmarks-bar .bookmark').length,
  })`);
  log.push(['场景1 收藏后 弹层还开着?', afterAdd.open]);
  log.push(['场景1 收藏后 toast', afterAdd.toast]);
  log.push(['场景1 收藏后 收藏夹栏条目数', afterAdd.bmBar]);
  exp(afterAdd.open === false, '场景1：收藏后弹层必须自动隐藏（本次需求核心）');
  exp(afterAdd.toastShown === true, '场景1：应弹出 toast 提示');
  exp(/已收藏到/.test(afterAdd.toast),
    '场景1：toast 文案应说明收藏到哪个文件夹，实际 "' + afterAdd.toast + '"');
  // 收藏确实生效：收藏夹栏应多出条目（默认 4 个 + 新增 1 个 = 5）
  exp(afterAdd.bmBar >= 5, '场景1：收藏夹栏应出现新条目，实际 ' + afterAdd.bmBar + ' 个');

  // ---- 场景 2：书签树里确实写入了 ----
  const tree = await wc.executeJavaScript(`
    (() => {
      try {
        const raw = localStorage.getItem('mb_bookmarks');
        return raw || '';
      } catch (e) { return ''; }
    })();
  `);
  log.push(['场景2 书签已持久化', tree ? '是' : '否']);
  exp(tree.indexOf(TEST_URL) >= 0,
    '场景2：书签数据应包含刚收藏的 URL');

  // ---- 场景 3：星星图标应变为「已收藏」 ----
  const star = await wc.executeJavaScript(`(() => {
    const b = document.getElementById('bookmark');
    return { title: b.title, pressed: b.getAttribute('aria-pressed') };
  })()`);
  log.push(['场景3 星星按钮 title', star.title]);
  exp(/取消收藏/.test(star.title), '场景3：收藏后按钮应变为「取消收藏」，实际 ' + star.title);

  // ---- 场景 4：重复收藏（已在收藏夹中）→ 也应关闭弹层 ----
  await wc.executeJavaScript(`
    document.querySelector('.bookmark.manage').click();
  `);
  await wait(350);
  const openedAgain = await popoverOpen();
  log.push(['场景4 重新打开弹层', openedAgain]);
  exp(openedAgain, '场景4：前置条件，弹层应能重新打开（验证 _bmCurrent 被正确重建）');

  await wc.executeJavaScript(`document.getElementById('bm-add-current').click();`);
  await wait(400);
  const afterDup = await wc.executeJavaScript(`({
    open: !document.getElementById('bm-popover').classList.contains('hidden'),
    toast: (document.getElementById('toast') || {}).textContent || '',
  })`);
  log.push(['场景4 重复收藏后 弹层还开着?', afterDup.open]);
  log.push(['场景4 重复收藏 toast', afterDup.toast]);
  exp(afterDup.open === false, '场景4：重复收藏时弹层也应关闭');
  exp(/已在收藏夹/.test(afterDup.toast),
    '场景4：应提示「已在收藏夹中」，实际 "' + afterDup.toast + '"');

  // ---- 场景 5：弹层内「⭐ 收藏到此文件夹」按钮（另一个调用点） ----
  // 注意：header 按钮的状态取决于当前 URL 是否已收藏 ——
  // 已收藏时它是「★ 取消收藏」（走 removeBookmarkByUrl 分支，不该关闭弹层）。
  // 因此这里必须先换一个**未收藏**的 URL，才能走到「⭐ 收藏到此文件夹」分支。
  await wc.executeJavaScript(`
    (() => {
      document.getElementById('url').value = 'https://example.com/never-saved-page-' + Date.now();
    })();
  `);
  await wc.executeJavaScript(`document.querySelector('.bookmark.manage').click();`);
  await wait(400);
  const headerBtnText = await wc.executeJavaScript(`(() => {
    const h = document.querySelector('#bm-popover .bm-header-btn');
    return h ? h.textContent : '';
  })()`);
  log.push(['场景5 header 按钮文案', headerBtnText]);
  exp(/收藏到此文件夹/.test(headerBtnText),
    '场景5：未收藏时 header 按钮应为「收藏到此文件夹」，实际 "' + headerBtnText + '"');

  await wc.executeJavaScript(`(() => {
    const h = document.querySelector('#bm-popover .bm-header-btn');
    if (h) h.click();
  })()`);
  await wait(450);
  const afterHeader = await popoverOpen();
  const headerToast = await wc.executeJavaScript(
    "(document.getElementById('toast') || {}).textContent || ''"
  );
  log.push(['场景5 点 header 按钮后 弹层还开着?', afterHeader]);
  log.push(['场景5 toast', headerToast]);
  exp(afterHeader === false, '场景5：弹层内「收藏到此文件夹」点击后也应关闭');
  exp(/已收藏到/.test(headerToast),
    '场景5：应提示已收藏，实际 "' + headerToast + '"');

  // ---- 场景 6：关闭后弹层能再次打开且内容正常 ----
  await wc.executeJavaScript(`document.querySelector('.bookmark.manage').click();`);
  await wait(400);
  const reopen = await popoverOpen();
  const listCount = await wc.executeJavaScript(
    "document.querySelectorAll('#bm-popover .bm-row').length"
  );
  log.push(['场景6 再次打开', reopen]);
  log.push(['场景6 列表行数', listCount]);
  exp(reopen, '场景6：关闭后应能重新打开弹层');
  exp(listCount > 0, '场景6：重新打开后列表应有内容');

  console.log('\n======== 收藏后弹层自动消失 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(30, ' ') + v));
  console.log('============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：收藏后弹层自动关闭，收藏生效，toast 正确，可重复打开。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
