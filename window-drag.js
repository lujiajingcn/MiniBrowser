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
const { computePositionLimits, clampPosition } = require('./window-bounds');

/**
 * 调试开关：设 MB_DRAG_DEBUG=1 可打印拖动过程
 * （want 目标位置 / 实际 bounds / endDrag 的调用来源）。
 * 排查「拖动时窗口跑偏、卡住、尺寸变化」这类问题时很有用。
 */
const DEBUG = !!process.env.MB_DRAG_DEBUG;

/** 拖动期间的轮询间隔（毫秒）。约 60fps，兼顾跟手与 CPU 占用。 */
const POLL_INTERVAL_MS = 16;

/** 单个 BrowserWindow 的拖动状态。 */
const dragStates = new WeakMap();

/** 当前正在被拖动的窗口。同一时刻只可能有一个窗口被拖（只有一个鼠标指针）。 */
let activeWin = null;
let pollTimer = null; // 全局只跑一个定时器
// 拖动开始时的窗口尺寸，resize 兜底据此把尺寸还原
let dragSize = null;
// 失焦后延迟结束拖动的定时器
let blurTimer = null;
// 失焦后多久还没等到结束信号就结束拖动（ms）
const BLUR_END_DELAY = 400;

/**
 * 拖动期间禁止窗口被 resize。
 *
 * 【为什么要防】
 * frame:false 的窗口在 Windows 上仍保留 Chromium 的**不可见 resize 边框**。
 * 正常情况下按住 Alt 拖动该边框，Windows 的标准行为是「强制移动窗口」而非调整大小，
 * 但这个 Alt 判定发生在 browser 进程的原生命中测试里，与应用自己的 Alt 检测
 * （渲染进程 DOM 事件的 altKey）并不是同一条链路。一旦两者不同步：
 *   - 应用按「Alt + 拖动」把窗口跟着鼠标移动；
 *   - Chromium 同时按「拖动边框」调整窗口尺寸；
 * 两者叠加就表现为「按住 Alt 拖动过程中，窗口不断变大」。
 *
 * 【为什么用 will-resize 而不是 setResizable(false)】
 * setResizable 会重建窗口的 non-client 区域，**引发一次 blur**，
 * 而 window-drag.js 里 blur 是「结束拖动」的触发条件之一 ——
 * 于是拖动会在 setResizable 之后立刻中断（实测：窗口固定走一小段就停住，
 * 且移动距离与鼠标步数无关）。
 * will-resize 是 Electron 专门为「阻止 resize」提供的钩子，
 * 不改动窗口样式、不引发 blur，是这里正确的做法。
 *
 * 真正的防护点是 attachGuards() 里注册的 will-resize 拦截器。
 */
function isDragging(win) {
  return activeWin === win;
}

/**
 * 拖动期间禁止窗口被 resize。
 *
 * 【为什么要防】
 * frame:false 的窗口在 Windows 上仍保留 Chromium 的**不可见 resize 边框**，
 * 鼠标滑到窗口边缘就会命中它 → Chromium 开始 resize。
 * 而拖动窗口时鼠标与窗口的相对位置本应保持不变，一旦因为边界约束
 * 把窗口「拉回」屏幕内，鼠标就会重新贴上窗口边缘 → 反复命中 →
 * 窗口一点点变大（正反馈），表现为「按住 Alt 拖动过程中窗口不断变大」。
 *
 * 【为什么用 setResizable 而不是只靠 will-resize】
 * will-resize 是「事后否决」，依赖「拦截的那一刻恰好处于拖动态」。
 * 只要 activeWin 因失焦被清空、或拖动刚开始还没建立状态，就漏一次，
 * 而漏一次就足以让窗口变大并进入正反馈。
 * setResizable(false) 是「从源头消除」—— 边框热区根本不存在，
 * Chromium 连 resize 意图都不会产生（实测 will-resize 触发 0 次）。
 *
 * 【代价：它会引发一次 blur】
 * setResizable 会重建窗口的 non-client 区域，导致窗口失焦。
 * 曾经的 blur 处理是「立即结束拖动」，那样拖动会被自己的保护措施打断。
 * 现在 blur 改为**延迟结束**（见 attachGuards），那次自发的 blur 会被吸收。
 */
