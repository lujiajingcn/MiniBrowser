'use strict';
/**
 * 无框模式2 四角直角最终验证（真实外壳 + 像素级形状检查）。
 * 判据：① 几何在四角视口内；② 边框宽度呈 L 形（两条边 >0、另两条 =0）；
 *③ 像素上「空缺边方向」走远后回到背景色（证明不是完整方框）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs');
const ROOT = __dirname, W = 1000, H = 700;
const wait = ms => new Promise(r => setTimeout(r, ms));
const SIDES = ['top','right','bottom','left'];
const WANT = { tl:['top','left'], tr:['top','right'], bl:['bottom','left'], br:['bottom','right'] };
const isL = (d, on) => on.every(k => d[k] > 0) && SIDES.filter(k => !on.includes(k)).every(k => d[k] === 0);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:W, height:H,
    webPreferences:{ offscreen:true, contextIsolation:false, nodeIntegration:false,
      preload:path.join(ROOT,'preload.js'), webviewTag:true, sandbox:false }});
  await win.loadFile(path.join(ROOT,'index.html'));
  await wait(1500);
  const fails = [], log = [];
  const exp = (c,m) => { if(!c) fails.push(m); };
  let lastGeo = null; // 最后一个模式的几何数据，供后面的像素采样使用

  for (const mode of ['frameless2', 'frameless2 transparent']) {
    await win.webContents.executeJavaScript(
      `document.body.className=${JSON.stringify(mode)}`);
    await wait(700);
    const d = await win.webContents.executeJavaScript(`(()=>{
      const px=v=>Math.round(parseFloat(v)||0); const o={};
      for(const c of ['tl','tr','bl','br']){
        const el=document.querySelector('#frameless2-corners .'+c);
        const cs=getComputedStyle(el), b=el.getBoundingClientRect();
        o[c]={rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)],
              bd:{top:px(cs.borderTopWidth),right:px(cs.borderRightWidth),
                  bottom:px(cs.borderBottomWidth),left:px(cs.borderLeftWidth)},
              // content 宽度（= --len 的计算值），用于动态校验尺寸
              len: parseFloat(cs.width),
              boxShadow:cs.boxShadow};
      } return o;})()`);
    lastGeo = d;
    log.push(['[' + mode + '] tl', JSON.stringify(d.tl)]);
    log.push(['[' + mode + '] tr', JSON.stringify(d.tr)]);
    for (const [c,v] of Object.entries(d)) {
      exp(isL(v.bd, WANT[c]), '[' + mode + '] ' + c + ' 应为 L 形，实际 ' + JSON.stringify(v.bd));
      exp(v.boxShadow === 'none', '[' + mode + '] ' + c + ' 不应有 box-shadow，实际 ' + v.boxShadow);
    }
    // 几何：两角靠左、两角靠右、两角靠上、两角靠下
    exp(d.tl.rect[0] >= 0 && d.tl.rect[1] >= 0, '[' + mode + '] tl 应在左上角');
    exp(d.tr.rect[0] > W/2 && d.tr.rect[1] < H/2, '[' + mode + '] tr 应在右上角，实际 ' + JSON.stringify(d.tr.rect));
    exp(d.bl.rect[0] >= 0 && d.bl.rect[1] > H/2, '[' + mode + '] bl 应在左下角，实际 ' + JSON.stringify(d.bl.rect));
    exp(d.br.rect[0] > W/2 && d.br.rect[1] > H/2, '[' + mode + '] br 应在右下角，实际 ' + JSON.stringify(d.br.rect));
    // 尺寸：与 CSS 声明的 --len 对得上（border-box 尺寸 = content 边长 + 左右边框）。
    // 不写死阈值 —— 直角尺寸是可调的，写死会在改尺寸后让本验证形同虚设。
    for (const [c,v] of Object.entries(d)) {
      const expectW = v.len + v.bd.left + v.bd.right;
      const expectH = v.len + v.bd.top + v.bd.bottom;
      exp(v.len > 0, '[' + mode + '] ' + c + ' 边长应为正，实际 ' + v.len);
      exp(Math.abs(v.rect[2] - expectW) <= 2 && Math.abs(v.rect[3] - expectH) <= 2,
        '[' + mode + '] ' + c + ' 尺寸应与 --len 一致（' +
        Math.round(expectW) + 'x' + Math.round(expectH) + '），实际 ' + JSON.stringify(v.rect));
    }
    // 四个角的边长必须一致（同一变量驱动）
    const lens = Object.values(d).map(v => Math.round(v.len * 100) / 100);
    exp(new Set(lens).size === 1,
      '[' + mode + '] 四个角边长应一致，实际 ' + JSON.stringify(lens));
  }

  // 像素：透明模式下 tl 沿水平走远应回到背景
  await win.webContents.executeJavaScript("document.body.className='frameless2 transparent'");
  await wait(700);
  const img = await win.webContents.capturePage();
  const buf = img.toBitmap();
  // capturePage 返回的位图尺寸未必等于 CSS 视口（离屏渲染按 DPR 缩放），
  // 采样必须按比例换算，否则会整体采空。
  const imgW = img.getSize().width;
  const SCALE = imgW / W;
  const read = (x, y) => {
    const px = Math.round(x * SCALE), py = Math.round(y * SCALE);
    const i = (py * imgW + px) * 4;
    return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
  };
  // 采样点从实际几何推导（直角尺寸可调，写死坐标会在改尺寸后采空）：
  //   onEdge = 描边层独有的外沿（应为深色描边）
  //   pastH  = 沿上边方向、越过角标末端（应为背景，证明不是方框）
  //   pastV  = 沿左边方向、越过角标末端（同上）
  //
  // 【为什么 onEdge 取 insetY】
  // 透明模式下直角是「深色描边层 + 浅色主体」双层结构。
  // 关键事实（实测像素扫描得出）：描边层(::before) 是 .corner 的**子内容**，
  // 按 CSS 层叠规则绘制在父元素**边框之上** —— 并不是 styles.css 注释里
  // 曾经以为的「在主体之下」。
  // 实测（DPR=1，H=700，x=10.33）：tl 上边深色带 y ∈ [4.5, 7.4)，
  // 即描边层的边框本身；insetY(=6) 落在其中。
  // 取 insetY + THICK/2 则会越过描边层，落到主体的浅色上。
  const insetX = lastGeo.tl.rect[0], insetY = lastGeo.tl.rect[1];
  const L = lastGeo.tl.len, TH = lastGeo.tl.bd.top;
  const onEdge = read(insetX + L / 2, insetY);
  const pastH = read(insetX + L + TH + 10, insetY + TH / 2);
  const pastV = read(insetX + TH / 2, insetY + L + TH + 10);
  log.push(['采样点 onEdge/pastH/pastV',
    [insetX + L / 2, insetY] + ' / ' +
    [insetX + L + TH + 10, insetY + TH / 2] + ' / ' +
    [insetX + TH / 2, insetY + L + TH + 10] + '（DPR=' + SCALE + '）']);
  log.push(['像素 tl 上边', JSON.stringify(onEdge)]);
  log.push(['像素 tl 水平远处', JSON.stringify(pastH)]);
  log.push(['像素 tl 垂直远处', JSON.stringify(pastV)]);
  const dark = p => (p[0] + p[1] + p[2]) / 3 < 150;
  exp(dark(onEdge), '像素：tl 上边应有深色描边，实际 ' + JSON.stringify(onEdge));
  exp(!dark(pastH), '像素：tl 水平走远应为背景（否则是方框），实际 ' + JSON.stringify(pastH));
  exp(!dark(pastV), '像素：tl 垂直走远应为背景（否则是方框），实际 ' + JSON.stringify(pastV));

  fs.writeFileSync(path.join(ROOT,'f2-e2e.png'), img.toPNG());

  console.log('\n======== 无框模式2 四角直角最终验证 ========');
  log.forEach(([k,v]) => console.log('  ' + String(k).padEnd(24) + v));
  console.log('===========================================');
  if (fails.length) { console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f)); process.exitCode = 1; }
  else console.log('\n全部通过：四角为 L 形直角、几何在视口四角、无 box-shadow、像素证明非方框。');
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
