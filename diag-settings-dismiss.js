'use strict';

/**
 * 设置面板「点外部关闭」验证。
 *
 * 外壳区域（工具栏/标签栏）的点击由 renderer.js 的 document click 监听处理；
 * <webview> 是独立 guest 进程，网页内的点击不冒泡到外壳 document，
 * 必须经 webview-preload 的 mb-page-pointer-down 通道转发。
 * 该通道此前只关闭右键菜单与收藏弹层，遗漏了设置面板，
 * 表现为「打开设置后点网页，设置面板不消失」。
 *
 * 场景 A：外壳区域点击 → 关闭
 * 场景 B：网页内容区点击（guest 真实 mousedown → sendToHost）→ 关闭
 * 场景 C：面板内部点击 → 不关闭
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// 独立 userData：诊断会清理透明/无框状态，不能污染真实 profile。
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'minibrowser-diag-settings-' + process.pid));

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

  const panelOpen = () =>
    wc.executeJavaScript(
      "!document.getElementById('settings-panel').classList.contains('hidden')"
    );

  const openPanel = async () => {
    await wc.executeJavaScript(`
      (() => {
        const p = document.getElementById('settings-panel');
        // showPanel 是 toggle：面板已开着时再点设置按钮会收起它，
        // 所以先用真实的外壳点击收起，保证这次点击一定是「打开」。
        if (p && !p.classList.contains('hidden')) {
          document.querySelector('.toolbar').dispatchEvent(
            new MouseEvent('click', {bubbles:true, clientX:600, clientY:20, button:0}));
        }
        document.getElementById('settings').click();
      })();
    `);
    await wait(400);
  };

  // ---- 场景 A：外壳区域点击 → 应关闭 ----
  await openPanel();
  log.push(['场景A 设置面板已打开', await panelOpen()]);
  exp(await panelOpen(), '场景A：前置条件，设置面板应打开');

  await wc.executeJavaScript(`
    (() => {
      const bar = document.querySelector('.toolbar');
      bar.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:600, clientY:20, button:0}));
      bar.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:600, clientY:20, button:0}));
    })();
  `);
  await wait(350);
  log.push(['场景A 外壳点击后 还开着?', await panelOpen()]);
  exp(!(await panelOpen()), '场景A：点外壳区域应关闭设置面板');

  // ---- 场景 B：网页内容区点击（guest 进程）→ 应关闭 ----
  await openPanel();
  log.push(['场景B 设置面板已打开', await panelOpen()]);
  exp(await panelOpen(), '场景B：前置条件，设置面板应打开');

  const hasWebview = await wc.executeJavaScript("!!document.querySelector('webview')");
  if (!hasWebview) {
    fails.push('场景B：找不到 webview 元素');
  } else {
    // 在 guest 页面内派发真实 mousedown，由 preload 捕获后 sendToHost 转发，
    // 走完整产品链路（不是另写一份模拟逻辑）。
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
    log.push(['场景B 网页点击后 还开着?', await panelOpen()]);
    exp(!(await panelOpen()),
      '场景B：点网页内容区应关闭设置面板（经 mb-page-pointer-down 通道）');
  }

  // ---- 场景 C：面板内部点击不应误关 ----
  await openPanel();
  const inside = await wc.executeJavaScript(`
    (() => {
      const panel = document.getElementById('settings-panel');
      const input = document.getElementById('set-home');
      if (!input) return { hasInput: false };
      input.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
      input.dispatchEvent(new MouseEvent('click', {bubbles:true, button:0}));
      return { hasInput: true, stillOpen: !panel.classList.contains('hidden') };
    })();
  `);
  log.push(['场景C 面板内点击后', JSON.stringify(inside)]);
  exp(inside.hasInput, '场景C：设置面板内应有主页输入框');
  exp(inside.stillOpen === true,
    '场景C：面板内点击不应关闭面板，实际 ' + JSON.stringify(inside));

  console.log('\n======== 设置面板点外部关闭 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(30, ' ') + v));
  console.log('============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：外壳与网页内容区两条路径均可关闭设置面板，面板内点击不被误关。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
