'use strict';
/** 回归：收藏夹栏右侧空白区可拖窗口，且从那里起拖不会把收藏文字和网页一起选中变蓝。 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const ROOT = __dirname;
const USER_DATA = path.join(os.tmpdir(), 'mb-bookmarks-drag-' + Date.now());
process.env.MB_USER_DATA_DIR = USER_DATA;
app.setPath('userData', USER_DATA);
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      sandbox: false
    }
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wc.executeJavaScript(`try{localStorage.clear()}catch(e){}`);
  await wc.reload();
  await wait(1500);

  const info = await wc.executeJavaScript(`(() => {
    const bar = document.getElementById('bookmarks-bar');
    const cs = getComputedStyle(bar);
    const r = bar.getBoundingClientRect();
    const x = Math.round(r.right - 120), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const sel = s => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).webkitAppRegion : null;
    };
    return {
      region: cs.webkitAppRegion,
      userSelect: cs.userSelect,
      hit: hit ? (hit.id || hit.className || hit.tagName) : null,
      bookmarkRegion: sel('#bookmarks-bar .bookmark'),
      toolbarSelect: getComputedStyle(document.querySelector('.toolbar')).userSelect,
      tabBarSelect: getComputedStyle(document.getElementById('tab-bar')).userSelect
    };
  })()`);

  const fails = [];
  const exp = (c, m) => { if (!c) fails.push(m); };
  exp(info.region === 'drag', '收藏夹栏应是拖拽区，实际 ' + info.region);
  exp(info.userSelect === 'none', '收藏夹栏应禁止文本选择，实际 ' + info.userSelect);
  exp(info.hit === 'bookmarks-bar', '右侧空白应命中 bookmarks-bar，实际 ' + info.hit);
  exp(info.bookmarkRegion === 'no-drag', '收藏项应可点击（no-drag），实际 ' + info.bookmarkRegion);
  exp(info.toolbarSelect === 'none', '工具栏应禁止文本选择，实际 ' + info.toolbarSelect);
  exp(info.tabBarSelect === 'none', '标签栏应禁止文本选择，实际 ' + info.tabBarSelect);

  console.log('\n======== 收藏夹栏拖拽区验证 ========');
  console.log('  ' + JSON.stringify(info));
  if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('全部通过：收藏夹栏空白区可拖窗口，且不再产生整页蓝色选区。');
  }
  app.quit();
}).catch(e => { console.error(e && e.stack); app.quit(); });
