'use strict';

const { app, BrowserWindow, webContents, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { setupDownloads } = require('./downloads');
const { setupSettingsIpc } = require('./settings-store');
const { setupVideoDownloads } = require('./video-download');

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
    backgroundColor: '#1f2933',
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

app.whenReady().then(() => {
  setupDownloads();
  setupSettingsIpc();
  setupVideoDownloads();

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
    backgroundColor: '#1f2933',
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
