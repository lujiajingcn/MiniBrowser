'use strict';
/** 验证「完全透明模式」在真实外壳里的菜单项与状态联动。 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const ROOT = __dirname;
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:1000, height:700,
    webPreferences:{ offscreen:true, contextIsolation:true, nodeIntegration:false,
      preload:path.join(ROOT,'preload.js'), webviewTag:true, sandbox:false }});
  const wc = win.webContents;
  wc.on('console-message', (_e,_l,m) => console.log('  [页面] ' + m));

  // 【关键】必须在 loadFile 之前清掉持久化状态。
  // renderer.js 在启动时就读 localStorage 恢复模式（mb_transparent 等），
  // 上一轮测试留下的 '1' 会让菜单文案变成「退出透明模式」，
  // 使「进入透明模式」断言失败 —— 那是测试环境污染，不是产品缺陷。
  // 放在 loadFile 之后就晚了，那时状态已被恢复并写回。
  // 用 executeJavaScript 在 about:blank 上先清一次（此时同源 localStorage 可用）。
  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `).catch(() => {});

  await win.loadFile(path.join(ROOT,'index.html'));
  await wait(1600);

  const fails = [], log = [];
  const exp = (c,m) => { if(!c) fails.push(m); };

  // 兜底再清一次（loadFile 期间 renderer.js 可能又写回了状态）
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    document.body.className = '';
  `);
  await wait(300);

  // 右键菜单里应有「进入完全透明模式」项，且在「进入透明模式」下方
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100,button:2}));
  `);
  await wait(400);
  const items = await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li'))
      .map(li => li.textContent)
  `);
  log.push(['菜单项', JSON.stringify(items)]);
  const iT = items.indexOf('进入透明模式');
  const iF = items.indexOf('进入完全透明模式');
  exp(iT >= 0, '菜单应有「进入透明模式」，实际 ' + JSON.stringify(items));
  exp(iF >= 0, '菜单应有「进入完全透明模式」，实际 ' + JSON.stringify(items));
  exp(iF === iT + 1, '「进入完全透明模式」应紧跟在「进入透明模式」下方，实际索引 ' + iT + ' -> ' + iF);

  // 点击该项：应进入完全透明（transparent + full-transparent 同时生效）
  await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li'))
      .find(li => li.textContent === '进入完全透明模式').click();
  `);
  await wait(600);
  const st = await wc.executeJavaScript(`({
    cls: document.body.className,
    full: document.body.classList.contains('full-transparent'),
    trans: document.body.classList.contains('transparent'),
  })`);
  log.push(['点击后 body.class', st.cls]);
  exp(st.full === true, '点击后应带 full-transparent 类');
  exp(st.trans === true, '点击后应同时带 transparent 类（完全透明依赖透明模式）');

  // 再次右键：菜单项文案应变「退出完全透明模式」
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100,button:2}));
  `);
  await wait(400);
  const items2 = await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li')).map(li => li.textContent)
  `);
  log.push(['再次右键菜单项', JSON.stringify(items2)]);
  exp(items2.indexOf('退出完全透明模式') >= 0,
    '再次右键应显示「退出完全透明模式」，实际 ' + JSON.stringify(items2));

  // 点击退出：只撤销完全透明，透明模式应保持开启
  await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li'))
      .find(li => li.textContent === '退出完全透明模式').click();
  `);
  await wait(500);
  const st2 = await wc.executeJavaScript(`({
    cls: document.body.className,
    full: document.body.classList.contains('full-transparent'),
    trans: document.body.classList.contains('transparent'),
  })`);
  log.push(['退出后 body.class', st2.cls]);
  exp(st2.full === false, '退出后 full-transparent 应移除');
  exp(st2.trans === true, '退出完全透明后，普通透明模式应保持开启（两者非互斥）');

  console.log('\n======== 完全透明模式 UI 联动验证 ========');
  log.forEach(([k,v]) => console.log('  ' + String(k).padEnd(24) + v));
  console.log('===========================================');
  if (fails.length) { console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f)); process.exitCode = 1; }
  else console.log('\n全部通过：菜单项位置正确、状态联动正确、退出只撤销加强效果。');
  app.quit();
}).catch(e => { console.error(e && e.stack); app.quit(); });
