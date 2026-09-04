'use strict';

/**
 * 视频下载（独立模块，便于生产入口与诊断脚本复用同一份实现）。
 *
 * 设计要点：
 *  - 所有视频统一经 ffmpeg 拉取并封装为 MP4（HLS 用 -c copy 转封装，无损且快；
 *    直链 mp4/webm 等也走 ffmpeg，保证最终产物是 .mp4）。
 *  - ffmpeg 不存在时（未装 ffmpeg-static / 系统无 ffmpeg）给出明确提示，不崩溃。
 *  - 代理：从 session 解析目标地址的代理（用户机器走代理时，ffmpeg 直接拉会失败），
 *    把代理注入 ffmpeg 的环境变量与 -http_proxy 参数。
 *  - 进度：解析 ffmpeg stderr 的 Duration / time，回传百分比；取消时杀掉子进程并清理半成品。
 *  - 事件复用现有下载面板通道 'mb-download'，并打上 kind:'video' 以便渲染层区分。
 */

const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { getSetting } = require('./settings-store');
const { uniquePath } = require('./downloads');
const { safeBaseName, parseProxyResult, withScheme, buildFfmpegArgs } = require('./video-ffmpeg');

// id -> { child, savePath, win }
const active = new Map();

// ffmpeg 路径：优先 ffmpeg-static（随 npm 安装），其次系统 PATH 上的 ffmpeg
function findFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) {
    /* 未安装 ffmpeg-static */
  }
  return 'ffmpeg';
}

function downloadDir() {
  return getSetting('downloadDir') || app.getPath('downloads');
}

function send(win, payload) {
  if (win && win.webContents && !win.isDestroyed()) {
    win.webContents.send('mb-download', payload);
  }
}

async function startVideoDownload(event, descriptor) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const url = descriptor && descriptor.url;
  if (!url) return { ok: false, error: '缺少视频地址' };

  const dir = downloadDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const outName = safeBaseName(descriptor.title, 'video') + '.mp4';
  const savePath = uniquePath(dir, outName);

  const id = 'vid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  active.set(id, { win, savePath, child: null });

  send(win, {
    type: 'added',
    id,
    filename: path.basename(savePath),
    savePath,
    url,
    totalBytes: 0,
    kind: 'video'
  });

  // 解析代理（用户机器走代理时 ffmpeg 直连会失败）
  let proxy = '';
  try {
    const resolved = await session.defaultSession.resolveProxy(url);
    proxy = parseProxyResult(resolved);
  } catch (_) {
    /* 解析失败则不使用代理 */
  }

  runFfmpeg(id, url, savePath, descriptor, win, proxy);
  return { ok: true, id };
}

function runFfmpeg(id, url, outPath, descriptor, win, proxy) {
  const rec = active.get(id);
  if (!rec) return;
  const ffmpeg = findFfmpeg();

  const args = buildFfmpegArgs(url, outPath, descriptor, proxy);

  const env = Object.assign({}, process.env);
  if (proxy) {
    const ph = withScheme(proxy);
    env.HTTP_PROXY = ph;
    env.HTTPS_PROXY = ph;
    env.http_proxy = ph;
    env.https_proxy = ph;
  }

  let child;
  try {
    child = spawn(ffmpeg, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    finishError(id, win, outPath, '无法启动 ffmpeg：' + (e && e.message));
    return;
  }
  rec.child = child;

  // spawn 返回的进程若可执行文件不存在，会触发 'error' 而非 'close'
  child.on('error', (err) => {
    const msg = /ENOENT/.test(err && err.code ? err.code : '') || /ffmpeg/.test(String(err))
      ? '未找到 ffmpeg（请安装 ffmpeg-static 或在 PATH 中提供 ffmpeg 后重试）'
      : '启动 ffmpeg 失败：' + (err && err.message);
    finishError(id, win, outPath, msg);
  });

  let duration = 0;
  child.stderr.on('data', (buf) => {
    const txt = buf.toString();
    const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
    const tm = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (tm) {
      const t = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
      if (duration > 0) {
        const pct = Math.min(100, Math.round((t / duration) * 100));
        send(win, { type: 'updated', id, pct, state: 'progressing', receivedBytes: 0, totalBytes: 0, kind: 'video' });
      }
    }
  });

  child.on('close', (code) => {
    const r = active.get(id);
    if (!r) return;
    const exists = (() => {
      try {
        return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      } catch (_) {
        return false;
      }
    })();
    if (code === 0 && exists) {
      send(win, { type: 'done', id, state: 'completed', kind: 'video', savePath: outPath });
    } else {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch (_) {
        /* ignore */
      }
      send(win, {
        type: 'done',
        id,
        state: 'interrupted',
        kind: 'video',
        error: 'ffmpeg 退出码 ' + code + '（可能该地址需要登录态/签名，或 ffmpeg 未安装）'
      });
    }
    active.delete(id);
  });
}

function finishError(id, win, outPath, message) {
  try {
    if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch (_) {
    /* ignore */
  }
  send(win, { type: 'done', id, state: 'interrupted', kind: 'video', error: message });
  active.delete(id);
}

function setupVideoDownloads() {
  ipcMain.handle('mb-download-video', (event, descriptor) => startVideoDownload(event, descriptor));

  ipcMain.on('mb-video-action', (event, payload) => {
    const id = payload && payload.id;
    const action = payload && payload.action;
    const rec = active.get(id);
    if (!rec) return;
    try {
      if (action === 'cancel') {
        if (rec.child) rec.child.kill('SIGTERM');
        if (rec.savePath && fs.existsSync(rec.savePath)) fs.unlinkSync(rec.savePath);
        active.delete(id);
        send(rec.win, { type: 'done', id, state: 'cancelled', kind: 'video' });
      } else if (action === 'open') {
        if (rec.savePath) shell.openPath(rec.savePath);
      } else if (action === 'folder') {
        if (rec.savePath) shell.showItemInFolder(rec.savePath);
      }
    } catch (_) {
      /* ignore */
    }
  });
}

module.exports = { setupVideoDownloads, startVideoDownload };
