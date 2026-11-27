'use strict';
/** 回归：右键菜单贴近窗口顶部时，落在原拖拽区上的菜单项也能正常点击。 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const ROOT = __dirname;
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
  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`try{['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2'].forEach(k=>localStorage.removeItem(k))}catch(e){}`);
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1500);

  const fails = [], log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const appRegion = await wc.executeJavaScript(
    `getComputedStyle(document.getElementById('context-menu')).webkitAppRegion`
  );
  log.push(['菜单 app-region', appRegion]);
  exp(appRegion === 'no-drag', '右键菜单应显式 no-drag，实际 ' + appRegion);

  async function probe(label, x, y, viaRightClick) {
    await wc.executeJavaScript(`(() => {
      hideContextMenu();
      applyTransparent(true);
    })()`);
    await wait(100);
    if (viaRightClick) {
      await wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    } else {
      await wc.executeJavaScript(`showPageContextMenu(${x}, ${y})`);
    }
    await wait(250);

    const info = await wc.executeJavaScript(`(() => {
      const li = Array.from(document.querySelectorAll('#context-menu-list li'))
        .find(n => n.textContent === '退出透明模式');
      if (!li) return { missing: true };
      const r = li.getBoundingClientRect();
      const px = Math.round(r.left + r.width / 2), py = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(px, py);
      return {
        top: Math.round(r.top),
        shellBottom: Math.round(getVisibleShellBottom()),
        px, py,
        hitIsLi: !!(hit && hit.closest && hit.closest('#context-menu-list li') === li)
      };
    })()`);
    exp(!info.missing, label + '：菜单项「退出透明模式」不存在');
    if (!info.missing) {
      log.push([label, JSON.stringify(info)]);
      exp(info.top >= info.shellBottom, label + '：菜单项压在拖拽区上 top=' + info.top +
        ' shellBottom=' + info.shellBottom);
      exp(info.hitIsLi, label + '：菜单项中心命中了别的元素');

      await wc.sendInputEvent({ type: 'mouseDown', x: info.px, y: info.py, button: 'left', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x: info.px, y: info.py, button: 'left', clickCount: 1 });
      await wait(300);
      const after = await wc.executeJavaScript(`({
        transparent: document.body.classList.contains('transparent'),
        menuHidden: document.getElementById('context-menu').classList.contains('hidden')
      })`);
      exp(after.transparent === false, label + '：点击后透明模式应关闭');
      exp(after.menuHidden === true, label + '：点击后菜单应收起');
    }
  }

  await probe('顶部锚点-直接调用', 700, 10, false);
  await probe('中部锚点-直接调用', 700, 200, false);
  await probe('右键工具栏', 700, 10, true);
  await probe('右键标签栏', 700, 85, true);
  await probe('右键网页', 700, 200, true);

  console.log('\n======== 右键菜单拖拽区命中验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(22) + v));
  console.log('========================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：菜单不再压在拖拽区上，各位置点击均生效。');
  }
  app.quit();
}).catch(e => { console.error(e && e.stack); app.quit(); });
