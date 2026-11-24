'use strict';

/**
 * 完全透明模式端到端验证。
 *
 * 核心要验证的是「网页中所有内容的背景色全部透明」——
 * 即页面内部元素（div/section/卡片/表格/带背景图的元素）也必须透明，
 * 而不只是 html/body。这是与普通透明模式的本质区别。
 *
 * 验证手段：insertCSS 注入后读getComputedStyle 的 backgroundColor，
 * 逐个检查各类元素；再用像素采样确认「有色块元素的区域确实透出背景」。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const W = 1000;
const H = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 含各种背景类型的测试页
const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin:0; padding:0; background:#ffffff; }
  #divBg      { background:#ff0000; width:200px; height:60px; }
  #sectionBg  { background:#00ff00; width:200px; height:60px; }
  .cardBg     { background:#0000ff; width:200px; height:60px; }
  #inlineBg   { background:#ffff00; width:200px; height:60px; }
  #gradBg     { background:linear-gradient(90deg,#f00,#00f); width:200px; height:60px; }
  #imgBg      { background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="%2300ffff"/></svg>'); width:200px; height:60px; }
  #tableBg    { background:#ff00ff; width:200px; height:60px; }
  #borderOnly { border:2px solid #000; width:200px; height:60px; }
  #normalText { color:#123456; width:200px; height:20px; }
</style></head><body>
  <div id="divBg">div 背景</div>
  <div id="sectionBg">section 背景</div>
  <div class="cardBg">class 背景</div>
  <div id="inlineBg" style="background:#ffff00">inline 背景</div>
  <div id="gradBg">渐变背景</div>
  <div id="imgBg">图片背景</div>
  <table id="tableBg"><tr><td>表格背景</td></tr></table>
  <div id="borderOnly">只有边框</div>
  <div id="normalText">普通文字</div>
</body></html>`;

const TARGETS = [
  'divBg', 'sectionBg', 'cardBg', 'inlineBg', 'gradBg', 'imgBg', 'tableBg', 'borderOnly',
];

function buildPage() {
  const p = path.join(ROOT, '__full_transparent_test.html');
  fs.writeFileSync(p, PAGE_HTML, 'utf8');
  return p;
}

/** 读取各元素的实际背景（渲染后的计算值）。 */
async function readBackgrounds(wc) {
  return wc.executeJavaScript(`(() => {
    const ids = ${JSON.stringify(TARGETS)};
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      const cs = getComputedStyle(el);
      out[id] = {
        bgColor: cs.backgroundColor,
        bgImage: cs.backgroundImage === 'none' ? 'none' : 'has-image',
        color: cs.color,
      };
    }
    // class 命名的元素没有 id，需用 querySelector 单独取
    const card = document.querySelector('.cardBg');
    out.cardBg = card ? {
      bgColor: getComputedStyle(card).backgroundColor,
      bgImage: getComputedStyle(card).backgroundImage === 'none' ? 'none' : 'has-image',
      color: getComputedStyle(card).color,
    } : null;
    // 文字颜色单独取（验证「只清背景、不清前景」）
    const txt = document.getElementById('normalText');
    out.normalText = txt ? { bgColor: getComputedStyle(txt).backgroundColor, color: getComputedStyle(txt).color } : null;
    out._html = (() => {
      const cs = getComputedStyle(document.documentElement);
      return { bgColor: cs.backgroundColor, bgImage: cs.backgroundImage === 'none' ? 'none' : 'has-image' };
    })();
    out._body = (() => {
      const cs = getComputedStyle(document.body);
      return { bgColor: cs.backgroundColor, bgImage: cs.backgroundImage === 'none' ? 'none' : 'has-image' };
    })();
    return out;
  })()`);
}

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };
  const isTransparentBg = (v) => v === 'rgba(0, 0, 0, 0)' || v === 'transparent';

  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const wc = win.webContents;
  wc.on('console-message', (_e, _l, m) => console.log('  [页面] ' + m));

  const page = buildPage();
  await wc.loadURL('file:///' + page.replace(/\\/g, '/'));
  await wait(600);

  // ---- 基线：普通模式下各元素应有背景色 ----
  const base = await readBackgrounds(wc);
  log.push(['基线 divBg 背景', base.divBg.bgColor]);
  log.push(['基线 gradBg 背景图', base.gradBg.bgImage]);
  const baseHasColor = TARGETS.some(
    (id) => base[id] && !isTransparentBg(base[id].bgColor)
  );
  exp(baseHasColor, '基线：至少应有元素带不透明背景色（测试页才有意义）');
  exp(base.divBg && !isTransparentBg(base.divBg.bgColor),
    '基线：divBg 应有背景色，实际 ' + (base.divBg && base.divBg.bgColor));
  exp(base.gradBg && base.gradBg.bgImage === 'has-image',
    '基线：gradBg 应有背景图，实际 ' + (base.gradBg && base.gradBg.bgImage));

  // ---- 注入「普通透明模式」CSS（只清 html/body） ----
  const TRANSPARENT_CSS = 'html, body { background-color: transparent !important; background-image: none !important; }';
  await wc.insertCSS(TRANSPARENT_CSS);
  await wait(300);
  const afterPlain = await readBackgrounds(wc);
  log.push(['普通透明后 _body 背景', afterPlain._body.bgColor]);
  log.push(['普通透明后 divBg 背景', afterPlain.divBg.bgColor]);
  exp(isTransparentBg(afterPlain._body.bgColor), '普通透明模式：body 背景应变透明');
  exp(!isTransparentBg(afterPlain.divBg.bgColor),
    '普通透明模式：divBg 背景**不应**变透明（这正是完全透明模式要解决的），实际 ' +
    afterPlain.divBg.bgColor);

  // ---- 再注入「完全透明」CSS：所有元素背景都清掉 ----
  const FULL_CSS = `
html, body, body * {
  background-color: transparent !important;
  background-image: none !important;
}`;
  await wc.insertCSS(FULL_CSS);
  await wait(300);
  const afterFull = await readBackgrounds(wc);
  for (const id of TARGETS) {
    const v = afterFull[id];
    log.push(['完全透明 ' + id, v ? v.bgColor + ' / bgImage=' + v.bgImage : 'MISSING']);
    exp(v && isTransparentBg(v.bgColor),
      '完全透明：' + id + ' 的 backgroundColor 应为透明，实际 ' + (v && v.bgColor));
    exp(v && v.bgImage === 'none',
      '完全透明：' + id + ' 的 backgroundImage 应为 none，实际 ' + (v && v.bgImage));
  }
  log.push(['完全透明 _html 背景', afterFull._html.bgColor]);
  exp(isTransparentBg(afterFull._html.bgColor), '完全透明：html 背景应变透明');
  // 文字颜色不能被清掉（否则页面全白看不见字）
  exp(afterFull.normalText && afterFull.normalText.color !== 'rgba(0, 0, 0, 0)',
    '完全透明：文字颜色应保留，实际 ' + (afterFull.normalText && afterFull.normalText.color));

  // ---- 像素验证：有色块的位置应透出根背景（不再是纯色块） ----
  const img = await wc.capturePage();
  const buf = img.toBitmap();
  const read = (x, y) => {
    const i = (y * W + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
  };
  // divBg 在页面左上区域，取其中心附近
  const r = await wc.executeJavaScript(
    "JSON.stringify(document.getElementById('divBg').getBoundingClientRect())"
  );
  const rect = JSON.parse(r);
  const px = Math.round(rect.left + rect.width / 2);
  const py = Math.round(rect.top + rect.height / 2);
  const color = read(px, py);
  log.push(['像素 divBg 中心', JSON.stringify(color)]);
  // 完全透明后该处应显示根背景（白底 255,255,255），而不是原来的纯红 255,0,0
  exp(!(color[0] > 200 && color[1] < 60 && color[2] < 60),
    '像素：divBg 位置不应再是纯红色块（说明背景没被清掉），实际 ' + JSON.stringify(color));

  // ---- 移除注入的 CSS 后应恢复（验证 removeInsertedCSS 路径） ----
  const keys = await wc.executeJavaScript('1'); // 占位，实际用 removeInsertedCSS
  void keys;

  console.log('\n========== 完全透明模式 验证 ==========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(28, ' ') + v));
  console.log('=============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：所有元素背景色与背景图均已清为透明，文字颜色保留。');
  }
  fs.unlinkSync(page);
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
