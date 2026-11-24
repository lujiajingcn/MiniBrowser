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
  // 主体在 6px 内缩、26px 长、3px 粗：
  //   tl: 上边中点 (19,7)   左/右空缺 → 右外(45,7)、下外(7,45)
  //   tr: 上边中点 (981,7)  左外(955,7)、下外(993,45)
  //   bl: 下边中点 (19,693) 上外(7,655)、右外(45,693)
  //   br: 下边中点 (981,693) 上外(993,655)、左外(955,693)
  const probes = {
    tl: { edge: [19, 7], off1: [45, 7], off2: [7, 45] },
    tr: { edge: [981, 7], off1: [955, 7], off2: [993, 45] },
    bl: { edge: [19, 693], off1: [7, 655], off2: [45, 693] },
    br: { edge: [981, 693], off1: [993, 655], off2: [955, 693] },
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
