'use strict';

/**
 * 橡皮擦端到端验证（离屏渲染，无需真实显示器）。
 *
 * 验证链路与真机完全一致：
 *   宿主 renderer.js 用同步 XHR 读 element-eraser.js
 *     → executeJavaScript 注入 guest 主世界
 *       → 页面 mousemove/click
 *         → el.remove() 真正把元素从 DOM 摘掉
 *
 * 因为宿主是 index.html + renderer.js（依赖 localStorage / 多标签逻辑），
 * 这里不复用整个外壳，而是复刻 renderer.js 里那段注入代码的执行语义：
 * 读文件 → 拼注入代码 → executeJavaScript → 派发鼠标事件 → 断言元素已消失。
 * 这样测的就是真实会跑在页面里的那段代码。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><body style="margin:0;font:14px sans-serif">
  <div id="wrap" style="padding:40px">
    <h1 id="title">保留的头部</h1>
    <div id="victim" style="width:300px;height:200px;background:#fee;border:2px solid red">
      <p id="child">要被删除的子元素</p>
      <span id="grandchild">孙元素</span>
    </div>
    <div id="survivor" style="width:300px;height:80px;background:#efe">
      不该被删除的兄弟元素
    </div>
  </div>
</body></html>`);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL(PAGE);
  await wait(600);

  const wc = win.webContents;
  const log = [];

  // ---- 注入前基线----
  let before = await wc.executeJavaScript(
    '({victim: !!document.getElementById("victim"), child: !!document.getElementById("child"), grandchild: !!document.getElementById("grandchild"), survivor: !!document.getElementById("survivor")})'
  );
  log.push(['注入前', JSON.stringify(before)]);

  // ---- 复刻 renderer.js 的注入逻辑 ----
  const src = fs.readFileSync(path.join(ROOT, 'element-eraser.js'), 'utf8');
  const code =
    'try{' +
    src +
    '\n;window.__mbEraserToggle=function(on){try{on?window.__mbEraserStart():window.__mbEraserStop();}catch(e){}};' +
    'window.__mbEraserToggle(true);' +
    '}catch(e){console.error("[mb] eraser inject failed", e);}';
  await wc.executeJavaScript(code);
  await wait(300);

  // 注入后：橡皮擦应已激活，且覆盖层已插入页面
  const afterInject = await wc.executeJavaScript(
    '({active: !!(window.__mbEraserStart && window.__mbEraserIsActive && window.__mbEraserIsActive()), overlay: !!document.getElementById("__mb_eraser_overlay__"), toggle: typeof window.__mbEraserToggle})'
  );
  log.push(['注入后', JSON.stringify(afterInject)]);

  // ---- 模拟鼠标移动到 #victim 上（应触发高亮） ----
  const box = await wc.executeJavaScript(
    'JSON.stringify(document.getElementById("victim").getBoundingClientRect())'
  );
  const r = JSON.parse(box);
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
  await wait(250);

  const highlight = await wc.executeJavaScript(
    '(()=>{const o=document.getElementById("__mb_eraser_overlay__");if(!o||!o.shadowRoot)return {overlay:false};const bx=o.shadowRoot.querySelector(".box");const br=o.shadowRoot.querySelector(".bar");return {overlay:true, boxShown: bx?bx.style.display:null, boxW: bx?bx.style.width:null, barText: br?(br.textContent||"").trim().slice(0,60):null};})()'
  );
  log.push(['悬停高亮', JSON.stringify(highlight)]);

  // ---- 模拟点击（应删除 #victim 及其全部子元素） ----
  wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
  wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
  await wait(400);

  const afterClick = await wc.executeJavaScript(
    '({victim: !!document.getElementById("victim"), child: !!document.getElementById("child"), grandchild: !!document.getElementById("grandchild"), survivor: !!document.getElementById("survivor"), title: !!document.getElementById("title")})'
  );
  log.push(['点击后', JSON.stringify(afterClick)]);

  // ---- 停用：覆盖层应被清理 ----
  await wc.executeJavaScript('window.__mbEraserToggle(false)');
  await wait(200);
  const afterStop = await wc.executeJavaScript(
    '({overlay: !!document.getElementById("__mb_eraser_overlay__"), active: window.__mbEraserIsActive ? window.__mbEraserIsActive() : null})'
  );
  log.push(['停用后', JSON.stringify(afterStop)]);

  // ---- 断言 ----
  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  expect(before.victim && before.child && before.grandchild, '基线：#victim/#child/#grandchild 应都存在');
  expect(afterInject.active === true, '注入后橡皮擦应为激活态');
  expect(afterInject.toggle === 'function', '注入后应挂载 __mbEraserToggle');
  expect(afterInject.overlay === true, '注入后应插入覆盖层节点');
  expect(highlight.overlay === true && highlight.boxShown === 'block', '悬停时高亮框应显示');
  expect(/div/.test(highlight.barText || ''), '信息条应显示元素描述，实际: ' + highlight.barText);
  expect(afterClick.victim === false, '#victim 应被删除');
  expect(afterClick.child === false, '#victim的子元素 #child 应被连带删除');
  expect(afterClick.grandchild === false, '孙元素 #grandchild 应被连带删除');
  expect(afterClick.survivor === true, '兄弟元素 #survivor 不应被删除');
  expect(afterClick.title === true, '非目标元素 #title 不应被删除');
  expect(afterStop.overlay === false, '停用后覆盖层应被移除');
  expect(afterStop.active === false, '停用后橡皮擦应为未激活');

  console.log('\n==========橡皮擦端到端验证 ==========');
  for (const [k, v] of log) console.log('  ' + k.padEnd(10, ' ') + v);
  console.log('=====================================');
  if (failures.length) {
    console.error('\n失败 ' + failures.length + ' 项：');
    failures.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：元素及其全部子元素被删除，兄弟/无关元素保留，覆盖层可清理。');
  }
}

app.whenReady()
  .then(run)
  .catch((e) => {
    console.error('验证脚本异常:', e && e.stack);
    process.exitCode = 1;
  })
  .then(() => setTimeout(() => app.quit(), 500));
