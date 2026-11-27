'use strict';
/** 验证工具栏按钮图标：统一 sprite、统一规格，并覆盖普通/透明/完全透明模式。 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

  // 清掉持久化状态，避免上一轮诊断留下的透明/书签数据影响断言。
  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_frameless','mb_frameless2','mb_bookmarks','mb_tabs']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `);
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1600);

  const fails = [], log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const BUTTON_IDS = [
    'back', 'forward', 'reload', 'home', 'go', 'bookmark', 'find', 'history',
    'devtools', 'downloads', 'video-dl', 'save-page', 'eraser', 'debold',
    'pin', 'settings', 'win-min', 'win-max', 'win-close'
  ];
  const icons = await wc.executeJavaScript(`(ids => ids.map(id => {
    const b = document.getElementById(id);
    const svg = b && b.querySelector('svg.icon');
    const use = svg && svg.querySelector('use');
    const s = svg ? getComputedStyle(svg) : null;
    const directText = b
      ? Array.from(b.childNodes)
          .filter(n => n.nodeType === 3 && n.textContent.trim())
          .map(n => n.textContent.trim())
      : [];
    return {
      id,
      href: use ? use.getAttribute('href') : null,
      w: s ? s.width : null,
      h: s ? s.height : null,
      stroke: s ? s.stroke : null,
      strokeWidth: s ? s.strokeWidth : null,
      fill: s ? s.fill : null,
      color: b ? getComputedStyle(b).color : null,
      directText
    };
  }))(${JSON.stringify(BUTTON_IDS)})`);

  log.push(['图标按钮数', icons.length]);
  icons.forEach(i => {
    exp(!!i.href && i.href.startsWith('#i-'), i.id + ' 缺少 sprite use：' + JSON.stringify(i));
    exp(i.directText.length === 0, i.id + ' 仍有字符图标残留：' + JSON.stringify(i.directText));
    exp(i.w === '18px' && i.h === '18px', i.id + ' 尺寸不统一：' + i.w + 'x' + i.h);
    exp(i.stroke === i.color, i.id + ' 未使用 currentColor：' + i.stroke + ' vs ' + i.color);
    exp(i.strokeWidth === '1.7px', i.id + ' 线宽不统一：' + i.strokeWidth);
    exp(i.fill === 'none', i.id + ' 填充应为 none，实际 ' + i.fill);
  });

  const lock = await wc.executeJavaScript(`(() => {
    const svg = document.querySelector('#lock svg.icon');
    const s = getComputedStyle(svg);
    return { href: svg.querySelector('use').getAttribute('href'), w: s.width, h: s.height };
  })()`);
  log.push(['锁图标', JSON.stringify(lock)]);
  exp(lock.href === '#i-lock' && lock.w === '15px' && lock.h === '15px',
    '锁图标规格不符：' + JSON.stringify(lock));

  // 状态切换：锁 / 收藏星标 / 刷新-停止。
  const hrefOf = id => wc.executeJavaScript(
    `document.querySelector('#${id} svg.icon use').getAttribute('href')`
  );

  await wc.executeJavaScript(`updateLock('https://example.com')`);
  exp(await hrefOf('lock') === '#i-lock', 'HTTPS 应显示闭合锁');
  await wc.executeJavaScript(`updateLock('http://example.com')`);
  exp(await hrefOf('lock') === '#i-unlock', 'HTTP 应显示开锁');

  await wc.executeJavaScript(`
    saveBookmarks({type:'folder',title:'',children:[
      {type:'bookmark',title:'state test',url:'https://state.test'}
    ]});
    document.getElementById('url').value = 'https://state.test';
    refreshBookmarkStar();
  `);
  exp(await hrefOf('bookmark') === '#i-star-filled', '已收藏应为实心星');
  await wc.executeJavaScript(`
    saveBookmarks({type:'folder',title:'',children:[]});
    refreshBookmarkStar();
  `);
  exp(await hrefOf('bookmark') === '#i-star', '未收藏应为空心星');

  const hasWebview = await wc.executeJavaScript(`!!document.querySelector('webview')`);
  if (hasWebview) {
    await wc.executeJavaScript(`document.querySelector('webview').dispatchEvent(new Event('did-start-loading'))`);
    await wait(100);
    exp(await hrefOf('reload') === '#i-stop', '加载中应显示停止图标');
    await wc.executeJavaScript(`document.querySelector('webview').dispatchEvent(new Event('did-stop-loading'))`);
    await wait(100);
    exp(await hrefOf('reload') === '#i-reload', '加载结束应恢复刷新图标');
  } else {
    log.push(['刷新状态', '无 webview，跳过']);
  }

  // 模式对比：普通模式无光晕；透明/完全透明模式加淡光晕保证桌面上可见。
  const modes = [
    ['normal', false, false],
    ['transparent', true, false],
    ['full-transparent', true, true]
  ];
  for (const [name, transparent, full] of modes) {
    await wc.executeJavaScript(`(() => {
      document.body.classList.toggle('transparent', ${transparent});
      document.body.classList.toggle('full-transparent', ${full});
    })()`);
    await wait(100);
    const m = await wc.executeJavaScript(`(() => {
      const svg = document.querySelector('#back svg.icon');
      const s = getComputedStyle(svg);
      return { filter: s.filter, color: getComputedStyle(document.getElementById('back')).color };
    })()`);
    log.push([name, JSON.stringify(m)]);
    if (name === 'normal') exp(m.filter === 'none', '普通模式不应有图标光晕：' + m.filter);
    else exp(m.filter.includes('drop-shadow'), name + ' 图标应有淡光晕：' + m.filter);
    exp(m.color.length > 0, name + ' 图标颜色应可解析');
    if (name === 'normal') {
      const png = await wc.capturePage();
      fs.writeFileSync(path.join(os.tmpdir(), 'mb-toolbar-icons-normal.png'), png.toPNG());
    }
    if (name === 'full-transparent') {
      const png = await wc.capturePage();
      fs.writeFileSync(path.join(os.tmpdir(), 'mb-toolbar-icons-full.png'), png.toPNG());
    }
  }

  console.log('\n======== 工具栏图标统一验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(22) + v));
  console.log('====================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：图标规格一致、无字符图标残留、状态切换与模式光晕正确。');
  }
  app.quit();
}).catch(e => { console.error(e && e.stack); app.quit(); });
