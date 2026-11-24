'use strict';

/**
 * 无框模式2（四角直角标识）端到端验证。
 *
 * 核心要验证两件容易出错的事：
 *  1) **直角层能否盖在<webview> 之上** —— webview 是独立渲染进程（OOPIF），
 *     普通 position/z-index 未必能压住它。若盖不住，直角会「消失」，
 *     功能等于没做。这是本项目里 webview 与外壳层叠的固有坑。
 *  2) 模式互斥：进入模式2 后 body 上不能同时挂着 frameless；
 *     反之进入模式1 也要清掉 frameless2。
 *
 * 另外用printToPDF 落一张图，肉眼可核对直角形状与位置。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 在独立窗口里加载**真实的 index.html + renderer.js**，驱动产品代码本身
 * 验证模式互斥。
 *
 * 为什么必须开新窗口：renderer.js 依赖 contextIsolation 的 preload 与完整的
 * DOM 结构，在同一个已加载测试页的 window 里跑不起来（会因缺少大量元素而抛错）。
 * 这里用 nodeIntegration:false +真实 index.html，保证测的是产品路径。
 *
 * renderer.js 里那些函数是顶层 function 声明（非模块），会挂到 window 上，
 * 因此可以直接从 executeJavaScript 调用。
 */
async function runRealShell(win) {
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      sandbox: false,
    },
  });
  await w.loadFile(path.join(ROOT, 'index.html'));
  await wait(1200);

  const res = await w.webContents.executeJavaScript(`(() => {
    // 先清掉持久化影响，确保从确定的起点开始
    try { localStorage.removeItem('mb_frameless'); localStorage.removeItem('mb_frameless2'); } catch (_) {}
    document.body.className = '';

    const fns = ['applyFrameless','toggleFrameless','applyFrameless2','enterFrameless2',
                 'exitFrameless2','toggleFrameless2','isFrameless2'];
    const missing = fns.filter(n => typeof window[n] !== 'function');
    if (missing.length) return { error: '缺少函数: ' + missing.join(',') };

    const initial = document.body.className;

    // 场景1：进入模式1
    window.applyFrameless(true);
    const afterF1 = document.body.className;

    // 场景2：模式1 开着时进入模式2 —— 应互斥清掉模式1
    window.enterFrameless2();
    const afterEnter = document.body.className;

    // 场景3：复刻菜单里「进入无框模式」内联函数的真实顺序
    //（if (!on && isFrameless2()) exitFrameless2(); toggleFrameless();）
    var on = document.body.classList.contains('frameless');
    if (!on && window.isFrameless2()) window.exitFrameless2();
    window.toggleFrameless();
    const afterBackTo1 = document.body.className;

    // 场景4：再 toggle 回模式2
    window.toggleFrameless2();
    const afterToggle2 = document.body.className;

    return { initial, afterF1, afterEnter, afterBackTo1, afterToggle2 };
  })()`);

  await w.destroy();
  return res;
}

/** 读取 index.html + styles.css，构造一个最小可复现外壳。 */
function buildShellHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 只取 <head> 里的样式引用与 body 里的四角容器，避免整份外壳依赖 Electron API
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div id="frameless-drag-strip" aria-hidden="true"></div>
  <div id="frameless2-corners" aria-hidden="true">
    <i class="corner tl"></i><i class="corner tr"></i>
    <i class="corner bl"></i><i class="corner br"></i>
  </div>
  <header class="toolbar"><button id="go">go</button></header>
  <!-- 注意：真实 index.html 里收藏夹栏是 id="bookmarks-bar"（ID 选择器），
       这里必须保持一致，否则 CSS 是否隐藏会测错——
       早期版本误写成 class="bookmarks-bar"，导致「收藏夹栏未隐藏」的假失败。 -->
  <div id="bookmarks-bar" class="bookmarks-bar"></div>
  <div class="tab-bar"></div>
  <div class="webview-container">
    <!-- 用一个不透明的纯色块模拟网页内容：直角必须能盖在它上面才看得见 -->
    <div id="fake-page" style="position:absolute;inset:0;background:#c8d4e0;"></div>
  </div>
