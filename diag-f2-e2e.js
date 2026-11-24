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
              boxShadow:cs.boxShadow};
      } return o;})()`);
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
    // 尺寸合理（>20px）
    for (const [c,v] of Object.entries(d)) exp(v.rect[2] > 20 && v.rect[3] > 20,
      '[' + mode + '] ' + c + ' 尺寸应>20px，实际 ' + JSON.stringify(v.rect));
  }

  // 像素：透明模式下 tl 沿水平走远应回到背景
  await win.webContents.executeJavaScript("document.body.className='frameless2 transparent'");
  await wait(700);
  const img = await win.webContents.capturePage();
  const buf = img.toBitmap();
  const read = (x,y) => { const i=(y*W+x)*4; return [buf[i+2],buf[i+1],buf[i],buf[i+3]]; };
  const onEdge = read(15, 7), pastH = read(60, 7), pastV = read(7, 60);
  log.push(['像素 tl 上边', JSON.stringify(onEdge)]);
  log.push(['像素 tl 水平60px处', JSON.stringify(pastH)]);
  log.push(['像素 tl 垂直60px处', JSON.stringify(pastV)]);
  const dark = p => (p[0]+p[1]+p[2])/3 < 150;
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
