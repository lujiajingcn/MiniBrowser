'use strict';

/**
 * 诊断：「钉在桌面」按钮（窗口置顶但不抢焦点）。
 *
 * 覆盖：
 *   A 按钮存在，点击后 aria-pressed 变 true
 *   B 主进程窗口确实进入置顶状态（isAlwaysOnTop）
 *   C **置顶不抢焦点** —— 这是「钉在桌面」区别于「抢焦点置顶」的关键
 *   D 再次点击取消置顶，按钮态回到 false
 *   E 状态持久化（localStorage）
 *   F 主进程的 always-on-top-changed 能通知回渲染层
 *   G 右键菜单里有「钉在桌面」入口（无框模式下工具栏隐藏时的替代入口）
 *
 * 用法：node diag-pin.js
 */

const path = require('node:path');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 【为什么必须加载真实 main.js】
// 'mb-pin-window' 的 ipcMain.handle 注册在 main.js 里。
// 自己造窗口时没有注册处理器，invoke 会报
// "No handler registered for 'mb-pin-window'" —— 那是测试环境的问题，不是功能的。
//
// 【为什么要独立的 userData】
// 单实例锁依赖 userData 路径。用户可能正开着应用，
// 共用同一目录会导致本脚本抢不到锁、直接退出。
// MB_USER_DATA_DIR 让本实例用独立目录，与用户的实例互不干扰。
process.env.MB_USER_DATA_DIR = path.join(require('node:os').tmpdir(), 'minibrowser-diag-pin');
process.env.MB_SHOW_PORT = process.env.MB_SHOW_PORT || '39323';
require(path.join(ROOT, 'main.js'));

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  // 等 main.js 创建真实主窗口
  let win = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const list = BrowserWindow.getAllWindows();
    if (list.length) { win = list[0]; break; }
  }
  if (!win) { console.log('NO_WINDOW'); app.quit(); return; }
  const wc = win.webContents;
  await wait(2500);
  win.focus();
  await wait(400);

  const btnState = () => wc.executeJavaScript(`
    (() => {
      const b = document.getElementById('pin');
      return JSON.stringify({
        exists: !!b,
        pressed: b ? b.getAttribute('aria-pressed') : null,
        title: b ? b.title : null,
        stored: (() => { try { return localStorage.getItem('mb_pinned'); } catch (e) { return 'n/a'; } })(),
        pinnedVar: (typeof isWindowPinned === 'function') ? isWindowPinned() : null,
      });
    })();
  `);

  // ---------- A. 初始 ----------
  let s = JSON.parse(await btnState());
  log.push(['初始 按钮', JSON.stringify(s)]);
  exp(s.exists, '场景A：应存在 #pin 按钮');
  exp(s.pressed === 'false', '场景A：初始应为未激活，实际 ' + s.pressed);

  // ---------- B/C. 点击置顶，并检查是否抢焦点 ----------
  // 先让焦点在窗口上，再点按钮；置顶**不应**改变焦点状态
  win.focus();
  await wait(300);
  const focusedBefore = win.isFocused();

  await wc.executeJavaScript(`document.getElementById('pin').click();`);
  await wait(900);

  const isOnTop = win.isAlwaysOnTop();
  const focusedAfter = win.isFocused();
  s = JSON.parse(await btnState());
  log.push(['点击后 按钮', JSON.stringify(s)]);
  log.push(['主进程 isAlwaysOnTop', isOnTop]);
  log.push(['焦点 点击前/后', focusedBefore + ' → ' + focusedAfter]);

  exp(s.pressed === 'true', '场景A：点击后 aria-pressed 应为 true，实际 ' + s.pressed);
  exp(s.pinnedVar === true, '场景A：isWindowPinned() 应为 true，实际 ' + s.pinnedVar);
  exp(isOnTop === true, '场景B：主进程窗口应处于置顶状态，实际 ' + isOnTop);
  // ★ 关键：置顶不应抢焦点
  exp(focusedBefore === focusedAfter,
    '场景C：置顶不应改变焦点状态，实际 ' + focusedBefore + ' → ' + focusedAfter);

  // ---------- E. 持久化 ----------
  exp(s.stored === '1', '场景E：localStorage 应记录 mb_pinned=1，实际 ' + s.stored);

  // ---------- F. 主进程通知回渲染层 ----------
  // 直接从主进程改置顶状态，渲染层应收到的通知并同步按钮态
  await wc.executeJavaScript(`
    (() => { window.__pinNotify = null; })();
  `);
  // 让主进程模拟一次外部改动
  win.setAlwaysOnTop(false);
  await wait(700);
  s = JSON.parse(await btnState());
  log.push(['主进程取消置顶后 按钮', JSON.stringify(s)]);
  exp(s.pressed === 'false', '场景F：主进程改置顶状态后按钮应同步，实际 ' + s.pressed);

  // ---------- D. 再点一次取消 ----------
  await wc.executeJavaScript(`document.getElementById('pin').click();`);
  await wait(700);
  s = JSON.parse(await btnState());
  log.push(['再点后 按钮', JSON.stringify(s)]);
  exp(s.pressed === 'true', '场景D：再点应重新置顶，实际 ' + s.pressed);
  exp(win.isAlwaysOnTop() === true, '场景D：再点后应处于置顶状态');

  await wc.executeJavaScript(`document.getElementById('pin').click();`);
  await wait(700);
  s = JSON.parse(await btnState());
  exp(s.pressed === 'false', '场景D：第三次点击应取消置顶，实际 ' + s.pressed);
  exp(win.isAlwaysOnTop() === false, '场景D：取消后不应再置顶');

  // ---------- G. 右键菜单入口 ----------
  const menuHasPin = await wc.executeJavaScript(`
    (() => {
      showPageContextMenu(300, 300);
      const items = Array.from(document.querySelectorAll('#context-menu-list li'))
        .map(li => li.textContent);
      hideContextMenu();
      return items.some(t => /钉在桌面/.test(t)) ? 'yes' : items.join('|');
    })();
  `);
  log.push(['右键菜单含钉住项', menuHasPin]);
  exp(menuHasPin === 'yes', '场景G：右键菜单应含「钉在桌面」项，实际 ' + menuHasPin);

  console.log('\n======== 钉在桌面（窗口置顶）验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(24, ' ') + v));
  console.log('============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：置顶生效、不抢焦点、可取消、状态同步与持久化正常。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
