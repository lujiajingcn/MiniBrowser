'use strict';

/**
 * 诊断：收藏书签时带上站点图标。
 *
 * 覆盖：
 *   A 收藏时把当前标签的 favicon 存进书签的 icon 字段
 *   B 书签面板渲染出 <img class="bm-favicon">，src 是该 favicon
 *   C 没有 icon 的老书签会按站点约定猜 /favicon.ico
 *   D 图标加载失败时回退成 🔗（不留破图）
 *   E 导出书签 HTML 带 ICON 属性（跨浏览器可用）
 *
 * 【为什么在渲染进程里一次性跑完】
 * 分多次 executeJavaScript 时，某一步正好碰上页面状态变化就会报
 * "Script failed to execute"，且没有任何定位信息。一次性跑完只回传结果，
 * 还能顺带捕获每一步的具体异常。
 *
 * 【为什么不起本地 HTTP 服务】
 * Chromium 的 guest 进程在本机代理环境下连不上临时端口（ERR_CONNECTION_REFUSED），
 * 而本用例要验的是「收藏时把 favicon 存下来 + 面板渲染」，
 * 直接给 tab 注入 favicon 值即可，不必依赖真实网络。
 *
 * 用法：node diag-bookmark-favicon.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 独立 userData：单实例锁依赖该路径，用户开着应用时也能跑
process.env.MB_USER_DATA_DIR = path.join(os.tmpdir(), 'minibrowser-diag-bmfav');
process.env.MB_SHOW_PORT = '39324';

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    width: 1000, height: 700, show: true,
    frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);

  const SITE = 'https://example.com/icon-test';
  const LEGACY = 'https://example.com/legacy';

  // 先清空书签：书签存在 localStorage 里，诊断每次跑都会往里 push 测试数据，
  // 不清空的话会**累积** —— 上一轮 push 的那条会干扰本轮的查找
  // （表现为读到的 src 总是上一轮那个，看着像代码没生效）。
  await wc.executeJavaScript('(function () { resetBookmarks(); return "ok"; })()');
  await wait(400);

  // ---- 阶段 1：收藏 + 面板渲染 + 导出（渲染进程内一次跑完）----
  const phase1 = JSON.parse(await wc.executeJavaScript(`
    (function () {
      var R = {};
      function step(name, fn) {
        try { R[name] = { ok: true, v: fn() }; }
        catch (e) {
          R[name] = { ok: false, v: (e && e.message) + ' @ ' +
            String(e && e.stack).split('\\n').slice(0, 3).join(' <- ') };
        }
      }

      step('setTab', function () {
        var t = activeTab();
        t.favicon = 'https://example.com/favicon.ico';
        t.title = '图标测试页';
        // bmAddCurrent() 收藏的是地址栏里的地址，所以要同步设置
        urlInput.value = ${JSON.stringify(SITE)};
        return 'ok';
      });

      step('add', function () {
        _bmCurrent = getBookmarks();
        bmAddCurrent();
        return 'ok';
      });

      step('readBm', function () {
        var root = getBookmarks();
        var list = (root.children || []).filter(function (c) { return c.type === 'bookmark'; });
        return JSON.stringify(list.map(function (b) {
          return { url: b.url, icon: b.icon, title: b.title };
        }));
      });

      step('addLegacy', function () {
        var root = getBookmarks();
        root.children.push({ type: 'bookmark', title: '老书签', url: ${JSON.stringify(LEGACY)} });
        saveBookmarks(root);
        return 'ok';
      });

      step('render', function () { renderBookmarksPopover(); return 'ok'; });

      step('queryImg', function () {
        var imgs = Array.from(document.querySelectorAll('#bm-list img.bm-favicon'));
        return JSON.stringify(imgs.map(function (i) { return i.getAttribute('src'); }));
      });

      step('queryBarImg', function () {
        renderBookmarks();
        var imgs = Array.from(document.querySelectorAll('#bookmarks-bar img.bm-bar-favicon'));
        return JSON.stringify(imgs.map(function (i) { return i.getAttribute('src'); }));
      });

      step('export', function () {
        var html = window.BookmarksIO.buildNetscapeBookmarks(getBookmarks(), 'Bookmarks');
        var line = (html.split('\\n').filter(function (l) {
          return l.indexOf('favicon.ico') >= 0;
        })[0]) || '';
        return JSON.stringify({ hasIcon: html.indexOf('ICON="') >= 0, line: line.slice(0, 150) });
      });

      return JSON.stringify(R);
    })();
  `));

  Object.keys(phase1).filter((k) => !phase1[k].ok)
    .forEach((k) => log.push(['★ ' + k + ' 失败', phase1[k].v]));
  log.push(['phase1 各步', JSON.stringify(Object.keys(phase1).map(
    (k) => k + '=' + (phase1[k].ok ? 'ok' : 'FAIL')).join(','))]);
  log.push(['setTab 后 urlInput', phase1.setTab.v]);
  log.push(['add 后 readBm', phase1.readBm.v]);

  // ---------- A. 收藏时带上 icon ----------
  const bmData = JSON.parse(phase1.readBm.v);
  log.push(['收藏后的书签', JSON.stringify(bmData)]);
  const saved = bmData.find((b) => b.url === SITE);
  exp(!!saved, '场景A：应收藏成功，实际 ' + JSON.stringify(bmData));
  exp(!!saved && !!saved.icon,
    '场景A：书签应带 icon 字段，实际 ' + JSON.stringify(saved && saved.icon));

  // ---------- B. 面板渲染出 favicon ----------
  const rendered = JSON.parse(phase1.queryImg.v);
  log.push(['面板里的图标', JSON.stringify(rendered)]);
  exp(rendered.length > 0, '场景B：面板应渲染出 favicon 图标');
  exp(rendered.some((r) => r && r.indexOf('favicon.ico') >= 0),
    '场景B：图标 src 应指向 favicon，实际 ' + JSON.stringify(rendered));

  // ---------- C. 老书签（无 icon）猜 /favicon.ico ----------
  exp(rendered.some((r) => r && r === 'https://example.com/favicon.ico'),
    '场景C：无 icon 的老书签应猜 /favicon.ico，实际 ' + JSON.stringify(rendered));

  // ---------- F. 收藏夹栏也显示图标 ----------
  const barImgs = JSON.parse(phase1.queryBarImg.v);
  log.push(['收藏夹栏图标', JSON.stringify(barImgs)]);
  exp(barImgs.length > 0, '场景F：收藏夹栏应渲染出图标');
  exp(barImgs.some((r) => r && r.indexOf('favicon.ico') >= 0),
    '场景F：收藏夹栏图标 src 应指向 favicon，实际 ' + JSON.stringify(barImgs));
  // 收藏夹栏的条目应包含图标 + 标题两部分
  const barStruct = await wc.executeJavaScript(`
    (function () {
      var items = Array.from(document.querySelectorAll('#bookmarks-bar .bookmark'));
      var withIcon = items.filter(function (it) {
        return !!it.querySelector('img.bm-bar-favicon');
      })[0];
      if (!withIcon) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        hasLabel: !!withIcon.querySelector('.bm-label'),
        labelText: (withIcon.querySelector('.bm-label') || {}).textContent || '',
        imgBeforeLabel: Array.prototype.indexOf.call(withIcon.children,
          withIcon.querySelector('img.bm-bar-favicon')) === 0,
      });
    })();
  `);
  log.push(['栏条目结构', barStruct]);
  const bs = JSON.parse(barStruct);
  exp(bs.found && bs.hasLabel, '场景F：栏条目应同时有图标和标题');
  exp(bs.found && bs.imgBeforeLabel, '场景F：图标应在标题之前');

  // ---------- E. 导出带 ICON ----------
  const exported = JSON.parse(phase1.export.v);
  log.push(['导出结果', JSON.stringify(exported)]);
  exp(exported.hasIcon, '场景E：导出的 HTML 应含 ICON 属性');

  // ---- 阶段 2：图标加载失败 → 回退 🔗（需等 <img> 加载失败触发 error）----
  await wc.executeJavaScript(`
    (function () {
      var root = getBookmarks();
      root.children.push({
        type: 'bookmark', title: '坏图标书签', url: 'http://example.invalid/nope',
        icon: 'file:///definitely-not-exist-mb-favicon.png'
      });
      saveBookmarks(root);
      renderBookmarksPopover();
      return 'ok';
    })();
  `);
  // 本机代理会把请求挂起（既不 error 也不 load，complete 一直 false），
  // 所以这里分两步验证：
  //   D1 手动派发 error 事件 → 验证「加载失败」的回退逻辑；
  //   D2 等超时兜底（4s）→ 验证「请求被挂起」时也能回退。
  const readBad = async () => JSON.parse(await wc.executeJavaScript(`
    (function () {
      var rows = Array.from(document.querySelectorAll('#bm-list .bm-row-main'));
      var bad = rows.filter(function (r) {
        return r.textContent.indexOf('坏图标书签') >= 0;
      })[0];
      if (!bad) return JSON.stringify({ found: false });
      var img = bad.querySelector('img.bm-favicon');
      return JSON.stringify({
        found: true,
        text: bad.textContent,
        hasImg: !!img,
        complete: img ? img.complete : null,
        src: img ? img.getAttribute('src') : null,
      });
    })();
  `));

  const before = await readBad();
  log.push(['坏图标行(初始)', JSON.stringify(before)]);

  // D1：手动触发 error
  await wc.executeJavaScript(`
    (function () {
      var rows = Array.from(document.querySelectorAll('#bm-list .bm-row-main'));
      var bad = rows.filter(function (r) {
        return r.textContent.indexOf('坏图标书签') >= 0;
      })[0];
      var img = bad && bad.querySelector('img.bm-favicon');
      if (img) img.dispatchEvent(new Event('error'));
      return 'ok';
    })();
  `);
  await wait(300);
  const afterErr = await readBad();
  log.push(['派发 error 后', JSON.stringify(afterErr)]);
  exp(afterErr.found && afterErr.text.indexOf('🔗') >= 0,
    '场景D1：图标加载失败应回退成 🔗，实际 ' + JSON.stringify(afterErr));
  exp(afterErr.found && afterErr.hasImg === false,
    '场景D1：回退后不应残留 img 元素，实际 ' + JSON.stringify(afterErr));

  // D2：请求被挂起（不派发 error）→ 超时兜底应生效
  await wc.executeJavaScript(`
    (function () {
      var root = getBookmarks();
      root.children.push({
        type: 'bookmark', title: '挂起图标书签', url: 'http://example.invalid/hang',
        icon: 'file:///definitely-hang-mb-favicon.png'
      });
      saveBookmarks(root);
      renderBookmarksPopover();
      return 'ok';
    })();
  `);
  await wait(5200); // 超过 4s 的超时兜底
  const afterTimeout = JSON.parse(await wc.executeJavaScript(`
    (function () {
      var rows = Array.from(document.querySelectorAll('#bm-list .bm-row-main'));
      var bad = rows.filter(function (r) {
        return r.textContent.indexOf('挂起图标书签') >= 0;
      })[0];
      if (!bad) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        text: bad.textContent,
        hasImg: !!bad.querySelector('img.bm-favicon'),
      });
    })();
  `));
  log.push(['挂起图标(等超时)', JSON.stringify(afterTimeout)]);
  exp(afterTimeout.found && afterTimeout.text.indexOf('🔗') >= 0,
    '场景D2：请求挂起时应由超时兜底回退成 🔗，实际 ' + JSON.stringify(afterTimeout));

  console.log('\n======== 收藏夹站点图标 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(20, ' ') + v));
  console.log('====================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：收藏带上图标、面板渲染、老书签兜底、加载失败回退、导出含 ICON。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
