'use strict';

/**
 * 诊断：验证 Electron 的 `will-resize` 在「真实鼠标拖窗口边缘」时
 * 到底会不会触发、preventDefault 能不能挡住。
 *
 * 【为什么必须用真实鼠标】
 * 之前的实验用 PowerShell 注入鼠标，但鼠标起点在窗口正中、
 * 且窗口被约束在屏幕内 —— 鼠标始终碰不到窗口边缘，
 * Chromium 的边框 resize 热区根本没被命中，所以「窗口不变大」是假象。
 *
 * 这次把鼠标精确放到窗口**右下角**（边框热区），
 * 用真实 mouse_event 拖动，并同时观察：
 *   - will-resize 是否触发
 *   - 窗口尺寸是否真的变了
 *
 * 用法：node diag-resize-edge.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PS = path.join(ROOT, 'tools', 'do-edge-drag.ps1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 600, show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  let willResize = 0;
  let prevented = 0;
  const seen = [];
  win.on('will-resize', (e, b) => {
    willResize++;
    if (seen.length < 6) seen.push(JSON.stringify(b));
    if (PREVENT) {
      e.preventDefault();
      prevented++;
    }
  });

  // PREVENT 由环境变量控制，方便对照「拦截 / 不拦截」两种情况
  const PREVENT = process.env.MB_NO_PREVENT !== '1';
  // RESIZABLE_LOCK=1 时用 setResizable(false) 彻底锁死边框热区
  const LOCK = process.env.MB_RESIZABLE_LOCK === '1';

  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);
  win.setPosition(300, 200);
  await wait(600);

  if (LOCK) {
    win.setResizable(false);
    console.log('已 setResizable(false)');
    await wait(500);
  }

  // 探针：确认注入的鼠标事件到底有没有到达这个窗口。
  // （之前发现过「注入的鼠标送达不到 Electron 窗口」的坑，必须先确认这一条。）
  const wc = win.webContents;
  await wc.executeJavaScript(`
    window.__probe = { move: 0, down: 0, up: 0, lastX: 0, lastY: 0 };
    window.addEventListener('mousemove', (e) => {
      window.__probe.move++; window.__probe.lastX = e.clientX; window.__probe.lastY = e.clientY;
    }, true);
    window.addEventListener('mousedown', () => { window.__probe.down++; }, true);
    window.addEventListener('mouseup', () => { window.__probe.up++; }, true);
  `);
  win.focus();
  win.moveTop();
  await wait(500);

  const b0 = win.getBounds();
  console.log('PREVENT = ' + PREVENT + '   LOCK(setResizable=false) = ' + LOCK);
  console.log('初始 bounds: x=' + b0.x + ' y=' + b0.y + ' w=' + b0.width + ' h=' + b0.height);

  // 鼠标放到窗口右下角（边框热区），向外拖 120px
  const sx = b0.x + b0.width - 2;
  const sy = b0.y + b0.height - 2;
  console.log('鼠标起点(屏幕): ' + sx + ',' + sy + '（窗口右下角）');

  const out = await new Promise((resolve) => {
    const c = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS,
      '-StartX', String(sx), '-StartY', String(sy), '-Steps', '20',
      '-Dx', '8', '-Dy', '8',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let o = '';
    c.stdout.on('data', (d) => { o += d.toString(); });
    c.on('close', () => resolve(o.trim()));
  });
  console.log('拖动脚本: ' + out);
  await wait(600);

  const b1 = win.getBounds();
  console.log('末尾 bounds: x=' + b1.x + ' y=' + b1.y + ' w=' + b1.width + ' h=' + b1.height);
  console.log('尺寸变化: dW=' + (b1.width - b0.width) + ' dH=' + (b1.height - b0.height));
  console.log('will-resize 触发次数: ' + willResize + '（preventDefault ' + prevented + ' 次）');
  const probe = await wc.executeJavaScript('JSON.stringify(window.__probe)');
  console.log('鼠标事件探针: ' + probe + '   <- move/down 为 0 说明注入的鼠标压根没到窗口');
  seen.forEach((s) => console.log('  will-resize ' + s));

  console.log('\n结论: ' + ((b1.width !== b0.width || b1.height !== b0.height)
    ? '>>> 窗口变大了 —— 防护失效'
    : (willResize === 0
      ? '>>> will-resize 根本没触发（边框热区已被锁死）'
      : '>>> will-resize 触发且成功拦截')));

  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
