'use strict';

/**
 * 右键菜单「点外部关闭」端到端验证。
 *
 * 要验证的是两条独立的关闭路径（此前只有一条是好的）：
 *  A. 外壳区域（工具栏/标签栏/面板）左键点击 → 关闭
 *  B. 网页内容区（<webview> guest 进程）左键点击 → 关闭
 *     这条此前**完全失效**：guest 进程的事件不冒泡到外壳 document，
 *     外壳的 document mousedown 永远收不到网页内的点击。
 *
 * 另外要验证「不该关」的场景，避免过度关闭：
 *  C. 点击菜单项本身 → 不在 mousedown 阶段误关（否则动作执行时菜单已消失）
 *  D. 菜单未打开时点击页面 → 不报错（幂等）
 *
 * B 路径在 guest 页内派发真实 mousedown，由 webview-preload 捕获后
 * sendToHost → renderer 的 ipc-message 分支 → hideContextMenu，
 * 验证完整链路。旧版只做源码字符串包含检查，属于假阳性。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// 独立 userData：诊断前置状态需要干净，且不能污染真实 profile。
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'minibrowser-diag-contextmenu-' + process.pid));

const ROOT = __dirname;
const W = 1000;
const H = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
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
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1500);

  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const wc = win.webContents;
  // 捕获渲染进程报错，否则 executeJavaScript 只会笼统报
  // "Script failed to execute"，看不出是哪一行的问题。
  wc.on('console-message', (_e, _level, message) => {
    console.log('  [页面] ' + message);
  });
  wc.on('preload-error', (_e, p, err) => {
    console.log('  [preload 错误] ' + p + ' -> ' + (err && err.message));
  });

  const menuOpen = () =>
    wc.executeJavaScript(
      "!document.getElementById('context-menu').classList.contains('hidden')"
    );

  // ---- 场景 A：外壳区域右键开菜单，再左键点外壳 → 应关闭 ----
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100, button:2})
    );
  `);
  await wait(300);
  log.push(['A 外壳右键后菜单打开', await menuOpen()]);
  exp(await menuOpen(), 'A：外壳右键应能打开菜单');

  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('mousedown', {bubbles:true, clientX:300, clientY:100, button:0})
    );
  `);
  await wait(250);
  log.push(['A 外壳左键点外部后', await menuOpen()]);
  exp(!(await menuOpen()), 'A：点外壳外部应关闭菜单');

  // ---- 场景 B：网页内容区（guest）左键点击 → 应关闭 ----
  // 模拟 webview-preload 的 sendToHost('mb-page-pointer-down') 经由
  // renderer.js 的 ipc-message 分支关闭菜单。这里直接调真实的 hook 路径。
  await wc.executeJavaScript(`
    (() => {
      // 走真实的产品代码：右键开菜单
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100, button:2})
      );
    })();
  `);
  await wait(300);
  log.push(['B 菜单打开', await menuOpen()]);
  exp(await menuOpen(), 'B：前置条件，菜单应打开');

  // 复刻 wireWebview 里ipc-message 分支对 mb-page-pointer-down 的处理：
  // renderer.js 中该分支是 `hideContextMenu()`，这里通过真实调用验证效果。
  const hiddenBefore = await wc.executeJavaScript(
    "document.getElementById('context-menu').classList.contains('hidden')"
  );
  log.push(['B 收到通知前 hidden', hiddenBefore]);
  exp(hiddenBefore === false, 'B：前置条件，菜单此时应处于打开态');

  // 旧版这里只做源码字符串包含检查：把 renderer.js 的处理分支删空、
  // 或让 preload 不再转发，测试仍会报「全部通过」（假阳性）。
  // 改为在 guest 页面内派发真实 mousedown，由 preload 捕获后 sendToHost，
  // 最后断言菜单真的关闭 —— 验证的是完整产品链路。
  const hasWebview = await wc.executeJavaScript("!!document.querySelector('webview')");
  exp(hasWebview, 'B：应能找到 webview 元素');
  if (hasWebview) {
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
    log.push(['B guest 内派发 mousedown', JSON.stringify(r)]);
    await wait(700);
    log.push(['B 网页点击后 菜单还开着?', await menuOpen()]);
    exp(!(await menuOpen()), 'B：点网页内容区应关闭右键菜单（经 mb-page-pointer-down 通道）');
  }

  // ---- 场景 C：菜单项自身 mousedown 不应触发关闭 ----
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100, button:2})
    );
  `);
  await wait(300);
  const insideCheck = await wc.executeJavaScript(`
    (() => {
      const menu = document.getElementById('context-menu');
      const li = menu.querySelector('#context-menu-list li');
      if (!li) return { hasLi: false };
      // 在菜单项上 dispatch mousedown，模拟真实按下
      li.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
      return { hasLi: true, stillOpen: !menu.classList.contains('hidden') };
    })()
  `);
  log.push(['C 菜单项 mousedown 后', JSON.stringify(insideCheck)]);
  exp(insideCheck.hasLi, 'C：菜单里应有菜单项');
  exp(insideCheck.stillOpen === true,
    'C：在菜单项上 mousedown 不应关闭菜单（否则动作执行时菜单已消失），实际 ' + JSON.stringify(insideCheck));

  // ---- 场景 D：菜单未打开时点页面，幂等不报错 ----
  await wc.executeJavaScript(`
    (() => {
      const menu = document.getElementById('context-menu');
      menu.classList.add('hidden');
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('mousedown', {bubbles:true, clientX:300, clientY:100, button:0})
      );
    })();
  `);
  await wait(200);
  log.push(['D 未开菜单时点页面', await menuOpen()]);
  exp(!(await menuOpen()), 'D：菜单未打开时应保持关闭且不报错');

  // ---- 场景 E：右键点在菜单自身上，不应触发「外部点击」关闭 ----
  await wc.executeJavaScript(`
    (() => {
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100, button:2})
      );
    })();
  `);
  await wait(300);
  await wc.executeJavaScript(`
    (() => {
      const menu = document.getElementById('context-menu');
      menu.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0}));
    })();
  `);
  await wait(200);
  log.push(['E 菜单自身 mousedown 后', await menuOpen()]);
  exp(await menuOpen(), 'E：在菜单自身上按下不应关闭菜单');

  console.log('\n========== 右键菜单点外部关闭 验证 ==========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(26, ' ') + v));
  console.log('==============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：外壳与网页内容区两条路径均可关闭菜单，菜单自身不会被误关。');
  }
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
