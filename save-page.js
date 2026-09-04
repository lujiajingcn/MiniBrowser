'use strict';

const { ipcMain, webContents, app } = require('electron');
const fs = require('node:fs');
const { getSetting } = require('./settings-store');
const { uniquePath } = require('./downloads');

// 保存目录与「下载」复用同一设置（用户可在设置里改下载目录）
function saveDir() {
  return getSetting('downloadDir') || app.getPath('downloads');
}

// 把页面标题清洗成合法文件名（截断避免过长）
function safeBaseName(title, fallback) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || fallback || 'page';
  return base.length > 80 ? base.slice(0, 80) : base;
}

// 轮询目标文件是否出现且非空（Electron 的 savePage 回调在某些环境下不触发，故以落盘为准）
function waitForFile(filePath, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        const st = fs.statSync(filePath);
        if (st.size > 0) return resolve(true);
      } catch (_) {
        /* not yet */
      }
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * 保存当前活动 webview 的页面到本地，供断网时打开。
 * @param {number} webContentsId 活动 webview 的 guest webContents id
 * @param {string} type 'MHTML'（单文件存档）或 'HTMLComplete'（HTML + 资源目录）
 * @returns {Promise<{ok:boolean, path?:string, type?:string, error?:string}>}
 */
function setupSavePage() {
  ipcMain.handle('mb-save-page', async (event, webContentsId, type) => {
    const id = Number(webContentsId) || 0;
    if (!id) return { ok: false, error: '找不到当前页面' };
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return { ok: false, error: '页面内容已失效' };

    const saveType = type === 'MHTML' ? 'MHTML' : 'HTMLComplete';
    const ext = saveType === 'MHTML' ? '.mhtml' : '.html';

    const dir = saveDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      /* ignore */
    }

    const title = (wc.getTitle && wc.getTitle()) || wc.getURL() || 'page';
    const base = safeBaseName(title, 'page');
    const savePath = uniquePath(dir, base + ext);

    // 注意：Electron 的 webContents.savePage 回调在部分环境下（包括本机 Electron 31）
    // 不会触发，但文件实际已写入磁盘。因此这里忽略回调，改为轮询文件落盘来判定成功。
    try {
      wc.savePage(savePath, saveType, () => {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }

    const ok = await waitForFile(savePath, 30000);
    if (!ok) {
      return { ok: false, error: '保存超时，文件未生成（页面可能尚未加载完成，或所选格式在此环境不可用）' };
    }
    return { ok: true, path: savePath, type: saveType };
  });
}

module.exports = { setupSavePage };
