'use strict';
/**
 * 真实网络端到端验证：用**生产模块** video-download 走真实的 http(s) URL，
 * 验证 session.resolveProxy（真实网络） + ffmpeg 联网拉流 + 代理注入 + 转封装 MP4。
 * 与本地资源版不同：这里**不 patch** resolveProxy，走完整生产路径。
 *
 * 用法：electron diag-download-real.js
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '.tmp-realtest', 'out');
const RESULT = path.join(__dirname, 'dl-real-result.json');

function out(o) { try { fs.writeFileSync(RESULT, JSON.stringify(o, null, 2)); } catch (_) {} }
function finish(o, code) { out(o); setTimeout(() => app.exit(code || 0), 200); }

const wd = setTimeout(() => finish({ watchdog: true }, 5), 200000);

async function main() {
  fs.rmSync(path.dirname(OUT_DIR), { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const origGetPath = app.getPath.bind(app);
  app.getPath = (n) => (n === 'downloads' ? OUT_DIR : origGetPath(n));

  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  const captured = {};
  const origSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'mb-download' && payload && payload.id) {
      (captured[payload.id] = captured[payload.id] || []).push(payload);
    }
    return origSend(channel, payload);
  };

  const video = require('./video-download');
  video.setupVideoDownloads();

  function waitDone(id, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const list = captured[id] || [];
        const done = list.find((p) => p.type === 'done');
        if (done) { clearInterval(iv); resolve(done); return; }
        if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }
  const statOf = (sp) => { try { return sp ? fs.statSync(sp) : null; } catch (_) { return null; } };
  const isMp4 = (sp) => { try { return sp ? fs.readFileSync(sp).slice(4, 8).toString() === 'ftyp' : false; } catch (_) { return false; } };

  const result = { proxy: {}, direct: null, hls: null, eventCounts: {}, outFiles: [] };

  const CASES = [
    {
      key: 'direct',
      url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      descriptor: {
        url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        kind: 'mp4', title: 'bbb real', referer: 'https://test-videos.co.uk/', pageUrl: 'https://test-videos.co.uk/'
      }
    },
    {
      key: 'hls',
      url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/prog_index.m3u8',
      descriptor: {
        url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/prog_index.m3u8',
        kind: 'hls', title: 'bipbop real', referer: 'https://devstreaming-cdn.apple.com/', pageUrl: 'https://devstreaming-cdn.apple.com/'
      }
    }
  ];

  for (const c of CASES) {
    // 真实代理解析（不 patch），记录结果
    try {
      const r = await Promise.race([
        session.defaultSession.resolveProxy(c.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('proxy-timeout')), 8000))
      ]);
      result.proxy[c.key] = r;
    } catch (e) {
      result.proxy[c.key] = 'ERR: ' + (e && e.message);
    }
    try {
      const r = await video.startVideoDownload({ sender: win.webContents }, c.descriptor);
      const d = await waitDone(r.id, 90000);
      const sp = d ? d.savePath : (captured[r.id] && captured[r.id][0] && captured[r.id][0].savePath);
      const f = statOf(sp);
      result[c.key] = {
        ok: !!r.ok, id: r.id,
        doneState: d ? d.state : 'timeout',
        error: d ? d.error || null : 'timeout',
        savePath: sp, fileExists: !!f, fileSize: f ? f.size : 0, isMp4: isMp4(sp)
      };
      result.eventCounts[c.key] = (captured[r.id] || []).map((p) => p.type);
    } catch (e) {
      result[c.key] = { error: 'throw: ' + (e && e.message) };
    }
  }

  result.outFiles = (() => { try { return fs.readdirSync(OUT_DIR); } catch (_) { return []; } })();
  clearTimeout(wd);
  const pass = result.direct && result.direct.fileExists && result.direct.isMp4 &&
    result.hls && result.hls.fileExists && result.hls.isMp4;
  finish(result, pass ? 0 : 4);
}

app.whenReady().then(main).catch((e) => finish({ fatal: e && e.message }, 1));
