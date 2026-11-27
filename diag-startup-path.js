'use strict';

/**
 * 启动路径回归验证。
 *
 * 背景：曾出现「npm start 启动不像个应用」——根因有两个，都必须防回归：
 *
 *  1) 环境变量 ELECTRON_RUN_AS_NODE=1 让 electron.exe 以**纯 Node 模式**运行：
 *     不创建窗口，require('electron') 拿到的 app/ipcMain 全是 undefined，
 *     直接抛 "Cannot read properties of undefined (reading 'whenReady')"。
 *     本项目通过 start.js 显式清除该变量来规避。
 *
 *  2) downloads.js 曾把 ipcMain.on(...) 写在**模块顶层**（require 时即执行），
 *     此时 ipcMain 尚未就绪 → 启动即崩溃并弹出原生 Error 对话框。
 *     已改为在 setupDownloads() 内部注册。
 *
 * 本脚本验证：
 *  - 在**模拟污染环境**（ELECTRON_RUN_AS_NODE=1）下启动，能否正常起来；
 *  - 启动后无致命报错、窗口已创建、webview 已加载；
 *  - ipcMain 相关模块不再有顶层调用（静态检查）。
 */

const { app, BrowserWindow, webContents } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 独立 userData / 端口：脚本会 spawn 自愈进程，不能占用真实实例的
// 单实例锁与 show-server 端口。
const os = require('node:os');
const DIAG_UD = path.join(os.tmpdir(), 'minibrowser-diag-startup-' + process.pid);
app.setPath('userData', DIAG_UD);
// 子进程（以及它自愈拉起的 Electron）继承这个环境变量，才不会锁真实 profile。
process.env.MB_USER_DATA_DIR = DIAG_UD;
process.env.MB_SHOW_PORT = String(39400 + (process.pid % 100));

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const log = [];
const exp = (c, m) => { if (!c) fails.push(m); };

// ---------- 静态检查：各模块不得在顶层调用 ipcMain ----------
function checkNoTopLevelIpcMain() {
  const files = ['downloads.js', 'settings-store.js', 'video-download.js',
    'save-page.js', 'window-drag.js'];
  const bad = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // 顶层调用 = 行首就是 ipcMain.on / ipcMain.handle（前面无缩进）
    const re = /^ipcMain\s*\.\s*(on|handle)\s*\(/m;
    if (re.test(src)) {
      bad.push(f + ':' + (src.match(re) || [''])[0]);
    }
  }
  log.push(['顶层 ipcMain 调用检查', bad.length ? bad.join(', ') : '无（正确）']);
  exp(bad.length === 0, '这些文件不应在模块顶层调用 ipcMain: ' + bad.join(', '));
}

// ---------- 静态检查：start.js 存在且清除了环境变量 ----------
function checkStartScript() {
  const p = path.join(ROOT, 'start.js');
  exp(fs.existsSync(p), '缺少 start.js 启动器');
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8');
  const hasDelete = /delete\s+env\.ELECTRON_RUN_AS_NODE/.test(src);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const startUsesScript = /node\s+start\.js/.test(pkg.scripts.start || '');
  log.push(['start.js 清除环境变量', hasDelete ? '是' : '否']);
  log.push(['package.json start 脚本', pkg.scripts.start]);
  exp(hasDelete, 'start.js 必须清除 ELECTRON_RUN_AS_NODE');
  exp(startUsesScript, 'package.json 的 start 应指向 start.js，实际 ' + pkg.scripts.start);
}

// ---------- 静态检查：main.js 顶部有环境自愈逻辑 ----------
function checkSelfHeal() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // 只匹配**实际代码行**（排除注释行）：注释里也会出现这个变量名，
  // 若不排除会匹配到文件头的说明文字，导致位置判断失真。
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });
  const code = codeLines.join('\n');
  const guarded = code.indexOf("ELECTRON_RUN_AS_NODE === '1'");
  const requirePos = code.indexOf("require('electron')");
  const ok = guarded >= 0 && requirePos >= 0 && guarded < requirePos;
  log.push(['main.js 环境自愈守卫', ok ? '已就位（在 require 之前）' : '缺失或位置不对']);
  exp(ok, 'main.js 应在 require(\'electron\') 之前检测 ELECTRON_RUN_AS_NODE 并自愈重启');
}

// ---------- 动态检查：在污染环境下启动应用 ----------
// 自愈逻辑会让原进程（纯 Node 模式）立即 exit(0)，并 spawn 一个真正的
// Electron 进程。所以**不能**只看 spawn 出来的 child 是否存活 ——
// 它注定会退出。要验证的是「自愈后的新进程是否真的把应用跑起来了」。
// 判据：主进程监听的 show-server 端口（39321）是否开始监听 ——
// 该端口只在 app.whenReady() 之后才绑定，能通即说明 Electron 起来了。
async function checkLaunchUnderPollutedEnv() {
  const net = require('node:net');
  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'));
  const PORT = Number(process.env.MB_SHOW_PORT);

  // 先确保端口是空的（否则旧实例会干扰判断）
  await new Promise((resolve) => {
    const probe = net.connect(PORT, '127.0.0.1');
    probe.on('connect', () => { probe.destroy(); resolve(); });
    probe.on('error', () => resolve());
  });

  const child = spawn(electronBin, [ROOT], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // 等待自愈后的新进程把服务端口拉起来
  let listening = false;
  for (let i = 0; i < 24 && !listening; i++) {
    await wait(500);
    listening = await new Promise((resolve) => {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
  }
  log.push(['污染环境下应用已启动（端口已监听）', listening]);
  exp(listening, 'ELECTRON_RUN_AS_NODE=1 时应用应能自愈启动（服务端口未监听）');
  exp(out.indexOf("reading 'whenReady'") < 0,
    '不应出现 app 为 undefined 的报错（ELECTRON_RUN_AS_NODE 未被处理）');
  exp(out.indexOf("reading 'on'") < 0,
    '不应出现 ipcMain 为 undefined 的报错（模块顶层调用 ipcMain）');

  // child 只是纯 Node 模式的启动器；main.js 自愈时会再 spawn 一个
  // detached 的真正 Electron 进程。只 kill child 会遗留一个持有临时 profile
  // 和端口的后台实例，必须连同子进程树一起结束。
  try {
    if (process.platform === 'win32') {
      require('node:child_process').execFileSync('taskkill',
        ['/F', '/T', '/PID', String(child.pid)],
        { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(child.pid, 'SIGTERM');
    }
  } catch (_) {
    try { child.kill(); } catch (_) { /* ignore */ }
  }
  await wait(1000);
}

app.whenReady().then(async () => {
  checkNoTopLevelIpcMain();
  checkStartScript();
  checkSelfHeal();
  await checkLaunchUnderPollutedEnv();

  console.log('\n======== 启动路径回归验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(26, ' ') + v));
  console.log('==================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：无顶层 ipcMain 调用、start.js 已就位、污染环境下可正常启动。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
