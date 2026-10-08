'use strict';
/**
 * 真实站点端到端验证：在指定网址上跑通
 *   ① 在播放器（含**同源 iframe** 内的）上发**真实右键**
 *   ② webview-preload 上报 mb-video-context-menu（外壳据此弹「下载」）
 *   ③ 用**生产模块** video-download 走真实网络把该源拉成 MP4 落盘
 *   ④ 校验产物是合法 MP4（ftyp 头）+ ffprobe 可识别
 *
 * 这是对 allappy.com 那类「播放器跑在 iframe + CDN 带防盗链校验」站点的回归验证：
 *   - 改前：iframe 内右键收不到事件；且 ffmpeg 的 -headers 放在 -i 之后被静默忽略 → CDN 403
 *   - 改后：同源 iframe 穿透 + 输入选项前置 → 正常出 MP4
 *
 * 用法：electron --disable-gpu --no-sandbox diag-site-video.js "https://example.com/page"
 * 退出码 0 = 全链路通过。
 */
const { app, BrowserWindow, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ffmpegPure = require('./video-ffmpeg');

const TARGET = process.argv.find((a) => /^https?:\/\//.test(a)) || '';
const TMP = path.join(__dirname, '.tmp-site');
const OUT_DIR = path.join(TMP, 'e2e-out');
const RESULT = path.join(TMP, 'site-video-result.json');
const PROBE_SECONDS = 20; // 限时切片长度（只用于验证产物格式，不下载整部影片）
const WEBVIEW_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.234 Electron/31.7.7 Safari/537.36';

function finish(o, code) {
  try { fs.writeFileSync(RESULT, JSON.stringify(o, null, 2)); } catch (_) {}
  console.log('\n==== RESULT: ' + (code === 0 ? 'ALL PASSED' : 'FAILED') + ' ====');
  setTimeout(() => app.exit(code || 0), 200);
}
const wd = setTimeout(() => finish({ watchdog: true }, 5), 300000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHostHtml(guestUrl, preloadUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%}webview{position:absolute;inset:0;width:100%;height:100%}</style>
</head><body>
  <webview id="wv" src="${guestUrl}" preload="${preloadUrl}"></webview>
  <script>
    window.__mbMsgs = [];
    const wv = document.getElementById('wv');
    wv.addEventListener('ipc-message', (e) => {
      window.__mbMsgs.push({ channel: e.channel, frameId: e.frameId, payload: e.args && e.args[0] });
    });
  </script>
</body></html>`;
}

// 在 guest 里定位「最大的可见视频」，并把其中心点换算成**顶层视口**坐标
const LOCATE_JS = `(async function(){
  function docs(){
    var out=[], seen=new Set();
    function visit(win){
      if(!win||seen.has(win))return; seen.add(win);
      var d=null; try{d=win.document}catch(e){return}
      if(!d||out.indexOf(d)>=0)return;
      out.push(d);
      var fs=null; try{fs=d.querySelectorAll('iframe,frame')}catch(e){}
      if(fs)for(var i=0;i<fs.length;i++){var cw=null;try{cw=fs[i].contentWindow}catch(e){}if(cw)visit(cw)}
    }
    visit(window); return out;
  }
  function toTop(r, doc){
    var x=r.left, y=r.top, win=doc.defaultView, guard=0;
    while(win && win!==window && guard++<20){
      var fe=null; try{fe=win.frameElement}catch(e){fe=null}
      if(!fe)break;
      var fr=fe.getBoundingClientRect();
      x+=fr.left; y+=fr.top;
      try{win=win.parent}catch(e){break}
    }
    return {x:x,y:y};
  }
  var ds=docs(), best=null;
  for(var k=0;k<ds.length;k++){
    var d=ds[k], vs=[];
    try{vs=Array.prototype.slice.call(d.querySelectorAll('video'))}catch(e){}
    for(var i=0;i<vs.length;i++){
      var v=vs[i], r=null;
      try{r=v.getBoundingClientRect()}catch(e){continue}
      if(!r||r.width<32||r.height<32)continue;
      var area=r.width*r.height;
      if(best && area<=best.area)continue;
      var p=toTop(r,d);
      best={area:area, w:Math.round(r.width), h:Math.round(r.height),
            cx:Math.round(p.x+r.width/2), cy:Math.round(p.y+r.height/2),
            src:String(v.currentSrc||v.src||'').slice(0,120),
            paused:v.paused, readyState:v.readyState,
            inFrame:d!==document, frameUrl:(function(){try{return d.location.href}catch(e){return 'x-origin'}})()};
    }
  }
  if(!best) return JSON.stringify({found:false, docs:ds.length, vw:window.innerWidth, vh:window.innerHeight});
  // 把视频滚到视口内，保证右键坐标有效
  best.scrollY = window.scrollY;
  return JSON.stringify(Object.assign({found:true, docs:ds.length, vw:window.innerWidth, vh:window.innerHeight}, best));
})()`;

async function main() {
  if (!TARGET) { finish({ error: 'usage: electron diag-site-video.js <url>' }, 2); return; }
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const origGetPath = app.getPath.bind(app);
  app.getPath = (n) => (n === 'downloads' ? OUT_DIR : origGetPath(n));

  const preloadUrl = pathToFileURL(path.join(__dirname, 'webview-preload.js')).href;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-e2e-'));
  const hostPath = path.join(tmpDir, 'host.html');
  fs.writeFileSync(hostPath, buildHostHtml(TARGET, preloadUrl), 'utf8');

  // 与生产 main.js 一致的安全策略（关键：nodeIntegrationInSubFrames 保持 false，
  // 同源 iframe 的探测靠 webview-preload 自己的能力完成，不放宽安全边界）
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (_ev, wp) => {
      wp.nodeIntegration = false;
      wp.nodeIntegrationInSubFrames = false;
      wp.contextIsolation = true;
      wp.webSecurity = true;
      wp.sandbox = false;
    });
  });

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.setAudioMuted(true);
  const dlEvents = {};
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, payload) => {
    if (ch === 'mb-download' && payload && payload.id) (dlEvents[payload.id] = dlEvents[payload.id] || []).push(payload);
    return origSend(ch, payload);
  };

  const result = { target: TARGET, located: null, menu: null, download: null };
  const failures = [];
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (!cond && extra ? '  -> ' + extra : ''));
    if (!cond) failures.push(name);
  };

  await win.loadFile(hostPath);
  await sleep(15000); // 等页面 + 播放器 iframe + m3u8 请求

  const guests = webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview');
  check('webview guest 已创建', guests.length === 1, 'count=' + guests.length);
  if (!guests.length) { clearTimeout(wd); finish(result, 1); return; }
  const guest = guests[0];
  guest.setAudioMuted(true);

  const located = JSON.parse(await guest.executeJavaScript(LOCATE_JS));
  result.located = located;
  console.log('  [info] 定位结果：' + JSON.stringify(located));
  check('找到可见视频', !!located.found, JSON.stringify(located));
  if (!located.found) { clearTimeout(wd); finish(result, 1); return; }
  check('视频位于 iframe 内（本轮修复的场景）', located.inFrame === true, 'inFrame=' + located.inFrame);

  // 先滚到视频位置（长页面时右键坐标才有效），再发真实右键
  if (located.cy > located.vh - 60 || located.cy < 60) {
    await guest.executeJavaScript(`window.scrollBy(0, ${Math.round(located.cy - located.vh / 2)})`);
    await sleep(700);
    const again = JSON.parse(await guest.executeJavaScript(LOCATE_JS));
    result.locatedAfterScroll = again;
    if (again.found) { located.cx = again.cx; located.cy = again.cy; }
  }

  const CLICK = { x: Math.max(2, located.cx), y: Math.max(2, Math.min(located.cy, 890)) };
  guest.sendInputEvent({ type: 'mouseMove', x: CLICK.x, y: CLICK.y });
  await sleep(120);
  guest.sendInputEvent({ type: 'mouseDown', x: CLICK.x, y: CLICK.y, button: 'right', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x: CLICK.x, y: CLICK.y, button: 'right', clickCount: 1 });
  await sleep(1500);

  let msgs = [];
  try { msgs = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__mbMsgs)')); } catch (_) {}
  const channels = msgs.map((m) => m.channel);
  console.log('  [info] 右键后收到消息：' + JSON.stringify(channels));
  const hits = msgs.filter((m) => m.channel === 'mb-video-context-menu');
  check('真实右键（打在 iframe 内的播放器上）触发 mb-video-context-menu', hits.length >= 1, JSON.stringify(channels));

  if (!hits.length) {
    result.allMsgs = msgs;
    clearTimeout(wd); finish(result, 1); return;
  }
  const payload = hits[hits.length - 1].payload || {};
  result.menu = payload;
  const sources = payload.sources || [];
  check('菜单携带可下载源', sources.length >= 1, JSON.stringify(sources));
  check('源被识别为 HLS（.m3u8）', sources.some((s) => s.kind === 'hls'), JSON.stringify(sources));

  // 选源：优先 HLS（本站播放器是 HLS），否则第一个
  const chosen = sources.find((s) => s.kind === 'hls') || sources[0];
  if (!chosen) { clearTimeout(wd); finish(result, 1); return; }

  const descriptor = {
    url: chosen.url, kind: chosen.kind, title: payload.title || 'site-video',
    referer: payload.pageUrl, pageUrl: payload.pageUrl, ua: WEBVIEW_UA
  };

  // ---- Phase B：走生产下载链路，只验证「能拉到数据」（整部影片可能数小时，不在此跑完）----
  const video = require('./video-download');
  video.setupVideoDownloads();
  const started = await video.startVideoDownload({ sender: win.webContents }, descriptor);

  const prog = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const list = dlEvents[started.id] || [];
      const doneEv = list.find((p) => p.type === 'done');
      if (doneEv) { clearInterval(iv); resolve({ kind: 'done', ev: doneEv }); return; }
      const pcts = list.filter((p) => typeof p.pct === 'number').map((p) => p.pct);
      if (pcts.some((p) => p > 0) && Date.now() - t0 > 6000) {
        clearInterval(iv);
        resolve({ kind: 'progress', maxPct: Math.max.apply(null, pcts), count: list.length });
        return;
      }
      if (Date.now() - t0 > 45000) { clearInterval(iv); resolve({ kind: 'stalled', count: list.length }); }
    }, 250);
  });
  result.download = Object.assign(
    { ok: !!started.ok, id: started.id, source: chosen.url, phase: prog.kind },
    prog.kind === 'done'
      ? { state: prog.ev.state, error: prog.ev.error || null, savePath: prog.ev.savePath }
      : { maxPct: prog.maxPct || 0, events: prog.count }
  );
  console.log('  [info] 生产下载链路：' + JSON.stringify(result.download));
  check('生产下载链路成功启动并拉到数据（未 403）',
    prog.kind === 'progress' || prog.kind === 'done', JSON.stringify(result.download));

  // ---- Phase C：用**生产参数**做限时切片，验证产物确实是合法 MP4 ----（避免下载整部影片）
  const ff = (() => {
    const cands = ffmpegPure.ffmpegCandidates(process.platform);
    for (const c of cands) {
      if (c === 'ffmpeg') continue;
      try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
    }
    return 'ffmpeg';
  })();
  const probeOut = path.join(OUT_DIR, 'probe.mp4');
  const probeArgs = ffmpegPure.buildFfmpegArgs(chosen.url, probeOut, descriptor, '');
  probeArgs.splice(probeArgs.length - 1, 0, '-t', String(PROBE_SECONDS)); // 仅在输出路径前插入时长上限
  const probeLog = path.join(OUT_DIR, 'probe.log');
  let probeExit = 0;
  try {
    const rs = spawnSync(ff, probeArgs, {
      stdio: ['ignore', 'ignore', fs.openSync(probeLog, 'w')], timeout: 120000, windowsHide: true
    });
    probeExit = rs.status === null ? 'timeout/killed' : rs.status;
  } catch (e) { probeExit = 'throw: ' + (e && e.message); }
  const probeLogTxt = (() => { try { return fs.readFileSync(probeLog, 'utf8'); } catch (_) { return ''; } })();
  let probeSize = 0, probeFtyp = false, probeMoov = false;
  try {
    probeSize = fs.statSync(probeOut).size;
    const head = fs.readFileSync(probeOut);
    probeFtyp = head.slice(4, 8).toString() === 'ftyp';
    probeMoov = head.indexOf('moov') >= 0; // +faststart 生效时 moov 应在文件前部
  } catch (_) {}
  let probeStreams = '';
  try {
    probeStreams = spawnSync(ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
      ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height',
        '-show_entries', 'format=duration,format_name', '-of', 'default=nw=1', probeOut],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }).stdout || '';
  } catch (_) {}
  result.probe = {
    ffmpeg: ff, exitCode: probeExit, size: probeSize, ftyp: probeFtyp, moov: probeMoov,
    streams: probeStreams.trim().split('\n').join(' | '),
    err403: /403 Forbidden/.test(probeLogTxt),
    logTail: probeLogTxt.split('\n').filter(Boolean).slice(-4).join('\n')
  };
  console.log('  [info] 限时切片验证：' + JSON.stringify(result.probe));

  check('限时切片 ffmpeg 退出码 0', probeExit === 0, String(probeExit));
  check('未再出现 403 Forbidden', result.probe.err403 === false, result.probe.logTail);
  check('产物非空', probeSize > 0, 'size=' + probeSize);
  check('产物是合法 MP4（ftyp）', probeFtyp === true);
  check('产物含 moov（+faststart 生效）', probeMoov === true);
  check('ffprobe 识别出视频流', /codec_type=video/.test(probeStreams), probeStreams);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  clearTimeout(wd);
  finish(result, failures.length ? 1 : 0);
}

app.whenReady().then(() => {
  main().catch((e) => finish({ fatal: e && e.stack }, 1));
});
