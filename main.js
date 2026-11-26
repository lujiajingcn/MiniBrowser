'use strict';

/**
 * ---------- 环境自愈：ELECTRON_RUN_AS_NODE ----------
 *
 * 某些开发环境（嵌在别的 Electron 应用里跑、被 IDE/CI 包装过的终端）
 * 会在环境里注入 ELECTRON_RUN_AS_NODE=1。这个变量让 electron.exe
 * **以纯 Node 的方式运行**：不创建窗口，且 require('electron') 返回的
 * 是普通 Node 模块 —— app / ipcMain / BrowserWindow 全是 undefined，
 * 于是 main.js 直接抛 "Cannot read properties of undefined (reading 'whenReady')"，
 * 表现为「跑起来不像个应用」。
 *
 * 注意：必须在 require('electron') **之前**判断 —— 一旦 require 了，
 * 再去判断就晚了（electron 模块已被加载，且是残缺的 Node 版本）。
 * 这里用 process.env 提前判断，并用动态 require 避开顶层解构。
 */
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  // 【打包后不能自动重启】
  // 打包产物里应用代码在 app.asar 内，__dirname 指向 asar 内部路径，
  // 拿它当「应用路径」重新拉起是错的（会启动出一个空白实例）。
  // 而且打包后的 exe 是给最终用户用的，不该在用户眼前弹控制台报错。
  // 所以：仅在**开发模式**（未打包）下自愈重启；
  // 打包后遇到该变量直接退出，并在临时目录留下说明。
  const isPackaged = __dirname.indexOf('app.asar') >= 0;

  if (isPackaged) {
    try {
      require('node:fs').appendFileSync(
        require('node:path').join(require('node:os').tmpdir(), 'minibrowser-start-error.log'),
        '[MiniBrowser] 检测到 ELECTRON_RUN_AS_NODE=1，已退出。' +
          '该环境变量会让 Electron 以纯 Node 模式运行，无法创建窗口。\r\n'
      );
    } catch (_) {
      /* ignore */
    }
    process.exit(1);
  }

  // 开发模式：清理环境变量并重新拉起真正的 Electron 进程。
  // 用 spawn 而非 execFileSync：前者不阻塞，且能让新进程脱离当前终端。
  const { spawn } = require('node:child_process');
  const { execPath } = process;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(execPath, [__dirname], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    // 不再往下走：当前进程以纯 Node 模式运行，留着也没用
    process.exit(0);
  } catch (e) {
    // 拉起失败时只能提示（此时已无 Electron API 可用）
    writeErrLine('[main] 清除 ELECTRON_RUN_AS_NODE 后重新启动失败：', e && e.message);
    process.exit(1);
  }
}

// 到这里才安全地 require electron
const { app, BrowserWindow, webContents, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { setupDownloads } = require('./downloads');
const { setupSettingsIpc } = require('./settings-store');
const { setupVideoDownloads } = require('./video-download');
const { setupSavePage } = require('./save-page');
const { buildNetscapeBookmarks } = require('./bookmarks-io');
const { writeLine, writeErrLine } = require('./console-encoding');
const { setupWindowDrag } = require('./window-drag');

/**
 * ---------- 独立的用户数据目录 ----------
 *
 * 开发模式与打包版若共用同一个 userData 目录会互相踩：
 * 开发模式的 Electron 默认用 %APPDATA%\Electron，打包版用 %APPDATA%\<产品名>；
 * 但只要产品名撞上（或开发者手工指定过路径），两边就会抢同一份
 * Chromium 缓存，表现为打包版启动时报
 *   "Unable to move the cache: 拒绝访问 (0x5)" / "Unable to create cache"，
 * 窗口起不来。
 *
 * 这里给打包版指定一个专属目录名，与开发模式彻底隔离。
 * 必须在 app ready 之前设置（setPath 对 userData 生效需早于 ready）。
 *
 * MB_USER_DATA_DIR 环境变量可覆盖该路径：单实例锁是**依赖 userData 路径**的，
 * 所以想同时跑第二个实例（例如自动化诊断脚本，而用户的应用还开着）时，
 * 指定一个不同的目录就能绕开锁，互不干扰。
 */
const USER_DATA_DIR = process.env.MB_USER_DATA_DIR
  ? path.resolve(process.env.MB_USER_DATA_DIR)
  : path.join(app.getPath('appData'), 'MiniBrowser');
app.setPath('userData', USER_DATA_DIR);

/**
 * 创建主窗口。
 * 安全配置：关闭 nodeIntegration、开启 contextIsolation，
 * 仅通过 preload 暴露受限的 electronAPI 给渲染进程。
 * @param {boolean} offscreen 是否以离屏渲染模式创建（用于无显示器环境截图）
 */
function createWindow(offscreen) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: !offscreen,
    // transparent:true 让窗口本身支持透明合成（透明模式下桌面可透出）。
    // 注意：开启 transparent 时必须把 backgroundColor 设为透明色，否则整窗仍不透明。
    // 普通模式下各部件（工具栏/网页）自带不透明背景，外观不变，仅“透明模式”才会真正透出桌面。
    transparent: true,
    backgroundColor: '#00000000',
    frame: false, // 无边框：去掉系统原生标题栏，无框模式下网页可铺满整窗
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 允许在渲染进程中使用 <webview> 标签
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: !!offscreen
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 置顶状态变化时通知渲染层：用户可能从系统窗口菜单改过置顶状态，
  // 工具栏上的图钉按钮需要跟着变。
  win.on('always-on-top-changed', (_e, isOnTop) => {
    if (!win.webContents || win.webContents.isDestroyed()) return;
    win.webContents.send('mb-pinned-changed', !!isOnTop);
  });

  // 报告窗口已创建及其位置。
  // 【为什么要有这一行】
  // 「npm start 之后看不到窗口」是最常见的困惑：可能是窗口被隐藏了、
  // 可能跑到屏幕外了、也可能压根没创建出来。
  // 把实际 bounds 打出来，用户一眼就能判断是哪一种 ——
  // 而不是对着黑屏猜。
  try {
    const b = win.getBounds();
    writeLine('[main] 窗口已创建: ' + b.width + 'x' + b.height +
      ' @ (' + b.x + ',' + b.y + ')' +
      (win.isVisible() ? '' : '  [注意：当前不可见]'));
  } catch (_) {
    /* ignore */
  }

  const args = parseLaunchArgs();
  if (args.autoDemo || args.captureOut) {
    runDemoSequence(win, args.captureOut);
  }
  return win;
}

