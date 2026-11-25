'use strict';

/**
 * MiniBrowser 启动器。
 *
 * 解决的问题：某些开发环境（尤其是嵌在别的 Electron 应用里跑、或由
 * CI/IDE 包装过的终端）会在环境里注入 ELECTRON_RUN_AS_NODE=1。
 * 这个变量让 electron.exe **以纯 Node 的方式运行**，于是：
 *   - 不会创建 BrowserWindow，应用窗口根本不出现；
 *   - main.js 里的 require('electron') 拿到的 app/ipcMain 全是 undefined，
 *     直接抛 "Cannot read properties of undefined (reading 'whenReady')"；
 *   - 表现就是「跑起来不像个应用」，而是一堆 Node 报错。
 *
 * 所以这里显式清掉该变量再拉起 electron。
 *
 * 附带作用：让 npm start 在 Windows 上不再弹出黑色控制台窗口。
 * Electron 的 electron.exe 是 GUI 子系统程序，用 detached + windowsHide
 * 拉起时不会附带控制台窗口；stdio 设为 'ignore' 让 console.log 不再
 * 刷屏到控制台（需要看日志时用 npm run start:log）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { writeErrLine } = require('./console-encoding');

const ROOT = __dirname;
const QUIET = process.env.MB_START_QUIET === '1';

// 定位 electron 可执行文件。优先用 electron 模块自带的路径，
// 这样不依赖 node_modules/.bin 下的 shim（Windows 上那里是 .cmd，
// 经 cmd 启动会再带出一个控制台窗口）。
function resolveElectron() {
  try {
    const p = require(path.join(ROOT, 'node_modules', 'electron'));
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (_) {
    /* 落到下面的兜底 */
  }
  // 兜底：node_modules/.bin/electron.cmd
  const bin = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  );
  if (fs.existsSync(bin)) return bin;
  return null;
}

function main() {
  const electron = resolveElectron();
  if (!electron) {
    writeErrLine('[start] 找不到 electron 可执行文件，请先执行 npm install');
    process.exit(1);
  }

  // 关键：清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会以纯 Node 模式运行
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // 透传常用参数（如 --disable-gpu）
  const extraArgs = process.argv.slice(2);
  const args = extraArgs.length ? extraArgs : [ROOT];

  const child = spawn(electron, args, {
    cwd: ROOT,
    env,
    // Windows：隐藏子进程窗口（不弹黑控制台）；其余平台忽略
    windowsHide: true,
    // 分离进程，父进程退出后应用继续运行
    detached: process.platform !== 'win32',
    stdio: QUIET ? 'ignore' : 'inherit',
  });

  child.on('error', (e) => {
    writeErrLine('[start] 启动失败：', e && e.message);
    process.exit(1);
  });

  if (process.platform === 'win32') {
    // Windows 上不 unref：让父进程等子进程结束，
    // 这样 npm start 的终端能显示退出码与日志。
    child.on('exit', (code) => process.exit(code == null ? 0 : code));
  } else {
    child.unref();
  }
}

main();
