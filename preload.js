'use strict';

const { contextBridge, shell, ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * 受控的桥接层：只暴露两个安全方法给渲染进程，
 * 不暴露完整的 Node / Electron 能力，避免任意网页篡改宿主。
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 用系统默认浏览器打开外部协议（mailto、非 http(s) 等）
  openExternal: (url) => shell.openExternal(url),
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
  // 请求主进程打开一个独立的新窗口
  createWindow: (url) => ipcRenderer.send('mb-create-window', url)
});
