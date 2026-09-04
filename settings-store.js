'use strict';

/**
 * 主进程设置存储。
 *
 * 与渲染进程的 localStorage('mb_settings') 分开，原因：下载目录、是否询问保存位置
 * 这类设置只有主进程用得到（下载发生在主进程），渲染进程读不到也不能作为唯一数据源。
 * 落到 app.getPath('userData')/settings.json，进程内做一层缓存，写失败不抛错。
 */

const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  downloadDir: '', // 空串表示使用系统默认「下载」目录
  askWhereToSave: false // 每次下载是否弹出保存位置对话框
};

let cache = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    cache = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (_) {
    // 首次运行或文件损坏：回落默认值
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function getAllSettings() {
  return Object.assign({}, load());
}

function getSetting(key) {
  return load()[key];
}

function setSetting(key, value) {
  const s = load();
  s[key] = value;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
  } catch (_) {
    /* 只读环境等场景忽略写入失败 */
  }
  return s[key];
}

/**
 * 注册主进程设置的 IPC 通道（供设置面板读写）。
 *
 * 刻意放在本模块而不是 main.js：这样诊断脚本只要 require 本模块并调用本函数，
 * 就能与生产环境注册**同一份**处理器，避免在测试里复制一份逻辑导致测了个空壳。
 */
function setupSettingsIpc() {
  ipcMain.handle('mb-settings-get', () => getAllSettings());
  ipcMain.handle('mb-settings-set', (event, key, value) => setSetting(key, value));

  // 弹出系统目录选择框，确定后写入设置并返回路径；取消时返回空串
  ipcMain.handle('mb-choose-download-dir', () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const picked = dialog.showOpenDialogSync(win, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (!picked || !picked.length) return '';
    return setSetting('downloadDir', picked[0]);
  });
}

module.exports = { getSetting, setSetting, getAllSettings, setupSettingsIpc };
