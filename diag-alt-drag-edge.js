'use strict';

/**
 * 诊断：用**真实主进程**（require main.js）复现「Alt 拖动到屏幕边缘时窗口变大」。
 *
 * 【为什么必须用真实 main.js】
 * 之前自己造窗口时，应用的 Alt 拖动链路是断的
 * （没有 ipcMain.handle('mb-window-drag-start') → beginDrag 不会被调用），
 * 所以窗口连动都不动，什么也测不出来。
 *
 * 【要验证的机制】
 * 约束修正让窗口到屏幕边缘就停住 → 鼠标继续外移 → 滑出窗口边缘 →
 * 命中 Chromium 的不可见 resize 边框 → 窗口变大。
 * 而 will-resize 拦截的条件是 activeWin === win，
 * 一旦拖动期间发生 blur（renderer 侧 'blur' → end → stopPolling →
 * activeWin = null），拦截就失效了。
 *
 * 用法：MB_DRAG_DEBUG=1 node diag-alt-drag-edge.js
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PS = path.join(ROOT, 'tools', 'do-alt-drag.ps1');

// 直接加载真实 main.js，让它创建真实主窗口并注册全部 ipcMain 处理
require(path.join(ROOT, 'main.js'));

const { app, BrowserWindow, screen } = require('electron');

app.whenReady().then(async () => {
  // 等 main.js 创建窗口
  let win = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const list = BrowserWindow.getAllWindows();
    if (list.length) { win = list[0]; break; }
  }
  if (!win) { console.log('NO_WINDOW'); app.quit(); return; }

  await wait(2500);

  // 记录 will-resize
  let willResize = 0, prevented = 0;
  let blockResize = true;
  win.on('will-resize', (e) => {
    willResize++;
    if (!blockResize) return;
    e.preventDefault();
    prevented++;
  });

  const area = screen.getPrimaryDisplay().workArea;
  // ★ 构造用户的场景：窗口宽度**超过屏幕工作区宽度**。
  // 一旦窗口比屏幕宽，约束就会允许它大部分出屏 → 鼠标滑到窗口外 →
  // 命中 Chromium 的不可见 resize 边框 → 窗口继续变大（正反馈）。
  if (process.env.MB_WIDE_WINDOW === '1') {
    win.setBounds({ x: 100, y: 100, width: area.width + 260, height: area.height - 60 });
    console.log('已把窗口拉宽到超过屏幕宽度: ' + (area.width + 260));
  } else {
    win.setPosition(200, 150);
  }
  await wait(600);
  win.focus();
  win.moveTop();
  await wait(800);

  const b0 = win.getBounds();
  console.log('屏幕工作区: ' + area.width + 'x' + area.height);
  console.log('初始 bounds: x=' + b0.x + ' y=' + b0.y + ' w=' + b0.width + ' h=' + b0.height);

  // 鼠标从内容区中部起拖，一路拖到**屏幕右边缘之外**
  const sx = b0.x + Math.floor(b0.width / 2);
  const sy = b0.y + Math.floor(b0.height / 2);
  console.log('鼠标起点(屏幕): ' + sx + ',' + sy);

  const samples = [];
  let done = false;
  const sampler = (async () => {
    while (!done) { samples.push(win.getBounds()); await wait(40); }
  })();

  const out = await new Promise((resolve) => {
    const c = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS,
      '-StartX', String(sx), '-StartY', String(sy),
      // 步长必须小：鼠标要「停在」窗口边缘附近才会命中 resize 热区，
      // 一步跨过去就漏掉了（真实拖动是连续的，会在边缘附近停留若干帧）。
      '-Steps', String(process.env.MB_STEPS || '180'), '-Dx', String(process.env.MB_DX || '10'), '-Dy', '1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let o = '';
    c.stdout.on('data', (d) => { o += d.toString(); });
    c.on('close', () => resolve(o.trim()));
  });
  done = true;
  await sampler;
  await wait(500);

  console.log('\n拖动过程中的尺寸变化：');
  let prev = samples[0] || b0;
  let changes = 0;
  for (const s of samples) {
    if (s.width !== prev.width || s.height !== prev.height) {
      changes++;
      console.log('  x=' + String(s.x).padEnd(6) + ' y=' + String(s.y).padEnd(6) +
        ' w=' + String(s.width).padEnd(6) + ' h=' + String(s.height).padEnd(6) +
        '   dW=' + (s.width - prev.width) + ' dH=' + (s.height - prev.height));
    }
    prev = s;
  }
  if (!changes) console.log('  （尺寸全程未变化）');

  const b1 = win.getBounds();
  console.log('\n末尾 bounds: x=' + b1.x + ' y=' + b1.y + ' w=' + b1.width + ' h=' + b1.height);
  console.log('尺寸变化次数: ' + changes + '  dW=' + (b1.width - b0.width) + ' dH=' + (b1.height - b0.height));
  console.log('窗口移动: dx=' + (b1.x - b0.x) + ' dy=' + (b1.y - b0.y));
  console.log('will-resize: ' + willResize + '  preventDefault: ' + prevented);
  console.log('拖动脚本: ' + out);

  console.log('\n结论: ' + (changes > 0
    ? '>>> 复现了「Alt 拖动到屏幕边缘时窗口变大」'
    : '>>> 未复现'));

  // ---------- 回归验证：拖动结束后，窗口仍应能手动 resize ----------
  // 拖动期间用了 setResizable(false) 消除边框热区，
  // 结束时必须恢复，否则用户就再也手动改不了窗口大小了。
  console.log('\n--- 回归：拖动结束后手动 resize ---');
  await wait(800);
  // 放开本脚本自己的 will-resize 拦截 —— 否则测的是拦截器，不是 setResizable 的恢复
  blockResize = false;
  // 先把窗口放回屏幕内（否则右下角在屏幕外，鼠标够不着，
  // 测不出 resize 是否恢复 —— 那是几何原因，不是 setResizable 的问题）
  const area2 = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area2.x + 60, y: area2.y + 60, width: 900, height: 600 });
  await wait(600);
  // 必须重新置前：窗口不在前台时，边框命中测试（WM_NCHITTEST）不生效，
  // 拖右下角根本不会触发 resize（之前踩过这个坑）。
  win.focus();
  win.moveTop();
  await wait(800);
  const b2 = win.getBounds();
  console.log('拖动结束 bounds: w=' + b2.width + ' h=' + b2.height +
    '  isResizable=' + win.isResizable());

  const sx2 = b2.x + b2.width - 2;
  const sy2 = b2.y + b2.height - 2;
  await new Promise((resolve) => {
    const c = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'tools', 'do-edge-drag.ps1'),
      '-StartX', String(sx2), '-StartY', String(sy2), '-Steps', '12', '-Dx', '8', '-Dy', '8',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    c.on('close', () => resolve());
  });
  await wait(600);
  const b3 = win.getBounds();
  console.log('手动 resize 后: w=' + b3.width + ' h=' + b3.height +
    '   dW=' + (b3.width - b2.width) + ' dH=' + (b3.height - b2.height));
  console.log((b3.width !== b2.width || b3.height !== b2.height)
    ? '>>> 通过：拖动结束后仍可手动 resize'
    : '>>> 失败：拖动结束后窗口无法再手动 resize（setResizable 未恢复）');

  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
