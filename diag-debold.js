'use strict';

/**
 * 诊断：工具栏「去粗体」按钮。
 *
 * 覆盖：
 *   A 按钮存在，点击后 aria-pressed 变为 true
 *   B 页面里的 <b> / <strong> / <h1> / 内联 font-weight:700 都变成常规字重
 *   C 非粗体元素不受影响
 *   D 再次点击恢复粗体（且 aria-pressed 回到 false）
 *   E 切标签后各自状态独立，按钮态跟随当前标签
 *   F 页面导航后样式仍在（insertCSS 的样式会被导航清除，必须重新注入）
 *
 * 用法：node diag-debold.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// 独立 userData：诊断会改 localStorage，不能污染真实 profile。
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'minibrowser-diag-debold-' + process.pid));

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 用本地测试页而不是 data: URL —— data: URL 在 webview 里会报 ERR_ABORTED
const TEST_HTML = 'file:///' + ROOT.replace(/\\/g, '/') + '/tools/test-bold.html';

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(2200);

  // 把当前标签的页面换成测试页
  await wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      t.webview.src = ${JSON.stringify(TEST_HTML)};
    })();
  `);
  await wait(2000);

  /** 读 guest 里各元素的计算字重。 */
  const weights = () => wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      return t.webview.executeJavaScript(\`
        (() => {
          const g = id => {
            const el = document.getElementById(id);
            return el ? getComputedStyle(el).fontWeight : 'missing';
          };
          return JSON.stringify({
            b: g('b1'), s: g('s1'), h1: g('h1'),
            fw: g('fw'), bc: g('bc'), b6: g('b6'), norm: g('norm'),
          });
        })();
      \`);
    })();
  `);

  /** 读同源 iframe 内的计算字重（insertCSS 管不到 iframe，必须单独验证）。 */
  const frameWeights = () => wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      return t.webview.executeJavaScript(\`
        (() => {
          const fr = document.getElementById('frame1');
          let fd = null;
          try { fd = fr && fr.contentDocument; } catch (e) { fd = null; }
          if (!fd) return JSON.stringify({ err: 'no-frame-doc' });
          const fg = id => {
            const el = fd.getElementById(id);
            return el ? getComputedStyle(el).fontWeight : 'missing';
          };
          return JSON.stringify({
            fb: fg('fb'), fs: fg('fs'), fh: fg('fh'),
            ffw: fg('ffw'), fbc: fg('fbc'), fnorm: fg('fnorm'),
            hasStyle: !!fd.getElementById('mb-debold-style'),
          });
        })();
      \`);
    })();
  `);

  const btnState = () => wc.executeJavaScript(`
    (() => {
      const b = document.getElementById('debold');
      if (!b) return 'no-btn';
      const t = activeTab();
      return JSON.stringify({ pressed: b.getAttribute('aria-pressed'), tabDebold: t ? t.debold : null });
    })();
  `);

  // ---------- 初始 ----------
  let w0 = JSON.parse(await weights());
  let b0 = JSON.parse(await btnState());
  log.push(['初始 字重', JSON.stringify(w0)]);
  log.push(['初始 按钮', JSON.stringify(b0)]);
  exp(b0.pressed === 'false', '场景A：按钮初始应为未激活');
  exp(w0.b === '700', '场景A：<b> 初始应���粗体，实际 ' + w0.b);
  exp(w0.norm === '400', '场景A：普通文字初始应为 400，实际 ' + w0.norm);

  // ---------- A/B. 点击去粗体 ----------
  await wc.executeJavaScript(`document.getElementById('debold').click();`);
  await wait(900);
  let w1 = JSON.parse(await weights());
  let b1 = JSON.parse(await btnState());
  log.push(['去粗后 字重', JSON.stringify(w1)]);
  log.push(['去粗后 按钮', JSON.stringify(b1)]);
  exp(b1.pressed === 'true', '场景A：点击后 aria-pressed 应为 true');
  exp(b1.tabDebold === true, '场景A：点击后 tab.debold 应为 true');
  exp(w1.b === '400', '场景B：<b> 应变为常规，实际 ' + w1.b);
  exp(w1.s === '400', '场景B：<strong> 应变为常规，实际 ' + w1.s);
  exp(w1.h1 === '400', '场景B：<h1> 应变为常规，实际 ' + w1.h1);
  exp(w1.fw === '400', '场景B：内联 font-weight:700 应变为常规，实际 ' + w1.fw);
  exp(w1.bc === '400', '场景B：class 加粗应变为常规，实际 ' + w1.bc);
  exp(w1.b6 === '400', '场景B：font-weight:600 应变为常规，实际 ' + w1.b6);
  exp(w1.norm === '400', '场景C：普通文字应保持 400，实际 ' + w1.norm);

  // ---------- B2. 同源 iframe 内的粗体同样要去掉 ----------
  let f1 = JSON.parse(await frameWeights());
  log.push(['iframe 字重', JSON.stringify(f1)]);
  exp(f1.err === undefined, '场景B2：应能读到 iframe 文档，实际 ' + f1.err);
  exp(f1.hasStyle === true, '场景B2：iframe 内应已插入 style 元素，实际 ' + f1.hasStyle);
  exp(f1.fb === '400', '场景B2：iframe 内 <b> 应变为常规，实际 ' + f1.fb);
  exp(f1.fs === '400', '场景B2：iframe 内 <strong> 应变为常规，实际 ' + f1.fs);
  exp(f1.fh === '400', '场景B2：iframe 内 <h2> 应变为常规，实际 ' + f1.fh);
  exp(f1.ffw === '400', '场景B2：iframe 内联 700 应变为常规，实际 ' + f1.ffw);
  exp(f1.fbc === '400', '场景B2：iframe class 粗体应变为常规，实际 ' + f1.fbc);
  exp(f1.fnorm === '400', '场景B2：iframe 普通文字应保持 400，实际 ' + f1.fnorm);

  // ---------- D. 再次点击恢复 ----------
  await wc.executeJavaScript(`document.getElementById('debold').click();`);
  await wait(900);
  let w2 = JSON.parse(await weights());
  let b2 = JSON.parse(await btnState());
  log.push(['恢复后 字重', JSON.stringify(w2)]);
  log.push(['恢复后 按钮', JSON.stringify(b2)]);
  exp(b2.pressed === 'false', '场景D：再次点击后 aria-pressed 应回到 false');
  exp(w2.b === '700', '场景D：<b> 应恢复粗体，实际 ' + w2.b);
  exp(w2.h1 === '700', '场景D：<h1> 应恢复粗体，实际 ' + w2.h1);
  let f2 = JSON.parse(await frameWeights());
  log.push(['恢复后 iframe 字重', JSON.stringify(f2)]);
  exp(f2.fb === '700', '场景D：iframe 内 <b> 应恢复粗体，实际 ' + f2.fb);
  exp(f2.hasStyle === false, '场景D：iframe 内的 style 元素应被移除，实际 ' + f2.hasStyle);

  // ---------- F. 导航后仍生效 ----------
  // 重新开启去粗体，然后让页面导航 —— insertCSS 的样式会被导航清除，
  // 必须靠 did-navigate 里的重新注入来维持。
  await wc.executeJavaScript(`document.getElementById('debold').click();`);
  await wait(600);
  await wc.executeJavaScript(`
    (() => {
      const t = activeTab();
      t.webview.src = ${JSON.stringify(TEST_HTML)};
    })();
  `);
  await wait(2200);
  const w3 = JSON.parse(await weights());
  log.push(['导航后 字重', JSON.stringify(w3)]);
  exp(w3.b === '400', '场景F：导航后 <b> 仍应去粗体，实际 ' + w3.b);
  exp(w3.h1 === '400', '场景F：导航后 <h1> 仍应去粗体，实际 ' + w3.h1);
  let f3 = JSON.parse(await frameWeights());
  log.push(['导航后 iframe 字重', JSON.stringify(f3)]);
  exp(f3.fb === '400', '场景F：导航后 iframe 内 <b> 仍应去粗体，实际 ' + f3.fb);

  // ---------- E. 切标签状态独立 ----------
  const tabState = await wc.executeJavaScript(`
    (() => {
      const t1 = activeTab();
      const t2 = createTab('about:blank', false);
      setActiveTab(t2.id);
      const btn = document.getElementById('debold');
      const r = JSON.stringify({
        t1Debold: t1.debold, t2Debold: t2.debold,
        pressed: btn.getAttribute('aria-pressed'),
      });
      // 切回第一个标签
      setActiveTab(t1.id);
      return r;
    })();
  `);
  log.push(['切标签 状态', tabState]);
  const ts = JSON.parse(tabState);
  exp(ts.t1Debold === true && ts.t2Debold === false, '场景E：两个标签的开关应互相独立');
  exp(ts.pressed === 'false', '场景E：切到未开启的标签时按钮应显示未激活');

  console.log('\n======== 去粗体按钮 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(18, ' ') + v));
  console.log('====================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：粗体全部去除、恢复、导航后保持、各标签独立。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
