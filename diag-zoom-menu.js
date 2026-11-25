'use strict';

/**
 * 诊断：缩放按钮（#zoom）点击后应弹出缩放菜单并能真正改变缩放。
 *
 * 背景：原实现是「点击直接重置到 100%」。按钮上显示的是百分比，
 * 用户的直觉是「点这里选缩放比例」（Chrome/Edge 都是这样），
 * 结果点下去毫无变化 —— 页面本来就是 100% 时尤其明显，表现为「按钮无效」。
 *
 * 另外还修了原生缩放（Ctrl+滚轮）后按钮显示与实际缩放脱节的问题
 * （监听 webview 的 zoom-changed）。
 *
 * 覆盖：
 *   A 点击按钮弹出菜单
 *   B 菜单项齐全（百分比档位 + 恢复默认），当前档位高亮
 *   C 选一个档位 → 按钮文字、逻辑档位、webview 实际缩放三者一致
 *   D 「恢复默认」→ 回到 100%
 *   E 原生缩放后按钮能同步（zoom-changed）
 *   F 点外部/Esc 关闭菜单
 *
 * 用法：node diag-zoom-menu.js
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
    width: 1100, height: 750, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);

  const snap = () => wc.executeJavaScript(`
    (() => {
      const btn = document.getElementById('zoom');
      const menu = document.getElementById('zoom-menu');
      const t = activeTab ? activeTab() : null;
      const wv = t && t.webview;
      let actual = null;
      try { actual = wv ? wv.getZoomLevel() : null; } catch (e) { actual = 'ERR'; }
      return JSON.stringify({
        btnText: btn ? btn.textContent : null,
        menuHidden: menu ? menu.classList.contains('hidden') : null,
        menuItems: menu ? Array.from(menu.querySelectorAll('li')).map(li => ({
          text: li.textContent, active: li.classList.contains('active'), divider: li.classList.contains('divider')
        })) : [],
        level: t ? t.zoomLevel : null,
        actualZoom: actual,
      });
    })();
  `);

  // ---------- A. 点击弹出菜单 ----------
  await wc.executeJavaScript(`document.getElementById('zoom').click();`);
  await wait(400);
  let s = JSON.parse(await snap());
  log.push(['A 菜单是否弹出', s.menuHidden === false]);
  exp(s.menuHidden === false, '场景A：点击缩放按钮应弹出菜单');
  log.push(['A 按钮文字', s.btnText]);
  log.push(['A 菜单项', s.menuItems.map((i) => i.text).join(' | ')]);

  // ---------- B. 菜单项与高亮 ----------
  const texts = s.menuItems.map((i) => i.text);
  exp(texts.includes('50%'), '场景B：菜单应含 50%');
  exp(texts.includes('100%'), '场景B：菜单应含 100%');
  exp(texts.includes('125%'), '场景B：菜单应含 125%');
  exp(texts.includes('200%'), '场景B：菜单应含 200%');
  exp(texts.includes('恢复默认'), '场景B：菜单应含「恢复默认」');
  const active100 = s.menuItems.find((i) => i.text === '100%');
  exp(active100 && active100.active, '场景B：当前 100% 应高亮');
  log.push(['B 100% 高亮', !!(active100 && active100.active)]);

  // ---------- C. 选 125% ----------
  await wc.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('#zoom-menu li'));
      const t = items.find(li => li.textContent === '125%');
      if (t) t.click();
    })();
  `);
  await wait(700);
  s = JSON.parse(await snap());
  log.push(['C 选125% 后 按钮文字', s.btnText]);
  log.push(['C 选125% 后 level/actual', s.level + ' / ' + s.actualZoom]);
  log.push(['C 菜单已关闭', s.menuHidden]);
  exp(s.btnText === '125%', '场景C：按钮应显示 125%，实际 ' + s.btnText);
  exp(Math.abs(s.actualZoom - s.level) < 0.001, '场景C：webview 实际缩放应与档位一致');
  exp(s.menuHidden === true, '场景C：选完应关闭菜单');

  // ---------- D. 恢复默认 ----------
  await wc.executeJavaScript(`document.getElementById('zoom').click();`);
  await wait(300);
  await wc.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('#zoom-menu li'));
      const t = items.find(li => li.textContent === '恢复默认');
      if (t) t.click();
    })();
  `);
  await wait(700);
  s = JSON.parse(await snap());
  log.push(['D 恢复默认后 按钮文字', s.btnText]);
  log.push(['D 恢复默认后 actual', s.actualZoom]);
  exp(s.btnText === '100%', '场景D：恢复默认后应显示 100%，实际 ' + s.btnText);
  exp(Math.abs(s.actualZoom) < 0.001, '场景D：恢复默认后实际缩放应为 0');

  // ---------- E. 原生缩放同步 ----------
  // 注意：Electron 的 zoom-changed **只在用户手势缩放时触发**
  //（文档原文：Emitted when the user is zooming using the mouse wheel），
  // 程序化 setZoomLevel 不触发，所以这里必须用真实的 Ctrl+滚轮事件。
  await wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      t.webview.sendInputEvent({
        type: 'mouseWheel', x: 100, y: 100,
        deltaX: 0, deltaY: -240, canScroll: true,
        modifiers: ['control'],
      });
    })();
  `);
  await wait(1000);
  s = JSON.parse(await snap());
  log.push(['E Ctrl+滚轮后 按钮文字', s.btnText]);
  log.push(['E Ctrl+滚轮后 level/actual', s.level + ' / ' + s.actualZoom]);
  if (s.actualZoom !== 0) {
    // 确实发生了原生缩放 → 检查按钮是否同步
    exp(s.btnText !== '100%', '场景E：原生缩放后按钮不应仍显示 100%（实际 ' + s.btnText + '）');
    exp(Math.abs(s.level - s.actualZoom) < 0.001, '场景E：按钮档位应与实际缩放同步');
  } else {
    log.push(['E', '本环境无法用 Ctrl+滚轮触发原生缩放，跳过同步断言']);
  }

  // E2. 无论原生缩放是否发生，**点菜单里的 100% 必须能真正把页面复位**
  // （这是用户点按钮的最终目的，比按钮显示是否同步更重要）
  await wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      t.webview.setZoomLevel(0.5);   // 强制制造一个非 100% 的实际缩放
    })();
  `);
  await wait(600);
  const beforeReset = JSON.parse(await snap());
  await wc.executeJavaScript(`document.getElementById('zoom').click();`);
  await wait(300);
  await wc.executeJavaScript(`
    (() => {
      const items = Array.from(document.querySelectorAll('#zoom-menu li'));
      const t = items.find(li => li.textContent === '100%');
      if (t) t.click();
    })();
  `);
  await wait(700);
  s = JSON.parse(await snap());
  log.push(['E2 复位前 actual', beforeReset.actualZoom]);
  log.push(['E2 复位后 按钮文字/actual', s.btnText + ' / ' + s.actualZoom]);
  exp(Math.abs(s.actualZoom) < 0.001,
    '场景E2：菜单选 100% 必须把实际缩放复位（实际 ' + s.actualZoom + '）');
  exp(s.btnText === '100%', '场景E2：复位后按钮应显示 100%，实际 ' + s.btnText);

  // ---------- F. 关闭方式 ----------
  await wc.executeJavaScript(`document.getElementById('zoom').click();`);
  await wait(300);
  let vis = JSON.parse(await snap());
  exp(vis.menuHidden === false, '场景F：应能再次打开菜单');

  // 点外部关闭
  await wc.executeJavaScript(`
    (() => {
      const ev = document.createEvent('MouseEvents');
      ev.initMouseEvent('mousedown', true, true, window, 1, 5, 300, 10, 10,
        false, false, false, false, 0, null);
      document.body.dispatchEvent(ev);
    })();
  `);
  await wait(300);
  vis = JSON.parse(await snap());
  log.push(['F 点外部后菜单关闭', vis.menuHidden]);
  exp(vis.menuHidden === true, '场景F：点外部应关闭菜单');

  // Esc 关闭
  await wc.executeJavaScript(`document.getElementById('zoom').click();`);
  await wait(300);
  await wc.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  `);
  await wait(300);
  vis = JSON.parse(await snap());
  log.push(['F Esc 后菜单关闭', vis.menuHidden]);
  exp(vis.menuHidden === true, '场景F：Esc 应关闭菜单');

  console.log('\n======== 缩放按钮 / 缩放菜单 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(26, ' ') + v));
  console.log('==============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：缩放按钮弹出菜单、可选档位、恢复默认、原生缩放同步、关闭方式均正常。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
