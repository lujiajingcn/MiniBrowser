'use strict';

/**
 * 「无框模式2 + 透明模式」叠加验证。
 *
 * 需求：进入无框模式2 后再进入透明模式，四角直角必须保留。
 *
 * 为什么这是个需要专门验证的组合：
 *  1) 透明模式下 `body.transparent .webview-container { background: transparent }`，
 *     网页容器背景被清空。直角层若依赖「容器背景」来衬托，就会一起消失；
 *  2) 直角层 z-index: 50，而 webview 是独立渲染进程（OOPIF），
 *     两者的层叠关系不由普通 CSS 完全决定；
 *  3) 直角颜色原本是深色系（深灰/浅灰），透明模式下背景是桌面透出色，
 *     深色直角在深色壁纸上可能几乎看不见 —— 这也是要验证的点。
 *
 * 本脚本同时用 DOM 计算样式 与 截图像素采样两条路径验证：
 *  - 计算样式：直角层是否 display:block、颜色是否被解析、层级是否正确；
 *  - 像素采样：直角位置处是否真的画出了非背景像素（避免「样式都对但没画出来」）。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const W = 1000;
const H = 700;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 构造测试外壳。
 *
 * 透明模式下网页容器背景会被清空，真实效果是「透出桌面」。
 * 但离屏渲染的根窗口仍是白的，直接截会得到白底 ——
 * 所以用一层**模拟桌面壁纸**的底色垫在下面，页面内容块改成半透明，
 * 这样截出来的像素分布才接近「半透明窗口浮在某个壁纸上」的真实情形。
 *
 * 壁纸选深色：透明模式最典型的用法是浮在深色背景上，
 * 而浅色直角在白底上看不见正是本次要修的问题。
 */
