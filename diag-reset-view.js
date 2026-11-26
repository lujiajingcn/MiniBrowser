'use strict';

/**
 * 诊断：命令行开关 `show.js normal` 能否关掉透明/无框模式。
 *
 * 【覆盖】
 *   A 先把透明+完全透明+无框全部打开，再运行 show.js normal
 *   B 渲染层 class 与 localStorage 状态都被清空并持久化
 *   C reset 作为同义词同样有效
 *
 * 用法：node diag-reset-view.js（由 Electron 运行）
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PORT = '39323';
process.env.MB_USER_DATA_DIR = path.join(os.tmpdir(), 'minibrowser-diag-reset-view');
process.env.MB_SHOW_PORT = PORT;

// 加载真实 main.js：show-server 与 normal 命令都在里面
require(path.join(ROOT, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_STATE = `(function () {
  return JSON.stringify({
    cls: document.body.className,
    transparent: localStorage.getItem('mb_transparent'),
    full: localStorage.getItem('mb_full_transparent'),
    frameless: localStorage.getItem('mb_frameless'),
    frameless2: localStorage.getItem('mb_frameless2'),
    bg: getComputedStyle(document.body).backgroundColor,
  });
})()`;

const TURN_ON = `(function () {
  applyFullTransparent(true);
  applyTransparent(true);
  applyFrameless2(true);
  applyFrameless(true);
  return 'on';
})()`;

function isNormal(s) {
  const classes = s.cls.split(/\s+/).filter(Boolean);
  return !classes.some((c) => /transparent|frameless/.test(c)) &&
    s.transparent === '0' && s.full === '0' &&
    s.frameless === '0' && s.frameless2 === '0' &&
    s.bg !== 'rgba(0, 0, 0, 0)';
}

function runShowJs(cmd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'show.js'), cmd], {
      cwd: ROOT,
      env: { ...process.env, MB_SHOW_PORT: PORT, MB_CONSOLE_ENCODING: 'utf8', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', () => resolve(out.trim()));
  });
}

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  let win = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const list = BrowserWindow.getAllWindows();
    if (list.length) { win = list[0]; break; }
  }
  if (!win) { console.log('NO_WINDOW'); app.quit(); return; }
  await wait(1500);

  for (const cmd of ['normal', 'reset']) {
    await win.webContents.executeJavaScript(TURN_ON);
    const before = JSON.parse(await win.webContents.executeJavaScript(READ_STATE));
    const out = await runShowJs(cmd);
    await wait(400);
    const after = JSON.parse(await win.webContents.executeJavaScript(READ_STATE));

    log.push([cmd + ' 前', JSON.stringify(before)]);
    log.push([cmd + ' 输出', out.replace(/\n/g, ' | ')]);
    log.push([cmd + ' 后', JSON.stringify(after)]);
    exp(!isNormal(before), cmd + '：前置状态应是非普通视图');
    exp(out.includes('已恢复普通视图'), cmd + '：show.js 应提示恢复成功，实际：' + out);
    exp(isNormal(after), cmd + '：命令后应回到普通视图（class/localStorage 均清空）');
  }

  console.log('\n======== show.js normal 恢复普通视图 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(14, ' ') + v));
  console.log('==================================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：normal 与 reset 都能关掉透明/无框并持久化。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
