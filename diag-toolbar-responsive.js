'use strict';

/**
 * 工具栏响应式验证：窗口变窄时按钮不能被裁掉。
 *
 * 复现与判据：
 *  1) 逐个宽度测量：extra-buttons / nav-buttons / win-controls 里
 *     每个按钮的**可见性**（是否完全在视口内、有没有被裁切）。
 *  2) 关键：不能只看「元素存在」，要看它**是否真的完整可见**——
 *     flex 压缩会让按钮溢出到视口外，此时 getBoundingClientRect().right
 *     会大于视口宽度。截图里正是右侧几个图标「消失」。
 *  3) URL 输入框可以被压缩（它本来就该让位），但**按钮组不行**。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 工具栏里必须始终完整可见的按钮（任何宽度下都不许被裁）。
// 注意：媒体查询会按设计隐藏部分次要按钮（display:none），
// 那是「折叠」不是「裁切」，两者必须区分开。
const MUST_VISIBLE = [
  ['.nav-buttons', '#back'],
  ['.nav-buttons', '#forward'],
  ['.nav-buttons', '#reload'],
  ['.extra-buttons', '#history'],
  ['.extra-buttons', '#downloads'],
  ['.extra-buttons', '#video-dl'],
  ['.extra-buttons', '#save-page'],
  ['.extra-buttons', '#eraser'],
  ['.extra-buttons', '#settings'],
  ['.win-controls', '#win-min'],
  ['.win-controls', '#win-max'],
  ['.win-controls', '#win-close'],
  ['.url-bar', '#bookmark'],
];

// 允许在窄窗口被折叠隐藏的按钮（每个都有替代入口）
const FOLDABLE = ['#home', '#find', '#zoom', '#devtools'];

app.whenReady().then(async () => {
  const fails = [];
  const log = [];

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 800,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      sandbox: false,
    },
  });
  const wc = win.webContents;
  wc.on('console-message', (_e, _l, m) => {
    if (m && !/Security|Policy|exposes|consult|electronjs/.test(m)) {
      console.log('  [页面] ' + m);
    }
  });

  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `).catch(() => {});

  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1600);
  await wc.executeJavaScript("document.body.className = '';");
  await wait(200);

  const measure = () =>
    wc.executeJavaScript(`(() => {
      const vw = window.innerWidth;
      const ids = ${JSON.stringify(MUST_VISIBLE.map((m) => m[1]))};
      const foldable = ${JSON.stringify(FOLDABLE)};
      const out = { vw, items: [], folded: [] };
      for (const id of ids) {
        const el = document.querySelector(id);
        if (!el) { out.items.push({ id, missing: true }); continue; }
        const r = el.getBoundingClientRect();
        // 裁切判定：右边界超出视口，或宽度被压到 0
        const clipped = r.right > vw + 0.5 || r.width <= 0.5 || r.left < -0.5;
        out.items.push({
          id,
          left: Math.round(r.left),
          right: Math.round(r.right),
          w: Math.round(r.width),
          clipped,
        });
      }
      // 统计被折叠（display:none）的次要按钮
      for (const id of foldable) {
        const el = document.querySelector(id);
        if (el && getComputedStyle(el).display === 'none') out.folded.push(id);
      }
      const tb = document.querySelector('.toolbar');
      out.toolbarW = Math.round(tb.getBoundingClientRect().width);
      out.scrollW = tb.scrollWidth;
      const eb = document.querySelector('.extra-buttons');
      out.extraW = Math.round(eb.getBoundingClientRect().width);
      out.extraScrollW = eb.scrollWidth;
      return out;
    })()`);

  const WIDTHS = [1400, 1200, 1100, 1000, 900, 800, 760, 700, 660, 600, 560, 500, 420, 360];

  for (const w of WIDTHS) {
    win.setSize(w, 800);
    await wait(320);
    const m = await measure();
    const clipped = m.items.filter((i) => i.missing || i.clipped);
    log.push([
      '宽 ' + String(w).padStart(4) + ' → 工具栏' + String(m.toolbarW).padStart(4) +
      ' extra(' + m.extraW + '/' + m.extraScrollW + ')',
      clipped.length
        ? '被裁: ' + clipped.map((i) => i.id).join(',')
        : '完整' + (m.folded.length ? '（已折叠: ' + m.folded.join(',') + '）' : ''),
    ]);
    if (clipped.length) {
      fails.push('宽度 ' + w + ' 时这些按钮被裁切: ' +
        clipped.map((i) => i.id + '(w=' + (i.w || 0) + ',right=' + i.right + ')').join(', '));
    }
  }

  // 额外断言：折叠掉的按钮在宽窗口下必须回来（媒体查询只应在窄时生效）
  win.setSize(1400, 800);
  await wait(350);
  const wide = await measure();
  log.push(['宽 1400 折叠情况', wide.folded.length ? wide.folded.join(',') : '无（正确）']);
  if (wide.folded.length) {
    fails.push('宽度 1400 时不应有按钮被折叠，实际: ' + wide.folded.join(','));
  }

  // 窄窗口下被折叠的按钮，其功能必须有替代入口（右键菜单 / 快捷键），
  // 否则等于功能直接消失。
  win.setSize(560, 800);
  await wait(350);
  const narrow = await measure();
  log.push(['宽 560 折叠情况', narrow.folded.join(',') || '无']);

  // 折叠名单只允许是那四个有替代入口的按钮
  const ALLOWED_FOLD = ['#home', '#find', '#zoom', '#devtools'];
  for (const id of narrow.folded) {
    if (ALLOWED_FOLD.indexOf(id) < 0) {
      fails.push('窄窗口折叠了不该折叠的按钮 ' + id + '（它没有替代入口）');
    }
  }
  // 关键功能必须仍在 DOM 里可见（不能被折叠掉）
  for (const id of ['#history', '#downloads', '#video-dl', '#save-page',
                    '#eraser', '#settings', '#win-min', '#win-max', '#win-close']) {
    const el = await wc.executeJavaScript(
      `(function(){var e=document.querySelector('${id}');` +
      `return e ? getComputedStyle(e).display !== 'none' : false;})()`
    );
    if (!el) fails.push('窄窗口下关键按钮 ' + id + ' 不可见（不应被折叠）');
  }

  // 打开右键菜单，检查被折叠的功能里哪些有菜单项
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:60, button:2}));
  `);
  await wait(400);
  const menuItems = await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li')).map(li => li.textContent)
  `);
  log.push(['右键菜单项', JSON.stringify(menuItems)]);

  // devtools 必须能在右键菜单里找到（它是被折叠的按钮之一）
  if (narrow.folded.indexOf('#devtools') >= 0) {
    if (!menuItems.some((t) => t.indexOf('开发者工具') >= 0)) {
      fails.push('#devtools 被折叠但右键菜单里没有「开发者工具」');
    }
  }

  console.log('\n======== 工具栏窄宽度适配验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(42, ' ') + v));
  console.log('=========================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：所有宽度下工具栏按钮均完整可见。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