function buildShellHtml() {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
  /* 模拟桌面壁纸（根窗口底色，transparent 模式下会透出来） */
  html { background: #2b3440; }
  </style></head>
<body>
  <div id="frameless-drag-strip" aria-hidden="true"></div>
  <div id="frameless2-corners" aria-hidden="true">
    <i class="corner tl"></i><i class="corner tr"></i>
    <i class="corner bl"></i><i class="corner br"></i>
  </div>
  <header class="toolbar"><button id="go">go</button></header>
  <div id="bookmarks-bar" class="bookmarks-bar"></div>
  <div class="tab-bar"></div>
  <div class="webview-container">
    <!-- 页面内容：半透明，模拟真实网页背景被注入透明后透出壁纸 -->
    <div id="fake-page" style="position:absolute;inset:0;background:rgba(255,255,255,0.35);"></div>
  </div>
</body></html>`;
}

/** 读取直角层与四个角的关键状态。 */
async function probe(wc) {
  return wc.executeJavaScript(`(() => {
    const corners = document.getElementById('frameless2-corners');
    const q = (s) => document.querySelector(s);
    const info = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        display: cs.display,
        zIndex: cs.zIndex,
        pointerEvents: cs.pointerEvents,
        borderTopColor: cs.borderTopColor,
        borderTopWidth: cs.borderTopWidth,
        borderLeftWidth: cs.borderLeftWidth,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    return {
      bodyClass: document.body.className,
      cornersDisplay: getComputedStyle(corners).display,
      cornersZ: getComputedStyle(corners).zIndex,
      cornersPointerEvents: getComputedStyle(corners).pointerEvents,
      tl: info(q('#frameless2-corners .tl')),
      tr: info(q('#frameless2-corners .tr')),
      bl: info(q('#frameless2-corners .bl')),
      br: info(q('#frameless2-corners .br')),
      // 容器背景是否已透明（这是直角能否"透出"的前提）
      containerBg: getComputedStyle(document.querySelector('.webview-container')).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      // 页面内容块还在不在
      fakePage: !!document.getElementById('fake-page'),
    };
  })()`);
}

/**
 * 用 NativeImage 采样四角处的像素，确认直角「真的画出来了」。
 * 采样点取在 L 形两条边的交点附近（如 tl 的左上角处）。
 *
 * 注意：Electron 的 NativeImage **没有 getPixel() 方法**（早期版本误用过，会抛
 * "img.getPixel is not a function"），只能通过 toBitmap() 拿到 RGBA Buffer 后
 * 自行按 (x,y) 计算偏移再读 4个通道。
 */
function readPixel(img, x, y) {
  const { width, height } = img.getSize();
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const buf = img.toBitmap(); // BGRA 顺序，4 字节/像素
  const i = (y * width + x) * 4;
  return [buf[i + 2], buf[i + 1], buf[i + 0], buf[i + 3]]; // 转成 [r,g,b,a]
}

function sampleCorner(img, cornerName) {
  const { width, height } = img.getSize();
  const offsets = {
    tl: [8, 8],
    tr: [width - 8, 8],
    bl: [8, height - 8],
    br: [width - 8, height - 8],
  };
  const [x, y] = offsets[cornerName];
  // 沿 L 形两条边各采一个点
  return {
    p1: readPixel(img, x, y),
    p2: readPixel(img, Math.min(x + 6, width - 1), Math.min(y + 6, height - 1)),
  };
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
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

  // ---- 场景A：仅无框模式2 ----
  await wc.executeJavaScript("document.body.className='frameless2'");
  await wait(300);
  let a = await probe(wc);
  log.push(['A仅模式2 corners.display', a.cornersDisplay]);
  log.push(['A 仅模式2 tl 颜色', a.tl.borderTopColor]);
  expect(a.cornersDisplay === 'block', 'A：直角层应显示');
  expect(a.fakePage, 'A：网页内容块应存在');

  // ---- 场景B：无框模式2 + 透明模式（需求核心场景） ----
  await wc.executeJavaScript("document.body.className='frameless2 transparent'");
  await wait(300);
  const b = await probe(wc);
  log.push(['B 模式2+透明 bodyClass', b.bodyClass]);
  log.push(['B corners.display', b.cornersDisplay]);
  log.push(['B corners.z-index', b.cornersZ]);
  log.push(['B tl 颜色', b.tl.borderTopColor]);
  log.push(['B tl 几何', JSON.stringify(b.tl)]);
  log.push(['B container 背景', b.containerBg]);
  log.push(['B body 背景', b.bodyBg]);

  // 核心断言：直角层必须保留
  expect(b.cornersDisplay === 'block',
    'B：透明模式下直角层必须保留，实际 display=' + b.cornersDisplay);
  expect(b.tl.display === 'block' && b.tr.display === 'block' &&
         b.bl.display === 'block' && b.br.display === 'block',
    'B：四个角都必须保留');
  expect(b.cornersZ === '50', 'B：直角层 z-index 应为 50，实际 ' + b.cornersZ);
  expect(b.cornersPointerEvents === 'none',
    'B：直角层 pointer-events 应为 none（不能挡页面交互），实际 ' + b.cornersPointerEvents);

  // 透明模式下容器背景应变透明
  const containerTransparent =
    b.containerBg === 'rgba(0, 0, 0, 0)' || b.containerBg === 'transparent';
  expect(containerTransparent,
    'B：透明模式下网页容器背景应透明，实际 ' + b.containerBg);

  // 颜色必须仍是直角色（被覆盖为浅色），而不是继承了普通模式的深色
  expect(b.tl.borderTopColor !== a.tl.borderTopColor,
    'B：透明模式下直角颜色应被覆盖为浅色（否则深色桌面下看不见）');

  // 四角几何位置不能因透明模式而偏移
  const near = (v, t) => Math.abs(v - t) <= 12;
  expect(near(b.tl.x, 6) && near(b.tl.y, 6), 'B：左上角位置应不变，实际 ' + JSON.stringify(b.tl));
  expect(near(b.br.x, W - 6 - b.br.w) && near(b.br.y, H - 6 - b.br.h),
    'B：右下角位置应不变，实际 ' + JSON.stringify(b.br));

  // 描边粗细不能丢（否则直角退化成不可见）
  expect(parseFloat(b.tl.borderTopWidth) > 0 && parseFloat(b.tl.borderLeftWidth) > 0,
    'B：直角描边粗细应大于 0，实际 ' + b.tl.borderTopWidth + '/' + b.tl.borderLeftWidth);

  // ---- 像素采样：确认直角真的画出来了 ----
  try {
    const img = await wc.capturePage();
    const { width, height } = img.getSize();
    const shots = {};
    // 每个角同时采「直角上」与「远离直角的空白处」两个点，
    // 判定标准是两者**存在可见差异** —— 直角颜色可能与壁纸接近，
    // 但双层描边保证至少有一侧不同，所以「与背景有差异」才是正确判据。
    const farOffsets = {
      tl: [60, 60], tr: [width - 60, 60],
      bl: [60, height - 60], br: [width - 60, height - 60],
    };
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const s = sampleCorner(img, c);
      const [fx, fy] = farOffsets[c];
      s.background = readPixel(img, fx, fy);
      shots[c] = s;
    }
    log.push(['B 像素 tl（直角/ 背景）',
      JSON.stringify(shots.tl.p1) + ' vs ' + JSON.stringify(shots.tl.background)]);
    log.push(['B 像素 br（直角/ 背景）',
      JSON.stringify(shots.br.p1) + ' vs ' + JSON.stringify(shots.br.background)]);

    const colorDiff = (a, b) => {
      if (!a || !b) return false;
      return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    };
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const s = shots[c];
      const d1 = colorDiff(s.p1, s.background);
      const d2 = colorDiff(s.p2, s.background);
      expect(d1 > 12 || d2 > 12,
        'B：' + c + ' 角处应采样到与背景不同的直角像素（差异 ' + d1 + '/' + d2 + '）');
    }

    const out = path.join(ROOT, 'frameless2-transparent-preview.png');
    fs.writeFileSync(out, img.toPNG());
    log.push(['B 截图', out]);
  } catch (e) {
    failures.push('截图失败：' + (e && e.message));
  }

  // ---- 场景C：退出透明模式后直角应回到原来的深色（验证状态可逆） ----
  await wc.executeJavaScript("document.body.className='frameless2'");
  await wait(250);
  const c = await probe(wc);
  log.push(['C 仅模式2 tl 颜色', c.tl.borderTopColor]);
  expect(c.cornersDisplay === 'block', 'C：退出透明后直角仍应保留');
  expect(c.tl.borderTopColor === a.tl.borderTopColor,
    'C：退出透明后颜色应恢复为模式2 默认色，实际 ' + c.tl.borderTopColor);

  // ---- 场景D：仅透明模式（无frameless2）时不应出现直角 ----
  await wc.executeJavaScript("document.body.className='transparent'");
  await wait(250);
  const d = await probe(wc);
  log.push(['D 仅透明 corners.display', d.cornersDisplay]);
  expect(d.cornersDisplay === 'none', 'D：仅透明模式时不应显示直角，实际 ' + d.cornersDisplay);

  console.log('\n========== 无框模式2 + 透明模式 验证 ==========');
  for (const [k, v] of log) console.log('  ' + String(k).padEnd(22, ' ') + v);
  console.log('==============================================');
  if (failures.length) {
    console.error('\n失败 ' + failures.length + ' 项：');
    failures.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：透明模式下四角直角完整保留，颜色改为浅色以适配桌面背景，状态可逆。');
  }
}

app.whenReady()
  .then(run)
  .catch((e) => {
    console.error('验证脚本异常:', e && e.stack);
    process.exitCode = 1;
  })
  .then(() => setTimeout(() => app.quit(), 500));
