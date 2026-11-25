'use strict';

/**
 * 验证「四角是 L 形直角」而不是完整方框。
 *
 * 背景（真实缺陷）：透明模式下曾用 box-shadow 给直角加深色描边，
 * 但 box-shadow 沿元素**矩形盒四边**生成，不看border-width，
 * 于是只描了两条边的 L 形被补成完整方框，用户看到「四个小正方形」。
 *
 * 本脚本的判定标准必须是「形状」而非「颜色」：
 * 对每个角，检查**四个方向的边框宽度**：
 *   - L 形：恰好两条相邻边为thick，另外两条为 0；
 *   - 方框：四条边都为 thick。
 * 同时用像素采样验证描边层确实只描了两条边
 * （沿「空缺边」方向移动时，采样点应仍是背景色）。
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

function buildShellHtml() {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
  /* 模拟桌面壁纸：透明模式下透出来。用白色，因为用户截图正是白底场景。 */
  html { background: #ffffff; }
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
    <div id="fake-page" style="position:absolute;inset:0;background:rgba(255,255,255,0.6);"></div>
  </div>
</body></html>`;
}

async function run() {
  const win = new BrowserWindow({
    show: false, width: W, height: H,
    webPreferences: { offscreen: true },
  });
  const wc = win.webContents;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildShellHtml()));
  await wait(500);

  const failures = [];
  const expect = (c, m) => { if (!c) failures.push(m); };
  const log = [];

  // ---- 非透明模式：四角应为 L 形 ----
  await wc.executeJavaScript("document.body.className='frameless2'");
  await wait(250);

  const shape = await wc.executeJavaScript(`(() => {
    const px = (v) => Math.round(parseFloat(v) || 0);
    const out = {};
    for (const c of ['tl','tr','bl','br']) {
      const cs = getComputedStyle(document.querySelector('#frameless2-corners .' + c));
      out[c] = {
        top: px(cs.borderTopWidth), right: px(cs.borderRightWidth),
        bottom: px(cs.borderBottomWidth), left: px(cs.borderLeftWidth),
      };
    }
    return out;
  })()`);

  log.push(['非透明 四角边框宽度', JSON.stringify(shape)]);
  // L 形：恰好两条相邻边 thick，其余为 0
  const expectL = {
    tl: { on: ['top', 'left'] },
    tr: { on: ['top', 'right'] },
    bl: { on: ['bottom', 'left'] },
    br: { on: ['bottom', 'right'] },
  };
  const SIDES = ['top', 'right', 'bottom', 'left'];
  // 判断一组边框宽度是否为「L 形」：有宽度的边恰好是期望的那两条，其余全为 0
  const isLShape = (d, wantOn) => {
    const onOk = wantOn.every((k) => d[k] > 0);
    const offOk = SIDES.filter((k) => !wantOn.includes(k)).every((k) => d[k] === 0);
    return onOk && offOk;
  };
  for (const [c, want] of Object.entries(expectL)) {
    const s = shape[c];
    expect(isLShape(s, want.on),
      c + '：应为 L 形（仅' + want.on.join('+') + '有描边，其余为 0），实际 ' + JSON.stringify(s));
  }

  // ---- 透明模式：加描边后仍必须是 L 形（这是本次修复的重点） ----
  await wc.executeJavaScript("document.body.className='frameless2 transparent'");
  await wait(300);

  const shapeT = await wc.executeJavaScript(`(() => {
    const px = (v) => Math.round(parseFloat(v) || 0);
    const out = {};
    for (const c of ['tl','tr','bl','br']) {
      const el = document.querySelector('#frameless2-corners .' + c);
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      out[c] = {
        main: { top: px(cs.borderTopWidth), right: px(cs.borderRightWidth),
                bottom: px(cs.borderBottomWidth), left: px(cs.borderLeftWidth) },
        outline: { top: px(before.borderTopWidth), right: px(before.borderRightWidth),
                   bottom: px(before.borderBottomWidth), left: px(before.borderLeftWidth) },
        // 必须没有 box-shadow：它是导致方框的元凶
        boxShadow: cs.boxShadow,
      };
    }
    return out;
  })()`);

  for (const c of ['tl', 'tr', 'bl', 'br']) {
    const s = shapeT[c];
    log.push(['透明 ' + c + ' 主体边框', JSON.stringify(s.main)]);
    log.push(['透明 ' + c + ' 描边层', JSON.stringify(s.outline)]);
    // 主体与描边层形状必须一致，且都是 L 形
    const want = expectL[c].on;
    for (const key of ['main', 'outline']) {
      expect(isLShape(s[key], want),
        '透明 ' + c + ' ' + key + '：应为 L 形（仅' + want.join('+') +
        ' 有描边），实际 ' + JSON.stringify(s[key]));
    }
    expect(s.boxShadow === 'none',
      '透明 ' + c + '：不应再有 box-shadow（会把 L 形补成方框），实际 ' + s.boxShadow);
  }

  // ---- 像素验证：四个角都要确认「只描两条边」 ----
  const img = await wc.capturePage();
  const size = img.getSize();
  log.push(['图像尺寸', size.width + 'x' + size.height +'（CSS 视口 ' + W + 'x' + H + '）']);
  // 注意：capturePage 返回的位图尺寸未必等于 CSS 视口（离屏渲染可能按 DPR 缩放）。
  // 坐标换算必须用图像尺寸，不能直接套 CSS 像素，否则采样点会整体偏移采空。
  const SCALE = size.width / W;
  const buf = img.toBitmap(); // BGRA
  const read = (cssX, cssY) => {
    const x = Math.round(cssX * SCALE);
    const y = Math.round(cssY * SCALE);
    const i = (y * size.width + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
  };
  const isDark = (p) => p && (p[0] + p[1] + p[2]) / 3 < 140;

  // 各角的「两条边中点」与「两条空缺边的外侧点」
  //
  // 几何参数**从实际渲染结果读取**（styles.css 的 --len / --thick 与 6px 内缩），
  // 不写死坐标 —— 直角尺寸是可调的（--len 目前是 26px 的三分之一），
  // 写死坐标会让本验证在改尺寸后整体采空、形同虚设。
  //
  // 测量口径的坑（都实测踩过）：
  //  1) getPropertyValue('--len') 返回**未计算的文本**（calc(26px / 3)），
  //     parseFloat 会得到 NaN —— 要用 getComputedStyle().width。
  //  2) getBoundingClientRect() 返回的是 **border-box** 尺寸
  //     （不管 box-sizing 如何），不能当边长用。
  //  3) border-width 会被 Chromium **设备像素对齐**：DPR=1.5 时 3px 边框
  //     = 4.5 物理像素，被取整到 4 物理像素 = 2.667 CSS px。
  //     故测到的 thick 未必等于声明值，这是既有行为，与尺寸调整无关。
  const geo = await wc.executeJavaScript(`
    (() => {
      const el = document.querySelector('#frameless2-corners .tl');
      const cs = getComputedStyle(el);
      return JSON.stringify({
        // 注意 1：--len 的声明值是 calc(26px / 3)，getPropertyValue 返回的是
        //         **未计算的文本**，parseFloat 会得到 NaN。
        // 注意 2：getBoundingClientRect() 返回的是 **border-box** 尺寸
        //         （不管 box-sizing 如何），不能当作边长用。
        // 因此边长取 getComputedStyle().width —— 对 box-sizing:content-box
        // 的元素它就是 content 宽度，正好等于 --len。
        len: parseFloat(cs.width),
        thick: parseFloat(cs.borderTopWidth),
        inset: parseFloat(cs.left), // tl 贴左边，left 即内缩距离
        outline: 1, // 描边层(::before)比主体向外扩 1px
      });
    })();
  `);
  const G = JSON.parse(geo);
  const { len: LEN, thick: THICK, inset: INSET, outline: OUT } = G;
  log.push(['几何参数', 'len=' + LEN + ' thick=' + THICK + ' inset=' + INSET]);

  // 主体两条边的覆盖范围（CSS 坐标）：
  //   上边：x ∈ [INSET, INSET+LEN]，y ∈ [INSET, INSET+THICK]
  //   左边：x ∈ [INSET, INSET+THICK]，y ∈ [INSET, INSET+LEN]
  // 描边层向外扩 OUT px，所以最外沿到 INSET-OUT。
  //
  // 采样点：
  //   edge  = **描边层独有**的那条外沿带（应为深色）
  //   off1/2 = 两条**空缺**边的外侧（应为背景，证明不是完整方框）
  //         沿空缺边方向再往里推 INSET+LEN+THICK+2，确保明确落在角标之外，
  //         但仍贴着该边的延长线，避免采到别的元素。
  //
  // 【edge 为什么取 INSET，而不是 INSET + THICK/2】
  // 透明模式下直角是「深色描边层 + 浅色主体」双层结构。
  // 关键事实（实测像素扫描得出）：描边层(::before) 是 .corner 的**子内容**，
  // 按 CSS 层叠规则绘制在父元素**边框之上** —— 并不是 styles.css 注释里
  // 曾经以为的「在主体之下」。
  //
  // 实测（x=10.33，DPR=1，H=700）：
  //   tl 上边：深色带 y ∈ [4.5, 7.4)，之后转白（主体上边之外的部分）
  //   bl 下边：深色带 y ∈ [691.4, 694.4)
  // 即深色带就是「描边层的边框」本身，INSET 恰好落在其中
  // （描边层比主体向外扩 1px，其边框覆盖 [INSET-1, INSET-1+THICK)，
  //   主体边框覆盖 [INSET, INSET+THICK)，描边层在上 → 交集仍是深色）。
  // 所以采样 INSET / H-INSET 稳落深色带；取 INSET+THICK/2 则会越过描边层
  // 落到主体的浅色上。
  const mid = INSET + LEN / 2;
  const out1 = INSET + LEN + THICK + 2; // 沿边方向、角标之外
  const probes = {
    tl: { edge: [mid, INSET], off1: [out1, INSET + THICK / 2], off2: [INSET + THICK / 2, out1] },
    tr: { edge: [W - INSET - LEN / 2, INSET], off1: [W - out1, INSET + THICK / 2], off2: [W - INSET - THICK / 2, out1] },
    bl: { edge: [mid, H - INSET], off1: [INSET + THICK / 2, H - out1], off2: [out1, H - INSET - THICK / 2] },
    br: { edge: [W - INSET - LEN / 2, H - INSET], off1: [W - out1, H - INSET - THICK / 2], off2: [W - INSET - THICK / 2, H - out1] },
  };
  for (const [c, p] of Object.entries(probes)) {
    const e = read(p.edge[0], p.edge[1]);
    const o1 = read(p.off1[0], p.off1[1]);
    const o2 = read(p.off2[0], p.off2[1]);
    log.push(['像素 ' + c + ' 描边点', JSON.stringify(e)]);
    log.push(['像素 ' + c + ' 空缺边外', JSON.stringify(o1) + ' / ' + JSON.stringify(o2)]);
    expect(isDark(e), c + '：应有深色描边像素，实际 ' + JSON.stringify(e));
    expect(!isDark(o1), c + '：第一条空缺边外应为背景（说明不是方框），实际 ' + JSON.stringify(o1));
    expect(!isDark(o2), c + '：第二条空缺边外应为背景（说明不是方框），实际 ' + JSON.stringify(o2));
  }

  const out = path.join(ROOT, 'frameless2-shape-preview.png');
  fs.writeFileSync(out, img.toPNG());
  log.push(['截图', out]);

  console.log('\n========== 四角形状（L 形 vs 方框）验证 ==========');
  for (const [k, v] of log) console.log('  ' + String(k).padEnd(26, ' ') + v);
  console.log('=================================================');
  if (failures.length) {
    console.error('\n失败 ' + failures.length + ' 项：');
    failures.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：四角为 L 形直角（非完整方框），描边层与主体形状一致。');
  }
}

app.whenReady()
  .then(run)
  .catch((e) => { console.error('验证脚本异常:', e && e.stack); process.exitCode = 1; })
  .then(() => setTimeout(() => app.quit(), 500));
