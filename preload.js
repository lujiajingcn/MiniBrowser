'use strict';

const { contextBridge, shell, ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 允许交给系统处理器的协议白名单。
// 【为什么必须在这里校验】renderer.js 会把网页里 new-window / ipc-message /
// will-navigate 带来的 URL 中「非 http(s)/about/file」的部分转交给本方法，
// 也就是说入参是**网页可控**的。shell.openExternal 会直接调用系统默认处理器，
// 若不加白名单，恶意网页可用任意注册协议拉起本地程序（Electron 安全基线明令禁止）。
// http(s) 由应用自身开新标签，不会走到这里；这里只放行无副作用的通信协议。
const EXTERNAL_URL_RE = /^(https?:\/\/|mailto:|tel:)/i;

/**
 * 受控的桥接层：只暴露受控方法给渲染进程，
 * 不暴露完整的 Node / Electron 能力，避免任意网页篡改宿主。
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 用系统默认处理器打开外部协议；非白名单协议直接拒绝。
  openExternal: (url) => {
    if (typeof url !== 'string') return false;
    const target = url.trim();
    if (!EXTERNAL_URL_RE.test(target)) return false;
    return shell.openExternal(target);
  },
  platform: process.platform,
  // 供 <webview> 使用的内部 preload 脚本 file:// URL
  getWebviewPreloadPath: () => pathToFileURL(path.join(__dirname, 'webview-preload.js')).href,
  // 启动参数中最后一个形如 http(s):// 的网址（用于「electron . <url>」直接打开指定页）
  getLaunchUrl: () => {
    if (process.env && process.env.DEMO_URL && /^https?:\/\//i.test(process.env.DEMO_URL)) {
      return process.env.DEMO_URL;
    }
    const argv = process.argv || [];
    for (let i = argv.length - 1; i >= 0; i--) {
      if (/^https?:\/\//i.test(argv[i])) return argv[i];
    }
    return '';
  },
  // 主进程拦截到的弹窗（window.open / target="_blank"）请求在新标签打开
  onOpenInTab: (cb) => {
    const listener = (_e, url) => cb(url);
    ipcRenderer.on('mb-open-in-tab', listener);
    return () => ipcRenderer.removeListener('mb-open-in-tab', listener);
  },
  // 主进程设置（下载目录、是否询问保存位置等，存于 userData/settings.json）
  getMainSettings: () => ipcRenderer.invoke('mb-settings-get'),
  setMainSetting: (key, value) => ipcRenderer.invoke('mb-settings-set', key, value),
  // 弹出系统目录选择框，返回所选路径（取消则返回空串）
  chooseDownloadDir: () => ipcRenderer.invoke('mb-choose-download-dir'),
  // 下载事件推送：added / updated / done
  onDownloadEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('mb-download', listener);
    return () => ipcRenderer.removeListener('mb-download', listener);
  },
  // 下载操作：pause / resume / cancel / retry / open / folder
  downloadAction: (id, action) => ipcRenderer.send('mb-download-action', { id, action }),
  // 视频下载：descriptor = { url, kind:'hls'|'direct', title, referer, pageUrl, ua }
  downloadVideo: (descriptor) => ipcRenderer.invoke('mb-download-video', descriptor),
  // 视频下载的操作：cancel / open / folder
  videoDownloadAction: (id, action) => ipcRenderer.send('mb-video-action', { id, action }),
  // 保存页面（离线查看）：webContentsId = 活动 webview 的 guest webContents id，type = 'MHTML' | 'HTMLComplete'
  savePage: (webContentsId, type) => ipcRenderer.invoke('mb-save-page', webContentsId, type),
  // 导出收藏夹：bookmarks = [{title,url}]，主进程弹保存框并写出 Netscape 书签 HTML
  exportBookmarks: (bookmarks) => ipcRenderer.invoke('mb-export-bookmarks', bookmarks),
  // 请求主进程打开一个独立的新窗口
  createWindow: (url) => ipcRenderer.send('mb-create-window', url),
  // 无边框窗口控制：action = 'min' | 'max' | 'close'
  windowControl: (action) => ipcRenderer.send('mb-win-control', action),
  // 「钉在桌面」：窗口置顶但不抢焦点（类似 QQ 截图的「钉在桌面」）。
  // on 省略时表示切换；返回值是设置后的实际状态（以主进程为准）。
  setPinned: (on) => ipcRenderer.invoke('mb-pin-window', on),
  // 主进程通知置顶状态变化（用户可能从窗口标题栏菜单改过）
  onPinnedChanged: (cb) => {
    const listener = (_e, value) => cb(!!value);
    ipcRenderer.on('mb-pinned-changed', listener);
    return () => ipcRenderer.removeListener('mb-pinned-changed', listener);
  },
  // 隐藏当前窗口（进程与下载继续；重新显示需在 cmd 中运行 show.js 连接本地服务）
  hideWindow: () => ipcRenderer.send('mb-hide-window'),
  // Alt+左键拖动移动窗口：仅在「按下」与「松开」两个时刻通知主进程，
  // 拖动过程中的位置更新由主进程按屏幕坐标自行轮询（见 window-drag.js）。
  windowDragStart: (clientX, clientY) =>
    ipcRenderer.send('mb-window-drag-start', { clientX, clientY }),
  windowDragEnd: () => ipcRenderer.send('mb-window-drag-end')
});
