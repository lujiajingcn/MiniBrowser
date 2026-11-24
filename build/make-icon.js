'use strict';

/**
 * 应用图标生成器：build/icon.svg → build/icon.ico + build/icon.png
 *
 * 为什么不直接用 ImageGen：生成式图标风格不可控，且要消耗积分。
 * 这里用 Electron 自己的 Chromium 渲染 SVG —— 无额外依赖、结果确定，
 * 且能顺带产出打包所需的多尺寸 PNG。
 *
 * 用法：electron build/make-icon.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SVG = path.join(BUILD, 'icon.svg');
const PNG = path.join(BUILD, 'icon.png');
const ICO = path.join(BUILD, 'icon.ico');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// PNG 里内嵌 ico 的图像块：ICO 格式 = 6 字节头 + 16 字节目录项 + 各 PNG 数据
// Windows Vista 起 ICO 支持直接内嵌 PNG。
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type=1 (icon)
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, buf } of pngBuffers) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width（0 表示 256）
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(SVG)) {
    console.error('[icon] 找不到 ' + SVG);
    app.quit();
    return;
  }
  const svg = fs.readFileSync(SVG, 'utf8');
  const dataUrl =
    'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const size of SIZES) {
    // 用离屏页面渲染 SVG 到指定尺寸的 PNG
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
      'img{display:block;width:' + size + 'px;height:' + size + 'px}' +
      '</style></head><body><img src="' + dataUrl + '"></body></html>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await wait(280);
    const img = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: size,
      height: size,
    });
    const buf = img.toPNG();
    pngBuffers.push({ size, buf });
    if (size === 256) fs.writeFileSync(PNG, buf);
  }

  fs.writeFileSync(ICO, buildIco(pngBuffers));
  console.log('[icon] 已生成 ' + PNG + ' 与 ' + ICO +
    '（' + SIZES.join('/') + '）');
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