function parseLaunchArgs() {
  // 优先读取环境变量（避免 Windows/Electron CLI 对 -- 参数解析不一致）
  const autoDemo = process.env.AUTO_DEMO === '1' || process.argv.includes('--auto-demo');
  const captureOut = process.env.CAPTURE_OUT || '';
  return { autoDemo, captureOut };
}

async function captureActiveWebview(win, outPath) {
  const wcs = webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview');
  if (!wcs.length) {
    console.log('[capture] no webview');
    return;
  }
  const wc = wcs[wcs.length - 1];

  // 无显示器环境下 <webview> 的 capturePage() 通常是全黑的，因此同时尝试
  // printToPDF()（基于页面 DOM，不依赖 GPU/显示输出）保存为 PDF。
  try {
    const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const pdfPath = outPath.replace(/\.png$/i, '.pdf');
    fs.writeFileSync(pdfPath, pdf);
    console.log('[capture] saved pdf', pdfPath, pdf.length);
  } catch (e) {
    console.log('[capture] printToPDF failed:', e && e.message);
  }

  // 仍然保留 PNG 捕获（正常桌面环境可见）。
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(outPath, img.toPNG());
    const size = img.getSize();
    console.log('[capture] saved png', outPath, size.width + 'x' + size.height);
  } catch (e) {
    console.log('[capture] capturePage failed:', e && e.message);
  }
}

// 诊断辅助：读取当前外壳里的标签数量与各 webview 的 URL
async function tabReport(win) {
  try {
    return await win.webContents.executeJavaScript(
      '(function(){' +
        'var wvs = Array.prototype.slice.call(document.querySelectorAll("webview"));' +
        'return { count: wvs.length, srcs: wvs.map(function(w){ return w.src; }) };' +
        '})()'
    );
  } catch (e) {
    return { count: -1, srcs: [], err: e && e.message };
  }
}

async function runDemoSequence(win, captureOut) {
  await new Promise((r) => setTimeout(r, 3500));

  const before = await tabReport(win);
  console.log('[auto-demo] tabs before =', JSON.stringify(before));

  if (captureOut) {
    await captureActiveWebview(win, captureOut.replace(/\.png$/i, '-before.png'));
  }

  try {
    const res = await win.webContents.executeJavaScript(
      'window.mbAutoDemoClick ? window.mbAutoDemoClick() : "no-fn"'
    );
    console.log('[auto-demo] click result =', res);
  } catch (e) {
    console.log('[auto-demo] err:', e && e.message);
  }

  await new Promise((r) => setTimeout(r, 6000));
  const after = await tabReport(win);
  console.log('[auto-demo] tabs after  =', JSON.stringify(after));
  console.log(
    '[auto-demo] verdict =',
    after.count > before.count
      ? 'NEW_TAB (拦截生效)'
      : JSON.stringify(before.srcs) !== JSON.stringify(after.srcs)
        ? 'NAVIGATE (拦截未生效，原地跳转)'
        : 'NO_OP (点击被吞，无任何反应)'
  );

  if (captureOut) {
    await new Promise((r) => setTimeout(r, 6000));
    await captureActiveWebview(win, captureOut.replace(/\.png$/i, '-after.png'));
    console.log('[capture] all done');
    setTimeout(() => app.quit(), 500);
  }
}

