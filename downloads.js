'use strict';

/**
 * 下载管理（独立模块，便于生产入口与诊断脚本复用同一份实现）。
 *
 * 职责：
 *  - 接管 session 的 will-download，为每项下载分配落盘路径（同名自动加 (1) 后缀）
 *  - 把 added / updated / done 三类事件推送给发起下载的那个窗口
 *  - 处理界面发来的暂停 / 继续 / 取消 / 打开 / 打开文件夹等操作
 */

const { app, BrowserWindow, session, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getSetting } = require('./settings-store');

// id -> { item, savePath, win }
const downloads = new Map();

// webview 的下载由 guest contents 发起，需经 hostWebContents 才能找到宿主窗口
function ownerWindowFor(wc) {
  if (!wc) return null;
  const host = wc.hostWebContents || wc;
  return BrowserWindow.fromWebContents(host) || null;
}

function sendDownloadEvent(win, payload) {
  if (win && win.webContents && !win.isDestroyed()) {
    win.webContents.send('mb-download', payload);
  }
}

// 避免覆盖同名文件：xxx.txt → xxx (1).txt
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext) || 'download';
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, base + ' (' + n + ')' + ext);
    n += 1;
  }
  return candidate;
}

function setupDownloads() {
  session.defaultSession.on('will-download', (event, item, wc) => {
    const win =
      ownerWindowFor(wc) || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

    const dir = getSetting('downloadDir') || app.getPath('downloads');
    const filename = item.getFilename() || 'download';

    let savePath;
    if (getSetting('askWhereToSave')) {
      // 必须用**同步**对话框：will-download 事件里若异步等待，下载会被取消。
      const chosen = dialog.showSaveDialogSync(win, {
        title: '保存文件',
        defaultPath: path.join(dir, filename)
      });
      if (!chosen) {
        item.cancel(); // 用户取消保存，直接终止本次下载
        return;
      }
      savePath = chosen;
    } else {
      savePath = uniquePath(dir, filename);
    }
    item.setSavePath(savePath);

    const id = 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const rec = { item, savePath, win };
    downloads.set(id, rec);

    sendDownloadEvent(win, {
      type: 'added',
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      totalBytes: item.getTotalBytes() || 0
    });

    item.on('updated', (_e, state) => {
      sendDownloadEvent(rec.win, {
        type: 'updated',
        id,
        state,
        paused: item.isPaused(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      });
    });

    item.on('done', (_e, state) => {
      sendDownloadEvent(rec.win, { type: 'done', id, state });
      // 完成后保留一段时间供界面展示，再释放引用
      setTimeout(() => downloads.delete(id), 5 * 60 * 1000);
    });
  });
}

// 界面发起的下载操作：暂停 / 继续 / 重试 / 取消 / 打开文件 / 打开所在文件夹
ipcMain.on('mb-download-action', (event, payload) => {
  const id = payload && payload.id;
  const action = payload && payload.action;
  const rec = downloads.get(id);
  if (!rec) return;
  const item = rec.item;
  try {
    if (action === 'pause') item.pause();
    else if (action === 'resume' || action === 'retry') item.resume();
    else if (action === 'cancel') item.cancel();
    else if (action === 'open') shell.openPath(rec.savePath);
    else if (action === 'folder') shell.showItemInFolder(rec.savePath);
  } catch (_) {
    /* 文件已被删除等情况忽略 */
  }
});

module.exports = { setupDownloads, downloads, uniquePath };
