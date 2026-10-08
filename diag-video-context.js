'use strict';

/**
 * 端到端诊断：验证「鼠标位于视频区域内右键 → 外壳收到可下载的视频源」这条链路。
 *
 * 覆盖两个真实站点上最常见的失效场景：
 *   [场景 1] 覆盖层遮挡：测试页在 <video> 上盖了一层 div（模拟封面 / 遮罩 / 自绘控制条），
 *            右键命中的是覆盖层，事件 composedPath 里没有 VIDEO。
 *   [场景 2] 同源 iframe：播放器跑在 iframe 里（本站 allappy.com 即如此）。contextmenu
 *            不会跨 frame 冒泡，只把监听器挂主文档的话这里会静默失效。
 * 期望：两种情况都收到 mb-video-context-menu，且**各自命中自己文档内的那个视频**
 * （防止跨 frame 坐标系串味）。
 *
 * 用本地 HTTP 服务托管 fixture：只有真正的 http(s) 源才有正常的同源语义，
 * file:// 在 Chromium 里是非透明源，同源 iframe 穿透会失真。
 *
 * 运行：node_modules/.bin/electron --disable-gpu --no-sandbox diag-video-context.js
 * 退出码 0 = 通过，1 = 失败。
 */

const { app, BrowserWindow, webContents } = require('electron');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const TOP_MP4 = 'https://example.com/media/top-clip.mp4';
const FRAME_MP4 = 'https://example.com/media/inframe-clip.mp4';

