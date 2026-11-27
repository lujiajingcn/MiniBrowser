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
//
// 用独占创建（'wx'）原子预留路径，而不是 existsSync 后再写：
// 视频下载、保存网页都要先拿路径再异步落盘，两个任务并发时
// existsSync 会同时看到「不存在」并拿到同一个路径，先完成的被后完成者覆盖。
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext) || 'download';
  let n = 1;
  while (n < 1000) {
    const candidate = path.join(dir, base + (n === 1 ? '' : ' (' + n + ')') + ext);
    try {
      const fd = fs.openSync(candidate, 'wx');
      fs.closeSync(fd);
      return candidate;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        n += 1;
        continue;
      }
      // 目录不存在/无权限等：交给后续写入给出明确错误，不让路径分配自己崩掉。
      return candidate;
    }
  }
  return path.join(dir, filename);
}

function setupDownloads() {
  // 注册下载操作的 IPC 处理器（见下方 registerDownloadActionHandler 的说明：
  // 必须在函数内注册，模块顶层时 ipcMain 尚未就绪）
  registerDownloadActionHandler();

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
//
// 【必须放在 setupDownloads() 内部】
// 之前这行 ipcMain.on(...) 写在模块顶层 —— 即 require('./downloads') 被执行时
// 就跑。此时 Electron 的 ipcMain 尚未就绪（undefined），
// 直接报 "TypeError: Cannot read properties of undefined (reading 'on')"，
// 表现为启动即崩溃 + 弹出原生 Error 对话框，完全不像一个正常应用。
// 该问题自 578d28f 首次提交起就存在，只是一直没被触发到。
function registerDownloadActionHandler() {
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
}

module.exports = { setupDownloads, downloads, uniquePath };
