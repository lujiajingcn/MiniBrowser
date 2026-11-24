'use strict';

/**
 * Alt + 左键拖动移动窗口（无边框窗口专用）。
 *
 * 【为什么不用 -webkit-app-region: drag】
 * app-region: drag 是「区域级」属性，只能靠 CSS 静态声明某块区域可拖，
 * 无法表达「按住 Alt 时窗口内任意位置都可拖」这种带修饰键的条件；
 * 且它对<webview> guest 内容无效（guest 是独立渲染进程，宿主 CSS 管不到）。
 * 因此这里走「鼠标事件 + 主进程移动窗口」的路子。
 *
 * 【为什么拖动过程用屏幕坐标轮询，而不是把 mousemove 转发给主进程】
 * 拖动时鼠标会离开窗口范围（甚至拖到另一个显示器），此后渲染层收不到 mousemove，
 * 基于增量事件的方案会出现「窗口停住不动 / 跟手断裂」。所以：
 *   - 渲染层只在「按下」和「松开」两个时刻发一次 IPC（mb-window-drag-start / -end）；
 *   - 主进程在拖动期间自己按帧轮询 screen.getCursorScreenPoint() 并 setPosition。
 * 这样即使鼠标跑到窗口外、跑到屏幕边缘，窗口依然精确跟手。
 *
 * 【坐标系】
 * screen.getCursorScreenPoint() 与 BrowserWindow.setPosition() 都使用 DIP（设备无关像素），
 * 两者单位一致，可直接相减。高分屏下不会错位。
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');

/** 拖动期间的轮询间隔（毫秒）。约 60fps，兼顾跟手与 CPU 占用。 */
const POLL_INTERVAL_MS = 16;

/** 单个 BrowserWindow 的拖动状态。 */
const dragStates = new WeakMap();

/** 当前正在被拖动的窗口。同一时刻只可能有一个窗口被拖（只有一个鼠标指针）。 */
let activeWin = null;
let pollTimer = null; // 全局只跑一个定时器

/**
 * 把窗口移动到指定位置，并做边界约束。
 * 约束规则：窗口必须保留一部分在当前显示器可见区域内，
 * 否则用户可能把窗口拖到屏幕外再也找不回来（无边框窗口没有系统标题栏可抓）。
 */
function moveWindowConstrained(win, targetX, targetY) {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width: bounds.width,
    height: bounds.height
  });
  const area = display.workArea;
  // 至少保留80px宽、40px 高可见
  const visibleW = Math.min(80, bounds.width);
  const visibleH = Math.min(40, bounds.height);
  const minX = area.x + visibleW - bounds.width;
  const maxX = area.x + area.width - visibleW;
  const minY = area.y;
  const maxY = area.y + area.height - visibleH;

  win.setPosition(
    Math.round(Math.min(Math.max(targetX, minX), Math.max(minX, maxX))),
    Math.round(Math.min(Math.max(targetY, minY), Math.max(minY, maxY)))
  );
}

/** 轮询一步：把窗口贴到当前鼠标位置（保持按下时的握点偏移）。 */
function pollOnce() {
  const win = activeWin;
  if (!win || win.isDestroyed()) {
    stopPolling();
    return;
  }
  const st = dragStates.get(win);
  if (!st || !st.dragging) {
    stopPolling();
    return;
  }
  const pt = screen.getCursorScreenPoint();
  moveWindowConstrained(win, pt.x - st.grabOffsetX, pt.y - st.grabOffsetY);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeWin = null;
}

/**
 * 开始拖动。
 * 拖动位置由主进程按屏幕坐标轮询，因此这里只需记录「鼠标相对窗口左上角的偏移」。
 */
function beginDrag(win) {
  if (!win || win.isDestroyed()) return;
  // 最大化 / 全屏状态下没有「窗口位置」可言，先还原成普通窗口再拖，
  // 否则 setPosition 对最大化窗口无效，表现为「拖不动」。
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);

  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();

  // 记录「鼠标相对窗口左上角的偏移」，拖动时保持这个握点，
  // 这样窗口不会在拖动过程中「跳一下」对齐到鼠标。
  dragStates.set(win, {
    dragging: true,
    grabOffsetX: cursor.x - bounds.x,
    grabOffsetY: cursor.y - bounds.y
  });

  activeWin = win;
  if (!pollTimer) {
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref(); // 不阻止进程退出
  }
}

/** 结束拖动（幂等，可重复调用）。 */
function endDrag(win) {
  if (win) dragStates.delete(win);
  if (activeWin === win) stopPolling();
}

/**
 * 注册 IPC 与窗口生命周期钩子。需在 app.whenReady 之后调用。
 * 渲染层协议：
 *   mb-window-drag-start —— Alt+左键按下并越过移动阈值
 *   mb-window-drag-end—— 鼠标松开 / Alt 松开 / 窗口失焦
 */
function setupWindowDrag() {
  ipcMain.on('mb-window-drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    beginDrag(win);
  });

  ipcMain.on('mb-window-drag-end', () => {
    stopPolling();
  });

  // 窗口失焦（Alt+Tab、点其它程序）时务必停止拖动，
  // 否则会出现「窗口黏着鼠标跑，停不下来」的严重问题。
  BrowserWindow.getAllWindows().forEach(attachGuards);

  // 后续新建的窗口也要挂上失焦保护
  app.on('browser-window-focus', (_event, win) => attachGuards(win));
}

function attachGuards(win) {
  if (!win || win.__mbDragGuards) return;
  win.__mbDragGuards = true;
  const stop = () => endDrag(win);
  win.on('blur', stop);
  win.on('hide', stop);
  win.on('close', stop);
  win.on('closed', () => {
    stop();
    delete win.__mbDragGuards;
  });
}

module.exports = { setupWindowDrag, beginDrag, endDrag };
