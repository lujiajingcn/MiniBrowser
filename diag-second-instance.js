'use strict';

/**
 * 诊断：「窗口被隐藏后，再次启动能否把它唤回来」。
 *
 * 【为什么测这个】
 * 应用有「隐藏窗口」功能（右键菜单 → 隐藏窗口，setSkipTaskbar(true) + hide()）。
 * 隐藏之后进程还在跑，于是：
 *   - 再跑 npm start → 第二个实例抢不到单实例锁 → 静默 exit(0)；
 *   - 而第一个实例收到 second-instance 事件后要能把窗口 show 回来。
 *
 * 如果 second-instance 只调 show() 而没有 setSkipTaskbar(false)，
 * 任务栏入口仍是隐藏的，用户依然找不到窗口 —— 表现为「npm start 打不开浏览器」。
 *
 * 用法：node diag-second-instance.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const log = [];
const exp = (c, m) => { if (!c) fails.push(m); };

// 独立 userData + 独立端口：不影响用户正在运行的实例
process.env.MB_USER_DATA_DIR = path.join(os.tmpdir(), 'minibrowser-diag-second');
process.env.MB_SHOW_PORT = '39341';

// 加载真实 main.js：窗口与 single-instance 逻辑都在里面，
// 自己造窗口测不到 second-instance 的真实行为。
require(path.join(ROOT, 'main.js'));

const PORT = 39341;

function portBusy() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

app.whenReady().then(async () => {
  // 等主窗口创建
  let win = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const list = BrowserWindow.getAllWindows();
    if (list.length) { win = list[0]; break; }
  }
  if (!win) { console.log('NO_WINDOW'); app.quit(); return; }
  await wait(2000);

  // ---------- 模拟「隐藏窗口」----------
  win.setSkipTaskbar(true);
  win.hide();
  await wait(800);
  log.push(['隐藏后 isVisible', String(win.isVisible())]);
  log.push(['隐藏后 isMinimized', String(win.isMinimized())]);
  exp(win.isVisible() === false, '前置：窗口应已被隐藏');

  // ---------- 启动第二个实例 ----------
  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electronBin, [ROOT], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // 等第二个实例触发本实例的 second-instance 事件
  await wait(9000);
  log.push(['第二实例输出', out.trim().split('\n').slice(-3).join(' | ')]);
  log.push(['唤起后 isVisible', String(win.isVisible())]);
  log.push(['唤起后 isMinimized', String(win.isMinimized())]);
  try {
    log.push(['唤起后 skipTaskbar', String(win.isSkipTaskbar())]);
  } catch (_) {
    /* ignore */
  }

  exp(win.isVisible() === true, '场景：second-instance 应把隐藏的窗口重新显示出来');
  exp(win.isMinimized() === false, '场景：second-instance 应把最小化的窗口还原');

  console.log('\n======== second-instance 唤起隐藏窗口 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(22, ' ') + v));
  console.log('==================================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：隐藏的窗口能被第二个实例唤回。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
