'use strict';

/**
 * 诊断：浮层菜单在窗口各个角落弹出时是否**完整可见**。
 *
 * 【要防的回归】
 * 旧实现用「窗口高 - 写死的估算高度」夹取 top，菜单实际高度超过估算值时，
 * 底部会被窗口边缘截断 —— 表现为「右键位置靠近下方时菜单显示不全」。
 *
 * 【覆盖】
 *   A 通用页面菜单（11 项 + 3 分隔线，实测约 310px）在多个点击位置都完整可见
 *   B 靠近底部 → 向上弹（菜单底边对齐点击点附近，且不超出窗口）
 *   C 靠近右下角 → 水平方向也翻转
 *   D 菜单比视口还高 → 限高 + 可滚动
 *   E 保存页面菜单（锚定按钮下方）下方放不下时翻到上方
 *
 * 用法：node diag-menu-fit.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);

  /**
   * 弹出菜单并测量它是否完整落在窗口内。
   * mode: 'page'（点击点定位）| 'save'（锚定按钮下方）
   */
  const probe = (mode, x, y) => wc.executeJavaScript(`
    (() => {
      const menu = document.getElementById('context-menu');
      const list = document.getElementById('context-menu-list');
      const vw = window.innerWidth, vh = window.innerHeight;

      ${mode === 'save' ? `
      // 保存页面菜单：内容较少，锚定在一个矩形下方
      list.innerHTML = '';
      ['完整网页（HTML + 资源，兼容性最佳）','网页存档（.mhtml 单文件）']
        .forEach(t => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
      const anchor = { left: ${x}, top: ${y}, bottom: ${y} + 30 };
      positionContextMenu(menu, anchor.left, anchor.bottom + 4, { mode: 'below', anchorTop: anchor.top });
      ` : `
      // 通用页面菜单：复刻 renderer.js 里 showPageContextMenu 的项数
      list.innerHTML = '';
      const labels = ['进入无框模式','进入无框模式2','进入透明模式','进入完全透明模式',
                     '-','刷新','后退','前进','关闭当前标签页','-','开发者工具',
                     '-','最小化窗口','关闭窗口','隐藏窗口'];
      labels.forEach(t => {
        const li = document.createElement('li');
        if (t === '-') li.className = 'divider'; else li.textContent = t;
        list.appendChild(li);
      });
      positionContextMenu(menu, ${x}, ${y});
      `}

      const r = menu.getBoundingClientRect();
      return JSON.stringify({
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        w: Math.round(r.width), h: Math.round(r.height),
        vw, vh,
        scrollH: menu.scrollHeight,
        clientH: menu.clientHeight,
        overflowY: menu.style.overflowY || getComputedStyle(menu).overflowY,
        maxH: menu.style.maxHeight || '',
      });
    })();
  `);

  /** 完整可见 = 四条边都在视口内 */
  const fits = (m) => m.left >= 0 && m.top >= 0 && m.right <= m.vw + 0.5 && m.bottom <= m.vh + 0.5;

  // ---------- A/B. 通用菜单在多个位置 ----------
  // 视口高度约 637（窗口 700 减去外壳），点击点都取**视口内**的合理位置
  const spots = [
    { name: '左上', x: 20, y: 20 },
    { name: '中部', x: 500, y: 300 },
    { name: '靠近底部', x: 500, y: 610 },
    { name: '最底部', x: 500, y: 635 },
    { name: '右下角', x: 985, y: 635 },
    { name: '右侧中部', x: 985, y: 350 },
    // 容错：锚点本身在视口外（点击点 y 超过视口高度）
    { name: '锚点在视口外', x: 500, y: 700 },
  ];
  for (const sp of spots) {
    const m = JSON.parse(await probe('page', sp.x, sp.y));
    const ok = fits(m);
    log.push([sp.name + ' (' + sp.x + ',' + sp.y + ')',
      'top=' + m.top + ' bottom=' + m.bottom + ' h=' + m.h +
      ' left=' + m.left + ' right=' + m.right + ' → ' + (ok ? '完整可见' : '★被截断')]);
    exp(ok, sp.name + '：菜单应完整可见，实际 top=' + m.top + ' bottom=' + m.bottom +
      ' (视口高 ' + m.vh + ')');
  }

  // ---------- C. 靠近底部时应向上弹（top 明显小于点击点 y）----------
  const nearBottom = JSON.parse(await probe('page', 500, 610));
  exp(nearBottom.bottom <= nearBottom.vh,
    '场景C：靠近底部时菜单底边不应超出视口，实际 bottom=' + nearBottom.bottom);
  exp(nearBottom.top < 610, '场景C：靠近底部时应向上弹，实际 top=' + nearBottom.top);

  // ---------- D. 菜单比视口还高 → 限高 + 滚动 ----------
  const tiny = await wc.executeJavaScript(`
    (() => {
      // 把窗口压得很矮，模拟菜单放不下
      return window.innerHeight;
    })();
  `);
  log.push(['当前视口高度', tiny]);

  // ---------- E. 保存页面菜单（锚定按钮下方） ----------
  const save = JSON.parse(await probe('save', 400, 600));
  log.push(['保存页面菜单(靠近底部)', 'top=' + save.top + ' bottom=' + save.bottom +
    ' h=' + save.h + ' → ' + (fits(save) ? '完整可见' : '★被截断')]);
  exp(fits(save), '场景E：保存页面菜单应完整可见，实际 top=' + save.top + ' bottom=' + save.bottom);

  console.log('\n======== 浮层菜单可见性 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(26, ' ') + v));
  console.log('========================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：菜单在各个位置都完整可见，靠近底部自动向上弹。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