function setResizableDuringDrag(win, resizable) {
  if (!win || win.isDestroyed()) return;
  if (win.isResizable() === resizable) return;
  try {
    win.setResizable(resizable);
  } catch (_) {
    /* 某些平台/状态下可能失败，忽略即可 */
  }
}

/**
 * 把窗口移动到指定位置，并做边界约束。
 * 约束规则：窗口必须完全（或至少一部分）留在当前显示器可见区域内，
 * 否则用户可能把窗口拖到屏幕外再也找不回来（无边框窗口没有系统标题栏可抓）。
 */
function moveWindowConstrained(win, targetX, targetY, cursorPoint) {
  const bounds = win.getBounds();
  // 用**鼠标所在的显示器**决定边界，而不是「目标窗口矩形」。
  //
  // getDisplayMatching 是按矩形与各显示器的重叠面积来匹配的，窗口一旦跨过
  // 显示器边界，匹配到的显示器就会变、workArea 随之改变，约束会突然收紧 ——
  // 实测表现为窗口在多屏环境里「走到某个位置就卡住不动」，
  // 而 want（鼠标位置）还在继续增大。
  // 语义上也更合理：把窗口限制在**用户正在操作的那块屏幕**内。
  const anchor = cursorPoint || {
    x: Math.round(targetX + bounds.width / 2),
    y: Math.round(targetY + bounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(anchor);
  const limits = computePositionLimits(display.workArea, bounds);
  const pos = clampPosition(limits, targetX, targetY);
  win.setPosition(pos.x, pos.y);
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
  const want = { x: pt.x - st.grabOffsetX, y: pt.y - st.grabOffsetY };
  if (DEBUG) {
    const b = win.getBounds();
    console.log('[drag] poll want=(' + want.x + ',' + want.y + ') bounds=(' +
      b.x + ',' + b.y + ')');
  }
  moveWindowConstrained(win, want.x, want.y, pt);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
  // 恢复可缩放。
  // 放在这里而不是 endDrag()：stopPolling 是**所有**停止路径的汇合点
  // （ipcMain 的 mb-window-drag-end 直接调它、blur 的兜底调它、
  // pollOnce 发现窗口已销毁也会调它），放这里才保证不会漏恢复。
  if (activeWin) setResizableDuringDrag(activeWin, true);
  dragSize = null;
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

  // ★ 从源头消除 Chromium 的不可见 resize 边框。
  //
  // 【为什么必须这么做】
  // frame:false 的窗口在 Windows 上仍保留 4~8px 的不可见 resize 边框，
  // 鼠标滑到窗口边缘就会命中它 → Chromium 开始 resize。
  // 而拖动窗口时鼠标与窗口的相对位置本应保持不变，一旦因为边界约束
  // 把窗口「拉回」屏幕内，鼠标就会重新贴上窗口边缘 → 反复命中 →
  // 窗口一点点变大（正反馈）。
  //
  // setResizable(false) 直接让这条边框消失（实测 will-resize 触发 0 次，
  // 拖窗口右下角尺寸零变化），比事后用 will-resize 否决可靠得多 ——
  // 后者依赖「拦截时恰好处于拖动态」，任何一次状态错位就漏了。
  //
  // 【代价：它会引发一次 blur】
  // setResizable 会重建窗口的 non-client 区域，导致窗口失焦。
  // 而 blur 在这里曾被当作「结束拖动」的信号 —— 那样拖动会被自己的
  // 保护措施打断。现在 blur 改为**延迟结束**（见 attachGuards），
  // 那次自发的 blur 会被吸收掉，拖动不受影响。
  setResizableDuringDrag(win, false);

  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();

  // 记录「鼠标相对窗口左上角的偏移」，拖动时保持这个握点，
  // 这样窗口不会在拖动过程中「跳一下」对齐到鼠标。
  dragStates.set(win, {
    dragging: true,
    grabOffsetX: cursor.x - bounds.x,
    grabOffsetY: cursor.y - bounds.y
  });

  // 记下拖动开始时的尺寸，resize 兜底据此还原
  dragSize = { width: bounds.width, height: bounds.height };

  activeWin = win;
  if (!pollTimer) {
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref(); // 不阻止进程退出
  }
}

/** 结束拖动（幂等，可重复调用）。 */
function endDrag(win) {
  if (DEBUG) {
    console.log('[drag] endDrag win=' + (win && win.id) +
      ' activeWin=' + (activeWin && activeWin.id) +
      ' stack=' + new Error().stack.split('\n').slice(1, 4).join(' <- '));
  }
  dragStates.delete(win);
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

  // 给所有窗口挂上失焦保护与拖动期间的 resize 兜底拦截。
  //
  // 用 browser-window-created 而不是 browser-window-focus：
  // focus 事件要等窗口真的被激活才触发，而用户完全可能在窗口刚创建、
  // 还没获得焦点时就开始拖动 —— 那时守卫还没挂上，
  // 「拖动期间阻止 resize」的兜底就会漏掉。
  BrowserWindow.getAllWindows().forEach(attachGuards);
  app.on('browser-window-created', (_event, win) => attachGuards(win));
}

function attachGuards(win) {
  if (!win || win.__mbDragGuards) return;
  win.__mbDragGuards = true;

  // 拖动期间**无条件**阻止任何 resize。
  //
  // will-resize 是 Electron 为「阻止 resize」提供的官方钩子：
  // 在这里 preventDefault，Chromium 保留的不可见 resize 边框就拉不动窗口。
  // 它不改动窗口样式，因此不会引发 blur、不会打断拖动本身。
  win.on('will-resize', (e) => {
    if (isDragging(win)) e.preventDefault();
  });

  // 兜底：万一 resize 真的发生了（will-resize 没覆盖到的路径，
  // 或拖动已开始但 activeWin 还没建立的那一瞬间），立刻把尺寸还原。
  //
  // 【为什么不能依赖 activeWin】
  // will-resize 的拦截条件是 activeWin === win，而 activeWin 会被 blur 清空；
  // 鼠标还按着时失焦（窗口被遮挡、焦点转移）很常见，
  // 那之后 Chromium 的边框 resize 就再也拦不住了 —— 窗口会持续变大。
  // 这个兜底不依赖 activeWin 的存续，只依赖「当前正在拖动」这个事实。
  //
  // 【为什么要 1px 容差】
  // Windows 上 setPosition 之后，getBounds() 读回的高度偶尔会与实际相差 1px
  // （边框/坐标取整造成的读数抖动，不是真的 resize ——
  // 那种情况下 will-resize 触发次数是 0）。
  // 若严格比较，每次 poll 都会被误判成「尺寸被改了」而反复 setBounds 还原，
  // 白跑大量调用还可能引起可见抖动。
  // 所以只有偏差**超过 1px** 才认为发生了真正的 resize。
  win.on('resize', () => {
    if (!isDragging(win) || !dragSize) return;
    const b = win.getBounds();
    if (Math.abs(b.width - dragSize.width) <= 1 &&
        Math.abs(b.height - dragSize.height) <= 1) return;
    try {
      win.setBounds({ x: b.x, y: b.y, width: dragSize.width, height: dragSize.height });
    } catch (_) {
      /* ignore */
    }
  });

  const stop = () => endDrag(win);
  win.on('hide', stop);
  win.on('close', stop);
  win.on('closed', () => {
    stop();
    delete win.__mbDragGuards;
  });

  // 失焦**不立即**结束拖动。
  //
  // 【为什么】
  // 失焦不等于拖动结束 —— 鼠标还按着时，窗口被遮挡、焦点转移都会触发 blur，
  // 若此时立刻结束拖动，Chromium 的边框 resize 就会失去拦截而让窗口变大。
  // 真正的结束信号是 mouseup / Alt 松开（由渲染层通知）。
  //
  // 【为什么还需要这个兜底】
  // 鼠标在别处松开时，目标窗口收不到 mouseup，拖动状态会悬着，
  // 所以延迟一段时间后若仍没有收到结束信号，就结束它。
  win.on('blur', () => {
    if (!isDragging(win)) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (isDragging(win)) stopPolling();
    }, BLUR_END_DELAY);
  });
}

module.exports = { setupWindowDrag, beginDrag, endDrag };