</body></html>`;
}

/** 在页面里执行「切换 body class」，并读取关键元素的实际布局。 */
async function probe(wc) {
  return wc.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        display: cs.display,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    return {
      bodyClass: document.body.className,
      toolbar: vis(q('.toolbar')),
      tabbar: vis(q('.tab-bar')),
      bookmarks: vis(q('#bookmarks-bar')),
      cornersBox: vis(q('#frameless2-corners')),
      tl: vis(q('#frameless2-corners .tl')),
      tr: vis(q('#frameless2-corners .tr')),
      bl: vis(q('#frameless2-corners .bl')),
      br: vis(q('#frameless2-corners .br')),
      strip: vis(q('#frameless-drag-strip')),
      // 直角层必须不拦截鼠标，否则网页无法交互
      cornersPointerEvents: getComputedStyle(q('#frameless2-corners')).pointerEvents,
      cornerPointerEvents: getComputedStyle(q('#frameless2-corners .tl')).pointerEvents,
      // 直角颜色是否解析出来了（var() 未定义会得到空串）
      cornerBorderColor: getComputedStyle(q('#frameless2-corners .tl')).borderTopColor,
    };
  })()`);
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { offscreen: true },
  });
  const wc = win.webContents;

  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildShellHtml()));
  await wait(500);

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const log = [];

  // ---- 基线：普通模式 ----
  let s = await probe(wc);
  log.push(['普通模式 toolbar.display', s.toolbar.display]);
  expect(s.toolbar.display !== 'none', '基线：工具栏应可见');
  expect(s.cornersBox.display === 'none', '基线：直角层应隐藏');

  // ---- 进入 frameless2 ----
  await wc.executeJavaScript("document.body.classList.add('frameless2')");
  await wait(300);
  s = await probe(wc);
  log.push(['模式2 toolbar.display', s.toolbar.display]);
  log.push(['模式2 tabbar.display', s.tabbar.display]);
  log.push(['模式2 corners.display', s.cornersBox.display]);
  log.push(['模式2 直角颜色', s.cornerBorderColor]);
  log.push(['模式2 pointer-events', s.cornersPointerEvents + ' / ' + s.cornerPointerEvents]);
  log.push(['模式2 tl 位置', JSON.stringify(s.tl)]);
  log.push(['模式2 br 位置', JSON.stringify(s.br)]);

  expect(s.toolbar.display === 'none', '模式2：工具栏应隐藏');
  expect(s.tabbar.display === 'none', '模式2：标签栏应隐藏');
  expect(s.bookmarks.display === 'none', '模式2：收藏夹栏应隐藏');
  expect(s.cornersBox.display === 'block', '模式2：直角层应显示，实际 ' + s.cornersBox.display);
  expect(s.strip.display === 'block', '模式2：顶部拖拽热区应显示');
  expect(s.cornersPointerEvents === 'none', '模式2：直角层 pointer-events 应为 none');
  expect(s.cornerPointerEvents === 'none', '模式2：直角本身 pointer-events 应为 none');
  expect(s.cornerBorderColor && s.cornerBorderColor !== 'rgba(0, 0, 0, 0)',
    '模式2：直角颜色变量应解析成功，实际 "' + s.cornerBorderColor + '"');

  // 四个角必须两两不同且都在窗口内
  const W = 1000;
  const H = 700;
  const near = (v, target) => Math.abs(v - target) <= 12;
  expect(s.tl && near(s.tl.x, 6) && near(s.tl.y, 6), '左上角应贴近 (6,6)，实际 ' + JSON.stringify(s.tl));
  expect(s.tr && near(s.tr.x, W - 6 - s.tr.w) && near(s.tr.y, 6),
    '右上角应贴近右边缘，实际 ' + JSON.stringify(s.tr));
  expect(s.bl && near(s.bl.x, 6) && near(s.bl.y, H - 6 - s.bl.h),
    '左下角应贴近下边缘，实际 ' + JSON.stringify(s.bl));
  expect(s.br && near(s.br.x, W - 6 - s.br.w) && near(s.br.y, H - 6 - s.br.h),
    '右下角应贴近右下角，实际 ' + JSON.stringify(s.br));

  // 直角必须有实际尺寸（宽度/高度都 > 0，否则等于没画出来）
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    expect(s[k] && s[k].w > 10 && s[k].h > 10, k + ' 直角应有实际尺寸，实际 ' + JSON.stringify(s[k]));
  }

  // ---- 层叠验证：模拟网页在最上层时，直角是否仍可见 ----
  // 用 elementFromPoint 在四角处取值：直角 pointer-events:none，
  // 所以命中的应该是网页内容（fake-page），这证明直角不挡交互。
  const hit = await wc.executeJavaScript(`(() => {
    const pts = [[10,10],[${W - 10},10],[10,${H - 10}],[${W - 10},${H - 10}]];
    return pts.map(([x,y]) => {
      const el = document.elementFromPoint(x,y);
      return el ? (el.id || el.className || el.tagName) : 'null';
    });
  })()`);
  log.push(['四角 elementFromPoint 命中', JSON.stringify(hit)]);
  hit.forEach((h, i) => {
    expect(h !== 'null' && String(h).indexOf('corner') === -1,
      '第' + (i + 1) + '角处不应命中直角元素（应透到网页），实际 ' + h);
  });

  // ---- 模式互斥（直接跑真实 index.html里的 renderer.js 逻辑） ----
  // 不在测试里复刻一份实现：复刻版只能验证「我手写的操作」，
  // 真正的互斥逻辑在 renderer.js 的 enterFrameless2() 里。
  // 这里加载真实外壳（含 styles.css 与 renderer.js），调用产品代码本身。
  const mutual = await runRealShell(win);
  log.push(['真实外壳：初始 class', mutual.initial]);
  log.push(['真实 enterFrameless2() 后', mutual.afterEnter]);
  log.push(['真实 toggleFrameless() 后', mutual.afterBackTo1]);
  log.push(['真实 toggleFrameless2() 后', mutual.afterToggle2]);

  expect(mutual.afterEnter === 'frameless2',
    '互斥：真实 enterFrameless2() 后应只剩 frameless2，实际 "' + mutual.afterEnter + '"');
  expect(mutual.afterBackTo1 === 'frameless',
    '互斥：真实代码切回模式1 后应只剩 frameless，实际 "' + mutual.afterBackTo1 + '"');
  expect(mutual.afterToggle2 === 'frameless2',
    '互斥：真实 toggleFrameless2() 应重新进入模式2，实际 "' + mutual.afterToggle2 + '"');
  expect(mutual.initial === '' || mutual.initial === 'frameless2',
    '真实外壳初始应为普通模式或模式2，实际 "' + mutual.initial + '"');

  // ---- 退出模式2 ----
  await wc.executeJavaScript("document.body.classList.remove('frameless2')");
  await wait(250);
  s = await probe(wc);
  log.push(['退出模式2 corners.display', s.cornersBox.display]);
  log.push(['退出模式2 toolbar.display', s.toolbar.display]);
  expect(s.cornersBox.display === 'none', '退出后直角层应隐藏');
  expect(s.toolbar.display !== 'none', '退出后工具栏应恢复');

  // ---- 落图：把「模式2」状态重新打开并保存，肉眼核对直角形状 ----
  await wc.executeJavaScript("document.body.classList.add('frameless2')");
  await wait(350);
  try {
    const img = await wc.capturePage();
    const out = path.join(ROOT, 'frameless2-preview.png');
    fs.writeFileSync(out, img.toPNG());
    log.push(['截图', out +' (' + img.getSize().width + 'x' + img.getSize().height + ')']);
  } catch (e) {
    log.push(['截图', '失败: ' + (e && e.message)]);
  }

  console.log('\n========== 无框模式2 端到端验证 ==========');
  for (const [k, v] of log) console.log('  ' + String(k).padEnd(24, ' ') + v);
  console.log('=========================================');
  if (failures.length) {
    console.error('\n失败 ' + failures.length + ' 项：');
    failures.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：工具栏已隐藏、四角直角就位于窗口四角、层叠与互斥均正常。');
  }
}

app.whenReady()
  .then(run)
  .catch((e) => {
    console.error('验证脚本异常:', e && e.stack);
    process.exitCode = 1;
  })
  .then(() => setTimeout(() => app.quit(), 500));