// 本地“显示”服务：仅在 127.0.0.1 监听，接收来自 show.js（cmd 命令行）的 show 指令后，
// 把当前所有已隐藏的窗口重新显示出来。端口固定，作为“指定的命令行”所对应的端点。
// show-server 的端口。可用 MB_SHOW_PORT 覆盖 —— 用户的应用正开着时
// （占用默认端口），自动化诊断脚本用另一个端口即可并存，不会刷 EADDRINUSE 噪音。
const SHOW_PORT = (() => {
  const v = parseInt(process.env.MB_SHOW_PORT || '', 10);
  return v > 0 && v < 65536 ? v : 39321;
})();
const SHOW_HOST = '127.0.0.1';
let _showServerStarted = false;

function setupShowServer() {
  if (_showServerStarted) return;
  _showServerStarted = true;
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 64) {
        socket.end();
        return;
      }
      const cmd = buf.trim();
      if (cmd === 'show') {
        // 把所有窗口显示出来：取消任务栏跳过 + 显示 + 置顶聚焦
        BrowserWindow.getAllWindows().forEach((w) => {
          try {
            w.setSkipTaskbar(false);
            if (!w.isVisible()) w.show();
            w.focus();
          } catch (_) {
            /* ignore */
          }
        });
        socket.write('ok\n');
      } else {
        socket.write('err\n');
      }
      socket.end();
    });
    socket.on('error', () => socket.destroy());
  });
  server.on('error', (e) => {
    // 端口被占用（例如多个实例）/ 权限不足：打印告警但不阻断主流程
    writeErrLine('[show-server] 启动失败：', e && e.message ? e.message : e);
  });
  server.listen(SHOW_PORT, SHOW_HOST, () => {
    writeLine('[show-server] 已启动，监听 ' + SHOW_HOST + ':' + SHOW_PORT +
      '（用时运行 show.js 恢复窗口）');
  });
}

/**
 * ---------- 单实例锁 ----------
 *
 * 正常桌面应用的必备行为：重复双击图标时应该**聚焦已有窗口**，
 * 而不是开出第二个实例。两个实例会互相抢端口（show-server 的 39321）
 * 与 Chromium 缓存目录，表现为「第二个窗口起不来 / 报缓存访问被拒」。
 *
 * 注意：单实例锁依赖 userData 路径，故必须放在 setPath('userData') 之后。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 已有实例在跑，本进程直接退出。
  // 用 process.exit 而不是 app.quit()：app.quit() 只是发起退出请求，
  // 下面的同步代码仍会继续执行（创建窗口、起端口服务），导致
  // 第二个实例照样抢端口与缓存。这里直接结束进程最干脆。
  //
  // 【为什么要打印这一行】
  // 静默 exit(0) 会让「npm start」看起来像「什么都没发生」——
  // 用户完全无从判断是已有实例在跑、还是启动失败了。
  // 已有实例会收到 second-instance 事件并把窗口显示/聚焦出来，
  // 所以这里明确告诉用户「发生了什么、接下来该看哪里」。
  writeLine('[main] 已有实例在运行，本次启动退出；' +
    '已请求已有实例显示窗口（若窗口仍不可见，可运行 node show.js 强制唤起）');
  process.exit(0);
} else {
  app.on('second-instance', () => {
    // 第二次启动：把已有窗口全部显示出来并聚焦
    let shown = 0;
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isMinimized()) w.restore();
      // 窗口被「隐藏窗口」功能隐藏过（setSkipTaskbar(true) + hide()）时，
      // 光 show() 还不够 —— 任务栏入口也要恢复，否则用户依然找不到它。
      if (!w.isVisible()) {
        try {
          w.setSkipTaskbar(false);
        } catch (_) {
          /* ignore */
        }
      }
      w.show();
      w.focus();
      shown++;
    }
    if (shown) writeLine('[main] 已有实例已显示窗口');
  });
}

