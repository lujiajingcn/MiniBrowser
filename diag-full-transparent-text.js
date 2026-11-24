'use strict';

/**
 * 完全透明模式「只保留文字」端到端验证。
 *
 * 验证点：
 *  1) 各类图形元素（img / svg / video / canvas / iframe / background-image）
 *     在完全透明模式下**不可见**（visibility: hidden）
 *  2) 文字**仍然可见**（未被 visibility/opacity/color 影响）
 *  3) 图形元素用 visibility:hidden 而非 display:none —— 占位保留，
 *     否则整页文字会重排塌陷
 *  4) 退出完全透明模式后，图形元素恢复可见
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const W = 1000;
const H = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin:0; padding:0; background:#fff; font:14px/1.6 sans-serif; }
  .box { width:300px; height:70px; margin:10px; background:#eef; }
  #txt { color:#123456; }
  #img { width:200px; height:50px; }
  #svgBox { width:200px; height:50px; }
  #bgImg { width:200px; height:50px;
    background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'); }
  #masked { width:200px; height:50px; background:#cfc;
    -webkit-mask-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="black"/></svg>'); }
</style></head><body>
  <div class="box" id="txt">这是一段需要保留的文字 ABC 123</div>
  <img id="img" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='50'><rect width='100' height='50' fill='red'/></svg>" alt="图片alt文字">
  <div id="svgBox"><svg width="100" height="40"><rect width="100" height="40" fill="green"/></svg></div>
  <div id="bgImg">背景图容器</div>
  <div id="masked">遮罩容器</div>
  <video id="vid" width="200" height="50" src="data:video/mp4;base64,AAAA"></video>
  <canvas id="cvs" width="200" height="50"></canvas>
  <div id="box">普通文本框</div>
</body></html>`;

function buildPage() {
  const p = path.join(ROOT, '__full_transparent_text_test.html');
  fs.writeFileSync(p, PAGE_HTML, 'utf8');
  return p;
}

async function probe(wc) {
  return wc.executeJavaScript(`(() => {
    const g = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        visibility: cs.visibility,
        display: cs.display,
        opacity: cs.opacity,
        color: cs.color,
        stroke: cs.webkitTextStrokeWidth,
        strokeColor: cs.webkitTextStrokeColor,
        bgImage: cs.backgroundImage === 'none' ? 'none' : 'has-image',
        mask: (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ? 'has-mask' : 'none',
        // 占位是否保留：width/height > 0 说明元素仍在文档流里
        w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    // svg 要查**真正的 svg 元素**，而不是包着它的 div ——
    // visibility 是可继承属性，父 div 若显式声明 visible，会让子 svg 跟着可见。
    // 断言必须落在实际绘制图形的元素上。
    const svgEl = document.querySelector('#svgBox svg');
    const svgCs = svgEl ? getComputedStyle(svgEl) : null;
    return {
      txt: g('txt'), img: g('img'), bgImg: g('bgImg'),
      masked: g('masked'), vid: g('vid'), cvs: g('cvs'), box: g('box'),
      svgEl: svgEl ? {
        visibility: svgCs.visibility, display: svgCs.display, opacity: svgCs.opacity,
        w: Math.round(svgEl.getBoundingClientRect().width),
        h: Math.round(svgEl.getBoundingClientRect().height),
      } : null,
    };
  })()`);
}

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };
  const hidden = (v) => v && v.visibility === 'hidden';

  const win = new BrowserWindow({
    show: false, width: W, height: H,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const wc = win.webContents;
  wc.on('console-message', (_e, _l, m) => console.log('  [页面] ' + m));

  const page = buildPage();
  await wc.loadURL('file:///' + page.replace(/\\/g, '/'));
  await wait(600);

  // ---- 基线：所有元素可见 ----
  const base = await probe(wc);
  log.push(['基线 img visibility', base.img && base.img.visibility]);
  log.push(['基线 txt color', base.txt && base.txt.color]);
  exp(base.img && base.img.visibility === 'visible', '基线：img 应可见');
  exp(base.txt && base.txt.color !== 'rgba(0, 0, 0, 0)', '基线：文字应有颜色');

  // ---- 注入完全透明 CSS（与 renderer.js 里的定义保持一致） ----
  const FULL_CSS = `
html, body, body * {
  background-color: transparent !important;
  background-image: none !important;
}
html::before, html::after, body::before, body::after, body *::before, body *::after {
  background-image: none !important;
}
img, picture, svg, canvas, video, audio, iframe, embed, object,
input[type="image"], input[type="file"], area, map, track {
  visibility: hidden !important;
}
body * {
  border-image: none !important;
  -webkit-mask-image: none !important;
  mask-image: none !important;
}
html, body, body * {
  -webkit-text-stroke: 0.3px rgba(128, 128, 128, 0.55);
}`;
  const key = await wc.insertCSS(FULL_CSS);
  await wait(400);

  const after = await probe(wc);
  for (const [id, label] of [['img', 'img'], ['svgEl', 'svg'], ['vid', 'video'], ['cvs', 'canvas']]) {
    log.push(['完全透明 ' + label + ' visibility', after[id] && after[id].visibility]);
    exp(hidden(after[id]), label + ' 应被隐藏（visibility:hidden），实际 ' +
      (after[id] && after[id].visibility));
  }
  log.push(['完全透明 bgImg 背景图', after.bgImg && after.bgImg.bgImage]);
  log.push(['完全透明 masked 遮罩', after.masked && after.masked.mask]);
  exp(after.bgImg && after.bgImg.bgImage === 'none', '背景图应被清掉');
  exp(after.masked && after.masked.mask === 'none', '遮罩图应被清掉');

  // ---- 文字必须保留 ----
  log.push(['完全透明 txt visibility', after.txt && after.txt.visibility]);
  log.push(['完全透明 txt color', after.txt && after.txt.color]);
  log.push(['完全透明 txt opacity', after.txt && after.txt.opacity]);
  exp(after.txt && after.txt.visibility === 'visible', '文字容器应仍然可见');
  exp(after.txt && after.txt.opacity === '1', '文字不应被降低不透明度');
  exp(after.txt && after.txt.color === base.txt.color,
    '文字颜色应保持不变，实际 ' + (after.txt && after.txt.color));
  exp(after.box && after.box.visibility === 'visible', '普通文本框应可见');
  // 文字描边应生效（深色壁纸上深色文字要能看清）
  log.push(['完全透明 txt 描边', after.txt && after.txt.stroke + ' ' + after.txt.strokeColor]);
  exp(after.txt && parseFloat(after.txt.stroke) > 0,
    '文字应有对比描边（保证浮在桌面上时可读），实际 ' + (after.txt && after.txt.stroke));
  // 描边不应改变布局宽度
  exp(after.txt && after.txt.w === base.txt.w,
    '描边不应改变元素宽度，实际 ' + after.txt.w + ' vs 基线 ' + base.txt.w);

  // ---- 图形元素保留占位（display 仍是原值，尺寸不为 0） ----
  log.push(['完全透明 img display', after.img && after.img.display]);
  log.push(['完全透明 img 尺寸', after.img && (after.img.w + 'x' + after.img.h)]);
  exp(after.img && after.img.display !== 'none',
    'img 不应用 display:none（会导致布局塌陷），实际 ' + (after.img && after.img.display));
  exp(after.img && after.img.w > 0 && after.img.h > 0,
    'img 应保留占位尺寸，实际 ' + (after.img && (after.img.w + 'x' + after.img.h)));

  // ---- 像素验证：图片区域应看不到红色 ----
  const img = await wc.capturePage();
  const buf = img.toBitmap();
  const read = (x, y) => {
    const i = (y * W + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
  };
  const r = JSON.parse(await wc.executeJavaScript(
    "JSON.stringify(document.getElementById('img').getBoundingClientRect())"
  ));
  const px = Math.round(r.left + r.width / 2);
  const py = Math.round(r.top + r.height / 2);
  const color = read(px, py);
  log.push(['像素 img 中心', JSON.stringify(color)]);
  exp(!(color[0] > 200 && color[1] < 80 && color[2] < 80),
    '图片位置不应再是红色块，实际 ' + JSON.stringify(color));

  // ---- 退出：移除注入的 CSS 后应恢复可见 ----
  await wc.removeInsertedCSS(key);
  await wait(400);
  const restored = await probe(wc);
  log.push(['移除CSS后 img visibility', restored.img && restored.img.visibility]);
  exp(restored.img && restored.img.visibility === 'visible',
    '移除完全透明 CSS 后 img 应恢复可见，实际 ' + (restored.img && restored.img.visibility));

  fs.unlinkSync(page);

  console.log('\n========== 完全透明模式：只保留文字 ==========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(30, ' ') + v));
  console.log('===============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：图形内容不可见、文字保留、占位不塌陷、退出后恢复。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