// 顶层页：上方一个被覆盖层盖住的 <video>，下方一个同源 iframe 播放器
const GUEST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>video-overlay-fixture</title>
<style>
  html,body{margin:0;padding:0;background:#111}
  .stage{position:relative;margin:0}
  #stageA{position:absolute;left:40px;top:40px;width:600px;height:300px}
  #v{position:absolute;left:0;top:0;width:600px;height:300px;background:#000}
  #overlayA{position:absolute;left:0;top:0;width:600px;height:300px;background:rgba(0,0,0,0.35);
            display:flex;align-items:center;justify-content:center;color:#fff;font:14px sans-serif}
  #playerFrame{position:absolute;left:40px;top:380px;width:600px;height:300px;border:0}
</style></head>
<body>
  <div id="stageA">
    <video id="v" src="${TOP_MP4}"></video>
    <div id="overlayA">顶层自定义控制层（覆盖在 video 之上）</div>
  </div>
  <iframe id="playerFrame" src="/player.html"></iframe>
</body></html>`;

// iframe 内的播放器：<video> 同样被覆盖层铺满
const PLAYER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>player</title>
<style>
  html,body{margin:0;padding:0;background:#000;overflow:hidden}
  video{position:absolute;left:0;top:0;width:100%;height:100%;background:#000}
  #overlayB{position:absolute;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.35);
            display:flex;align-items:center;justify-content:center;color:#fff;font:14px sans-serif}
</style></head>
<body>
  <video id="fv" src="${FRAME_MP4}"></video>
  <div id="overlayB">iframe 内播放器控制层</div>
</body></html>`;

// 右键点：顶层视频中心 / iframe 内视频中心（均为「顶层视口」坐标）
const CLICK_TOP = { x: 340, y: 190 };
const CLICK_FRAME = { x: 340, y: 530 };

function buildHostHtml(preloadUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%}webview{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body>
  <webview id="wv" src="/guest.html" preload="${preloadUrl}"></webview>
  <script>
    window.__mbMsgs = [];
    const wv = document.getElementById('wv');
    wv.addEventListener('ipc-message', (e) => {
      window.__mbMsgs.push({ channel: e.channel, payload: e.args && e.args[0] });
    });
  </script>
</body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guestWebContents() {
  return webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview');
}

async function readMsgs(win) {
  try {
    return await win.webContents.executeJavaScript('JSON.stringify(window.__mbMsgs)').then(JSON.parse);
  } catch (_) {
    return [];
  }
}

function startServer(hostHtml) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (type, body) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url === '/' || url === '/index.html') return send('text/html; charset=utf-8', hostHtml);
    if (url === '/guest.html') return send('text/html; charset=utf-8', GUEST_HTML);
    if (url === '/player.html') return send('text/html; charset=utf-8', PLAYER_HTML);
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 在 guest 里对指定文档派发一次合成 contextmenu（真实输入被无头环境吞掉时的兜底，
// 走的是同一条代码路径；iframe 场景传 frame 说明符）
function syntheticContextMenu(guest, where, pt) {
  const target =
    where === 'frame'
      ? `document.getElementById('playerFrame').contentDocument.getElementById('overlayB')`
      : `document.getElementById('overlayA')`;
  return guest.executeJavaScript(
    `(function(){
       var el = ${target};
       if(!el) return 'no-target';
       el.dispatchEvent(new MouseEvent('contextmenu', {
         bubbles: true, cancelable: true, composed: true,
         clientX: ${pt.x}, clientY: ${pt.y}
       }));
       return 'dispatched';
     })()`
  );
}

async function main() {
  const preloadUrl = pathToFileURL(path.join(__dirname, 'webview-preload.js')).href;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) console.log('  PASS  ' + name);
    else {
      failures.push(name);
      console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
    }
  };

  const { server, port } = await startServer(buildHostHtml(preloadUrl));

  // 与 main.js 一致：webview 预加载需要 require 本地纯逻辑模块（video-detect.js），故 sandbox=false
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (_ev, webPreferences) => {
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = false;
    });
  });

  const win = new BrowserWindow({
    width: 1024,
    height: 760,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  await win.loadURL('http://127.0.0.1:' + port + '/index.html');
  await sleep(1800); // 等 webview 创建 + 预加载注入 + 首次 scanVideos()

  const guests = guestWebContents();
  check('webview guest 已创建', guests.length === 1, 'count=' + guests.length);
  if (!guests.length) {
    console.log('\n==== RESULT: FAILED (webview 未创建) ====');
    server.close();
    app.exit(1);
    return;
  }
  const guest = guests[0];
  guest.setAudioMuted(true);
  await sleep(1000); // 等 iframe 加载完成（同源文档可访问）

  // ---------- 场景 1：顶层视频被覆盖层遮挡 ----------
  console.log('  [case 1] 顶层 <video> 被覆盖层盖住');
  guest.sendInputEvent({ type: 'mouseMove', x: CLICK_TOP.x, y: CLICK_TOP.y });
  guest.sendInputEvent({ type: 'mouseDown', x: CLICK_TOP.x, y: CLICK_TOP.y, button: 'right', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x: CLICK_TOP.x, y: CLICK_TOP.y, button: 'right', clickCount: 1 });
  await sleep(1000);

  let msgs = await readMsgs(win);
  let hits = msgs.filter((m) => m.channel === 'mb-video-context-menu');
  if (!hits.length) {
    console.log('  [info] 未收到真实右键的 contextmenu，改用覆盖层派发合成事件（同一条代码路径）');
    await syntheticContextMenu(guest, 'top', CLICK_TOP);
    await sleep(600);
    msgs = await readMsgs(win);
    hits = msgs.filter((m) => m.channel === 'mb-video-context-menu');
  }
  const topHit = hits[hits.length - 1];
  check('顶层：收到 mb-video-context-menu', !!topHit,
    'channels=' + JSON.stringify(msgs.map((m) => m.channel)));
  if (topHit) {
    const ss = (topHit.payload && topHit.payload.sources) || [];
    check('顶层：命中覆盖层下的那个视频', ss.some((s) => /top-clip\.mp4$/.test(s.url)), JSON.stringify(ss));
    check('顶层：源归类为 mp4', ss.some((s) => s.kind === 'mp4'), JSON.stringify(ss));
    check('顶层：未误命中 iframe 内的视频', !ss.some((s) => /inframe-clip\.mp4$/.test(s.url)), JSON.stringify(ss));
  }

  // ---------- 场景 2：播放器位于同源 iframe 内 ----------
  console.log('  [case 2] <video> 位于同源 iframe 内（覆盖层同样遮挡）');
  await sleep(300);
  const before = (await readMsgs(win)).length;
  guest.sendInputEvent({ type: 'mouseMove', x: CLICK_FRAME.x, y: CLICK_FRAME.y });
  guest.sendInputEvent({ type: 'mouseDown', x: CLICK_FRAME.x, y: CLICK_FRAME.y, button: 'right', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x: CLICK_FRAME.x, y: CLICK_FRAME.y, button: 'right', clickCount: 1 });
  await sleep(1000);

  msgs = await readMsgs(win);
  hits = msgs.filter((m) => m.channel === 'mb-video-context-menu');
  if (msgs.length === before || !hits.some((h) => ((h.payload || {}).sources || []).some((s) => /inframe-clip/.test(s.url)))) {
    console.log('  [info] 真实右键未命中 iframe 内视频，改由 iframe 文档派发合成事件（同一条代码路径）');
    await syntheticContextMenu(guest, 'frame', CLICK_FRAME);
    await sleep(600);
    msgs = await readMsgs(win);
    hits = msgs.filter((m) => m.channel === 'mb-video-context-menu');
  }
  const frameHit = hits
    .filter((h) => ((h.payload || {}).sources || []).some((s) => /inframe-clip\.mp4$/.test(s.url)))
    .pop();
  check('iframe：收到 mb-video-context-menu（且带 iframe 内的源）', !!frameHit,
    'channels=' + JSON.stringify(msgs.map((m) => m.channel)));
  if (frameHit) {
    const ss = (frameHit.payload && frameHit.payload.sources) || [];
    check('iframe：源归类为 mp4', ss.some((s) => s.kind === 'mp4'), JSON.stringify(ss));
    check('iframe：未误命中顶层视频', !ss.some((s) => /top-clip\.mp4$/.test(s.url)), JSON.stringify(ss));
    check('iframe：pageUrl 指向 iframe 文档', /player\.html/.test(String(frameHit.payload.pageUrl)),
      String(frameHit.payload.pageUrl));
  }

  console.log('\n==== RESULT: ' + (failures.length ? 'FAILED (' + failures.length + ')' : 'ALL PASSED') + ' ====');
  server.close();
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.error('diag error:', e && e.stack ? e.stack : e);
    app.exit(1);
  });
});
