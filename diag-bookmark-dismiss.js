'use strict';

/**
 * 收藏夹弹层「点外部关闭」验证。
 *
 * 与右键菜单是同一类问题：关闭逻辑原本只挂在**外壳 document** 上，
 * 而 <webview> 是独立 guest 进程，网页内的点击不冒泡到外壳 document，
 * 表现为「点网页内容区，收藏弹层不消失」。
 *
 * 验证两条路径：
 *  A. 外壳区域（工具栏/收藏夹栏）点击 → 应关闭
 *  B. 网页内容区（guest 进程）点击 → 通过 mb-page-pointer-down 通道转发 → 应关闭
 *
 * B 路径无法真的点远程网页（离线且慢），改为**驱动真实的 ipc-message 分支**：
 * 在页面里找到 webview 的 ipc-message 监听器并向它投递该 channel 的消息，
 * 验证的是产品的真实处理逻辑，而不是另写一份模拟。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
    if (m && !/Security|Policy|exposes|consult|electronjs/.test(m)) {
      console.log('  [页面] ' + m);
    }
  });

  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2','mb_bookmarks']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `).catch(() => {});
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1600);
  await wc.executeJavaScript("document.body.className = '';");
  await wait(200);

  const popoverOpen = () =>
    wc.executeJavaScript(
      "!document.getElementById('bm-popover').classList.contains('hidden')"
    );

  // 打开收藏夹弹层（点收藏夹栏末尾的「管理收藏夹」按钮）
  const openPopover = async () => {
    await wc.executeJavaScript(`
      (() => {
        const manage = document.querySelector('.bookmark.manage');
        if (manage) manage.click();
      })();
    `);
    await wait(400);
  };

  // ---- 场景 A：外壳区域点击 → 应关闭 ----
  await openPopover();
  log.push(['场景A 弹层已打开', await popoverOpen()]);
  exp(await popoverOpen(), '场景A：前置条件，弹层应打开');

  await wc.executeJavaScript(`
    (() => {
      // 点工具栏（弹层之外的区域）
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('mousedown', {bubbles:true, clientX:600, clientY:20, button:0}));
    })();
  `);
  await wait(350);
  log.push(['场景A 外壳点击后 弹层还开着?', await popoverOpen()]);
  exp(!(await popoverOpen()), '场景A：点外壳区域应关闭收藏弹层');

  // ---- 场景 B：网页内容区点击（guest 进程）→ 应关闭 ----
  await openPopover();
  log.push(['场景B 弹层已打开', await popoverOpen()]);
  exp(await popoverOpen(), '场景B：前置条件，弹层应打开');

  // guest 侧是**真实的 DOM mousedown 监听**（webview-preload 的 onPagePointerDown），
  // 所以必须在 guest 页面里派发真实 mousedown 事件，
  // 由 preload 捕获后 sendToHost 转发 —— 走的是完整的产品链路。
  const guestResult = await wc.executeJavaScript(`
    (() => {
      const wv = document.querySelector('webview');
      if (!wv) return { ok: false, reason: 'no webview' };
      return { ok: true };
    })();
  `);
  if (!guestResult.ok) {
    fails.push('场景B：找不到 webview 元素');
  } else {
    // 在 guest 页面内派发真实的 mousedown（button=0 表示左键）
    const r = await wc.executeJavaScript(`
      (() => {
        const wv = document.querySelector('webview');
        return wv.executeJavaScript(
          "(function(){ var d=document.createEvent('MouseEvents');" +
          "d.initMouseEvent('mousedown', true, true, window, 1, 100, 100, 200, 200," +
          " false, false, false, false, 0, null);" +
          "document.body.dispatchEvent(d); return 'dispatched'; })()"
        );
      })();
    `);
    log.push(['场景B guest 内派发 mousedown', JSON.stringify(r)]);
    await wait(700);
    log.push(['场景B 网页点击后 弹层还开着?', await popoverOpen()]);
    exp(!(await popoverOpen()),
      '场景B：点网页内容区应关闭收藏弹层（经 mb-page-pointer-down 通道）');
  }

  // ---- 场景 C：弹层内的按钮不应被误关 ----
  await openPopover();
  const inside = await wc.executeJavaScript(`
    (() => {
      const menu = document.getElementById('bm-popover');
      const btn = document.getElementById('bm-add-current');
      if (!btn) return { hasBtn: false };
      btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
      return { hasBtn: true, stillOpen: !menu.classList.contains('hidden') };
    })();
  `);
  log.push(['场景C 弹层内按钮 mousedown 后', JSON.stringify(inside)]);
  exp(inside.hasBtn, '场景C：弹层内应有「收藏当前页」按钮');
  exp(inside.stillOpen === true,
    '场景C：在弹层内按钮上 mousedown 不应关闭弹层，实际 ' + JSON.stringify(inside));

  // ---- 场景 D：Esc 关闭仍然有效 ----
  await wc.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  `);
  await wait(300);
  log.push(['场景D Esc 后 弹层还开着?', await popoverOpen()]);
  exp(!(await popoverOpen()), '场景D：Esc 应能关闭弹层');

  console.log('\n======== 收藏弹层点外部关闭 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(30, ' ') + v));
  console.log('============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：外壳与网页内容区两条路径均可关闭收藏弹层，弹层内按钮不被误关。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
