'use strict';
/**
 * 验证「透明 / 完全透明」两档在真实外壳里的菜单项与状态联动。
 *
 * 【背景：为什么是两个「档位」而不是两个独立开关】
 * 完全透明 = 普通透明 + 清掉所有元素底色（只留文字）。
 * 实现上它必然连带打开普通透明（外壳 body 底色靠 .transparent 清掉，
 * 见 styles.css 里 body.transparent{background:transparent}），
 * 所以完全透明档位下 body 同时带 transparent 与 full-transparent 两个类。
 *
 * 但对外只有「当前生效的是哪一档」这一件事：
 *   档位 0 普通视图    → [进入透明模式]     [进入完全透明模式]
 *   档位 1 普通透明    → [退出透明模式]     [进入完全透明模式]
 *   档位 2 完全透明    → [进入透明模式]     [退出完全透明模式]
 *
 * 【本诊断要防的回归】
 * 旧实现里菜单文案直接取 isTransparent()（body 有没有 transparent 类），
 * 于是点一次「进入完全透明模式」，旁边那项就自己翻成「退出透明模式」——
 * 用户从没单独开过普通透明，却被告知它已开启，点它还会把完全透明一起拽下来。
 * 现在文案一律按 transparentLevel() 给，且「进入透明模式」在完全透明档位下
 * 的语义是**降一档**到普通透明（与同菜单里「无框模式 / 无框模式2」一致）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const ROOT = __dirname;
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:1000, height:700,
    webPreferences:{ offscreen:true, contextIsolation:true, nodeIntegration:false,
      preload:path.join(ROOT,'preload.js'), webviewTag:true, sandbox:false }});
  const wc = win.webContents;
  wc.on('console-message', (_e,_l,m) => console.log('  [页面] ' + m));

  // 【关键】必须在 loadFile 之前清掉持久化状态。
  // renderer.js 在启动时就读 localStorage 恢复模式（mb_transparent 等），
  // 上一轮测试留下的 '1' 会让菜单文案变成「退出透明模式」，
  // 使「进入透明模式」断言失败 —— 那是测试环境污染，不是产品缺陷。
  // 放在 loadFile 之后就晚了，那时状态已被恢复并写回。
  // 用 executeJavaScript 在 about:blank 上先清一次（此时同源 localStorage 可用）。
  await wc.loadURL('about:blank');
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_full_auto_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  `).catch(() => {});

  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1600);

  const fails = [], log = [];
  const exp = (c,m) => { if(!c) fails.push(m); };

  const READ_STATE = `({
    cls: document.body.className,
    full: document.body.classList.contains('full-transparent'),
    trans: document.body.classList.contains('transparent'),
    level: (typeof transparentLevel === 'function') ? transparentLevel() : -1,
    flags: {
      t: localStorage.getItem('mb_transparent'),
      f: localStorage.getItem('mb_full_transparent'),
      auto: localStorage.getItem('mb_full_auto_transparent'),
    },
  })`;
  const state = () => wc.executeJavaScript(READ_STATE);

  // 走真实菜单点击路径：先弹菜单，再按文案找到 li 并 click
  async function clickMenu(label) {
    await wc.executeJavaScript(`
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100,button:2}));
    `);
    await wait(250);
    const ok = await wc.executeJavaScript(`(function () {
      var items = Array.prototype.slice.call(
        document.querySelectorAll('#context-menu-list li'));
      var li = items.filter(function (n) { return n.textContent === ${JSON.stringify(label)}; })[0];
      if (!li) return false;
      li.click();
      return true;
    })()`);
    exp(ok, '菜单项「' + label + '」应存在');
    await wait(300);
  }

  // 只读菜单项文案，不点击
  async function menuItems() {
    await wc.executeJavaScript(`
      document.querySelector('.toolbar').dispatchEvent(
        new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100,button:2}));
    `);
    await wait(300);
    return await wc.executeJavaScript(`
      Array.from(document.querySelectorAll('#context-menu-list li')).map(li => li.textContent)
    `);
  }

  async function resetView() {
    await wc.executeJavaScript(`
      try {
        if (typeof setTransparentLevel === 'function') setTransparentLevel(0);
        else { applyFullTransparent(false); applyTransparent(false); }
      } catch (e) {}
      try {
        ['mb_transparent','mb_full_transparent','mb_full_auto_transparent']
          .forEach(function (k) { localStorage.setItem(k, '0'); });
      } catch (e) {}
      document.body.classList.remove('transparent', 'full-transparent');
    `);
    await wait(200);
  }

  // 兜底再清一次（loadFile 期间 renderer.js 可能又写回了状态）
  await wc.executeJavaScript(`
    try {
      ['mb_transparent','mb_full_transparent','mb_full_auto_transparent','mb_frameless','mb_frameless2']
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    document.body.className = '';
  `);
  await wait(300);

  // 右键菜单里应有「进入完全透明模式」项，且在「进入透明模式」下方
  await wc.executeJavaScript(`
    document.querySelector('.toolbar').dispatchEvent(
      new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100,button:2}));
  `);
  await wait(400);
  const items = await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li'))
      .map(li => li.textContent)
  `);
  log.push(['菜单项', JSON.stringify(items)]);
  const iT = items.indexOf('进入透明模式');
  const iF = items.indexOf('进入完全透明模式');
  exp(iT >= 0, '菜单应有「进入透明模式」，实际 ' + JSON.stringify(items));
  exp(iF >= 0, '菜单应有「进入完全透明模式」，实际 ' + JSON.stringify(items));
  exp(iF === iT + 1, '「进入完全透明模式」应紧跟在「进入透明模式」下方，实际索引 ' + iT + ' -> ' + iF);

  // 点击该项：应进入完全透明档位（transparent + full-transparent 同时生效）
  await wc.executeJavaScript(`
    Array.from(document.querySelectorAll('#context-menu-list li'))
      .find(li => li.textContent === '进入完全透明模式').click();
  `);
  await wait(600);
  const st = await wc.executeJavaScript(`({
    cls: document.body.className,
    full: document.body.classList.contains('full-transparent'),
    trans: document.body.classList.contains('transparent'),
  })`);
  log.push(['点击后 body.class', st.cls]);
  exp(st.full === true, '点击后应带 full-transparent 类');
  exp(st.trans === true, '点击后应同时带 transparent 类（完全透明依赖透明模式）');

  // 外壳的地址栏也必须透明：.url-bar 与 #go 自身带不透明底色，
  // 仅清父级 .toolbar 时红框区域仍会留下一块深色胶囊 + 蓝色圆按钮。
  const clearBg = c => c === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);
  const shell = await wc.executeJavaScript(`(() => {
    const read = sel => {
      const s = getComputedStyle(document.querySelector(sel));
      return { bg: s.backgroundColor, img: s.backgroundImage };
    };
    return { urlbar: read('.url-bar'), go: read('#go') };
  })()`);
  log.push(['地址栏计算样式', JSON.stringify(shell)]);
  exp(clearBg(shell.urlbar.bg) && shell.urlbar.img === 'none',
    '完全透明时 .url-bar 背景应为透明，实际 ' + JSON.stringify(shell.urlbar));
  exp(clearBg(shell.go.bg) && shell.go.img === 'none',
    '完全透明时 #go 按钮背景应为透明，实际 ' + JSON.stringify(shell.go));

  // ---- 核心回归：完全透明档位下，「透明模式」那一项不得自己翻成「退出透明模式」----
  const items2 = await menuItems();
  log.push(['完全透明档位菜单项', JSON.stringify(items2)]);
  exp(items2.indexOf('进入透明模式') >= 0,
    '完全透明档位下菜单应仍显示「进入透明模式」，实际 ' + JSON.stringify(items2));
  exp(items2.indexOf('退出透明模式') < 0,
    '完全透明档位下不应出现「退出透明模式」（用户从没单独开过普通透明），实际 ' +
    JSON.stringify(items2));
  exp(items2.indexOf('退出完全透明模式') >= 0,
    '完全透明档位下应显示「退出完全透明模式」，实际 ' + JSON.stringify(items2));

  // 点击「退出完全透明模式」：从普通视图直达完全透明时，点一次就该完整还原
  await clickMenu('退出完全透明模式');
  const st2 = await state();
  log.push(['退出后 body.class', st2.cls]);
  log.push(['退出后持久化标记', JSON.stringify(st2.flags)]);
  exp(st2.full === false, '退出后 full-transparent 应移除');
  exp(st2.trans === false, '从普通视图进入完全透明后，点一次「退出完全透明模式」就应回到普通视图');
  exp(st2.flags.t === '0' && st2.flags.f === '0' && st2.flags.auto === '0',
    '退出后三个持久化标记都应为 0，实际 ' + JSON.stringify(st2.flags));

  // 退出后地址栏底色应恢复正常（外壳不再处于任何透明模式）
  const shell2 = await wc.executeJavaScript(`getComputedStyle(document.querySelector('.url-bar')).backgroundColor`);
  log.push(['退出后地址栏底色', shell2]);
  exp(!clearBg(shell2), '退出完全透明后 .url-bar 底色应恢复，实际 ' + shell2);

  // ---- 场景B：用户先手动开透明，再开完全透明；退出完全透明应回到「仅透明」 ----
  await resetView();
  await clickMenu('进入透明模式');
  let sb = await state();
  exp(sb.trans === true && sb.full === false && sb.flags.auto === '0',
    'B：手动进入透明模式后 auto 标记应为 0，实际 ' + JSON.stringify(sb));
  await clickMenu('进入完全透明模式');
  sb = await state();
  exp(sb.full === true && sb.trans === true && sb.flags.auto === '0',
    'B：在透明基础上进入完全透明不应改写 auto 标记，实际 ' + JSON.stringify(sb));
  await clickMenu('退出完全透明模式');
  sb = await state();
  log.push(['B 退出后', JSON.stringify(sb)]);
  exp(sb.full === false && sb.trans === true && sb.flags.auto === '0',
    'B：手动透明进入的完全透明，退出后应保留透明模式，实际 ' + JSON.stringify(sb));

  // ---- 场景C：完全透明档位下点「进入透明模式」= 降一档到普通透明 ----
  // （不是把两个模式一起关掉，也不是留下 full-transparent 单独生效的半吊子状态）
  await resetView();
  await clickMenu('进入完全透明模式');
  let sc = await state();
  exp(sc.full === true && sc.trans === true && sc.flags.auto === '1',
    'C：进入完全透明时 auto 标记应为 1，实际 ' + JSON.stringify(sc));
  await clickMenu('进入透明模式');
  sc = await state();
  log.push(['C 降档后', JSON.stringify(sc)]);
  exp(sc.full === false, 'C：完全透明档位下点「进入透明模式」应退出完全透明，实际 ' + JSON.stringify(sc));
  exp(sc.trans === true, 'C：降档后应保留普通透明（transparent 类），实际 ' + JSON.stringify(sc));
  const shellC = await wc.executeJavaScript(`getComputedStyle(document.querySelector('.url-bar')).backgroundColor`);
  log.push(['C 降档后地址栏底色', shellC]);
  exp(!clearBg(shellC),
    'C：降档后完全透明的 CSS 应撤掉，.url-bar 底色应恢复，实际 ' + shellC);
  const itemsC = await menuItems();
  exp(itemsC.indexOf('退出透明模式') >= 0,
    'C：降档后菜单应显示「退出透明模式」，实际 ' + JSON.stringify(itemsC));

  // ---- 场景D：模拟重启恢复（keepAuto），退出仍应一步还原 ----
  await resetView();
  await wc.executeJavaScript(`
    localStorage.setItem('mb_transparent', '1');
    localStorage.setItem('mb_full_transparent', '1');
    localStorage.setItem('mb_full_auto_transparent', '1');
    document.body.classList.add('transparent', 'full-transparent');
    if (typeof setTransparentLevel === 'function') setTransparentLevel(2, { keepAuto: true });
    else applyFullTransparent(true, { keepAuto: true });
  `);
  await wait(300);
  let sd = await state();
  exp(sd.full === true && sd.trans === true && sd.flags.auto === '1',
    'D：重启恢复后 auto 标记应保留为 1，实际 ' + JSON.stringify(sd));
  await clickMenu('退出完全透明模式');
  sd = await state();
  log.push(['D 重启后退出', JSON.stringify(sd)]);
  exp(sd.full === false && sd.trans === false && sd.flags.auto === '0',
    'D：重启恢复的完全透明退出后应一步还原，实际 ' + JSON.stringify(sd));

  console.log('\n======== 透明档位 UI 联动验证 ========');
  log.forEach(([k,v]) => console.log('  ' + String(k).padEnd(24) + v));
  console.log('=======================================');
  if (fails.length) { console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  X ' + f)); process.exitCode = 1; }
  else console.log('\n全部通过：两档文案互不串档；完全透明档位下「进入透明模式」表示降一档；' +
    '直接进完全透明可一步退出，手动透明进的完全透明退出后保留透明；重启恢复与降档均正确。');
  app.quit();
}).catch(e => { console.error(e && e.stack); app.quit(); });