app.whenReady().then(() => {
  setupDownloads();
  setupSettingsIpc();
  setupVideoDownloads();
  setupSavePage();
  // Alt+左键拖动移动窗口（无边框窗口没有系统标题栏时的替代拖动方式）
  setupWindowDrag();

  // 导出收藏夹：弹出保存对话框，生成 Netscape 书签 HTML 写入磁盘
  ipcMain.handle('mb-export-bookmarks', async (event, bookmarks) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出收藏夹',
      defaultPath: 'bookmarks.html',
      filters: [{ name: 'HTML 书签文件', extensions: ['html'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const html = buildNetscapeBookmarks(bookmarks || [], 'MiniBrowser 收藏夹');
      fs.writeFileSync(filePath, html, 'utf-8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // 无边框窗口的窗口控制：最小化 / 最大化切换 / 关闭（由渲染进程的工具栏按钮或右键菜单触发）
  ipcMain.on('mb-win-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });

  // 「钉在桌面」：窗口置顶但**不抢焦点**。
  //
  // Electron 的 setAlwaysOnTop 文档明确写着「regardless of whether it's
  // focused or not」—— 它只改窗口的 Z 序，不改焦点，
  // 所以用户点图钉之后仍然可以操作下面的窗口，这与 QQ 截图的
  // 「钉在桌面」是同一个语义（区别于「抢焦点置顶」）。
  //
  // level 用 'normal'：置顶窗口排在其他置顶窗口之下，
  // 但仍在普通窗口之上 —— 不会盖住别的应用的置顶弹窗（如系统音量条）。
  ipcMain.handle('mb-pin-window', (event, on) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const next = typeof on === 'boolean' ? on : !win.isAlwaysOnTop();
    try {
      win.setAlwaysOnTop(next, 'normal');
    } catch (_) {
      /* 某些平台/状态下可能失败，忽略 */
    }
    return win.isAlwaysOnTop();
  });

  // 隐藏窗口：仅从应用内触发（右键菜单「隐藏窗口」）。窗口被隐藏但进程与下载任务继续运行；
  // 重新显示只能通过在 cmd 中运行 show.js（连接本地服务端口发送 show 命令）实现。
  ipcMain.on('mb-hide-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setSkipTaskbar(true); // 连任务栏入口也去掉，做到“真正隐藏”
      win.hide();
    }
  });

  // 启动本地“显示”服务：监听固定端口，只处理来自本机的 show 指令，用于 cmd 命令行恢复界面。
  setupShowServer();

  const args = parseLaunchArgs();
  createWindow(!!args.captureOut);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('mb-create-window', (event, url) => {
  if (!url || typeof url !== 'string') return;
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    transparent: true, // 与主窗口保持一致：支持透明模式
    backgroundColor: '#00000000',
    frame: false, // 与主窗口保持一致：无边框
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  w.loadFile(path.join(__dirname, 'index.html'));
  w.webContents.on('did-finish-load', () => {
    w.webContents.executeJavaScript(`window.mbLaunchUrl = ${JSON.stringify(url)}`);
  });
});

/**
 * 安全加固：拦截所有 webview 的创建与窗口弹出，
 * 强制剥离危险的 preload/nodeIntegration，并禁止独立的弹窗窗口。
 */
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    // 安全加固：强制关闭危险能力。preload 只允许本应用自带的 webview-preload.js，
    // 任何 guest 试图注入的其它 preload（理论上 guest 无法设置本宿主 webview 的属性，
    // 但为稳妥仍做校验）一律剥离，避免任意代码执行。
    void params;
    const wpPreload = webPreferences.preloadURL || webPreferences.preload || '';
    if (wpPreload && !/webview-preload\.js$/.test(wpPreload)) {
      delete webPreferences.preloadURL;
      delete webPreferences.preload;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    // 注意：webview 预加载需要 require 本地纯逻辑模块（video-detect.js），
    // 沙箱下只允许 require('electron')，故这里保持与「主窗口预加载」一致的 sandbox:false。
    // 页面 JS 仍被 contextIsolation 隔离，无法触达预加载。
    webPreferences.sandbox = false;
    webPreferences.allowRunningInsecureContent = false;
  });

  // 页面 window.open() / target="_blank" 弹窗：
  // 不能一律 deny —— 那会让「JS 打开的链接」静默无反应（用户反馈的打不开）。
  // 正确做法：把 http(s) 目标 URL 转发给宿主窗口，由渲染进程在新标签打开后，再 deny 原生窗口。
  contents.setWindowOpenHandler((details) => {
    const url = (details && details.url) || '';
    if (/^https?:/i.test(url)) {
      // webview 的 guest contents 通过 hostWebContents 找到宿主窗口
      const host = contents.hostWebContents || contents;
      const win = BrowserWindow.fromWebContents(host);
      if (win) win.webContents.send('mb-open-in-tab', url);
    }
    return { action: 'deny' };
  });
});
