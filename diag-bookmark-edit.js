'use strict';

/**
 * 书签编辑功能验证。
 *
 * 覆盖：
 *  A. 点击书签行的 ✎ 进入编辑态（渲染标题+地址两个输入框）
 *  B. 修改标题并保存 → 持久化生效
 *  C. 修改地址并保存 → 持久化生效，且收藏夹栏同步
 *  D. 取消 → 不改动原数据
 *  E. 地址改成别的书签已占用的地址 → 拒绝并提示
 *  F. 标题/地址为空 → 拒绝保存
 *  G. Esc 取消编辑
 *
 * 环境隔离：书签数据存在 localStorage，但 renderer.js 的 getBookmarks()
 * 有**模块级内存缓存 _bmRoot**，清 localStorage 不会立刻清掉它。
 * 所以每个场景用带时间戳的唯一 URL，避免与残留数据撞上。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };
  const stamp = Date.now();

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 750,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ROOT, 'preload.js'),
      webviewTag: true,
      sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1800);
  await wc.executeJavaScript("document.body.className = '';");
  await wait(200);

  const evalJs = (code) => wc.executeJavaScript(code);
  const step = async (name, code) => {
    try {
      const r = await wc.executeJavaScript(code);
      log.push([name, r === undefined ? '(undefined)' : String(r).slice(0, 80)]);
      return r;
    } catch (e) {
      log.push([name + ' [失败]', String(e && e.message).slice(0, 120)]);
      fails.push(name + ' 执行异常: ' + String(e && e.message).slice(0, 120));
      return null;
    }
  };

  // 打开收藏夹弹层（点收藏夹栏的「管理收藏夹」）
  const openPopover = async () => {
    await step('步骤1', `(() => { const m = document.querySelector('.bookmark.manage'); if (m) m.click(); })()`);
    await wait(400);
  };
  const isEditing = () =>
    evalJs(`!!document.querySelector('#bm-list .bm-edit-row')`);
  // 按 URL 找到书签行的 ✎ 并点击，进入编辑态。
  // 统一走这个辅助函数：弹层内容会随保存/取消重绘，
  // 每次操作前都要重新定位，否则会拿到已被替换掉的旧 DOM 引用。
  const enterEdit = async (url) => {
    const r = await step('进入编辑态', `
      (() => {
        const rows = Array.from(document.querySelectorAll('#bm-list .bm-row-bm'));
        for (const r of rows) {
          const main = r.querySelector('.bm-row-main');
          if (main && main.title === ${JSON.stringify(url)}) {
            const edit = r.querySelector('.bm-row-act:not(.bm-row-del)');
            if (!edit) return 'no-edit-btn';
            edit.click();
            return 'clicked';
          }
        }
        return 'row-not-found';
      })();
    `);
    await wait(350);
    return r;
  };
  const readBookmarks = () =>
    evalJs(`(function(){ try { return localStorage.getItem('mb_bookmarks') || ''; } catch(e){ return ''; } })()`);

  // ---------- A. 进入编辑态 ----------
  const URL_A = 'https://example.com/edit-a-' + stamp;
  await step('准备-清理历史残留', `
    (() => {
      // 清掉本脚本（以及早期调试脚本）留下的残留条目。
      // 判据用 URL 里的特征串，而不是标题 —— 标题会随编辑变化，
      // 早期调试还留下过 example.com/x-1 这类地址。
      // 注意 getBookmarks() 有模块级内存缓存 _bmRoot，
      // 改完 localStorage 必须重新 loadFile 才能让新页面读到。
      const raw = localStorage.getItem('mb_bookmarks');
      if (!raw) return 'no-data';
      const root = window.BookmarksIO.normalizeRoot(JSON.parse(raw));
      const before = root.children.length;
      root.children = root.children.filter((c) => {
        if (c.type !== 'bookmark') return true;
        const u = c.url || '';
        // 本脚本生成的：edit-a- / edit-e- / dbg
        if (/example\\.com\\/(edit-|dbg)/.test(u)) return false;
        // 早期调试脚本留下的：example.com/x-1
        if (/example\\.com\\/x-\\d+/.test(u)) return false;
        // 被误改成 https://www.example.com/ 的残留（上一轮 bug 的产物）
        if (u === 'https://www.example.com/') return false;
        // 标题被测试改过的条目
        if (c.title === '原始标题' || c.title === '改过的标题' ||
            c.title === '占位书签' || c.title === '不该被保存的标题' ||
            c.title === 'Esc取消的标题') return false;
        return true;
      });
      localStorage.setItem('mb_bookmarks', JSON.stringify(root));
      return 'cleaned ' + before + '->' + root.children.length;
    })();
  `);
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1500);
  await step('准备-注入书签', `
    (() => {
      const root = window.BookmarksIO.normalizeRoot(
        JSON.parse(localStorage.getItem('mb_bookmarks') || 'null') || undefined
      );
      root.children.push({ type: 'bookmark', title: '原始标题', url: ${JSON.stringify(URL_A)} });
      localStorage.setItem('mb_bookmarks', JSON.stringify(root));
      return 'injected';
    })();
  `);
  // 重新加载页面让 renderer 读到新数据（绕过 _bmRoot 内存缓存）
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1500);
  await openPopover();

  // 找到目标书签行的 ✎ 按钮并点击
  const clicked = await enterEdit(URL_A);
  log.push(['A 点击编辑按钮', clicked]);
  exp(clicked === 'clicked', '场景A：应能点到书签行的编辑按钮，实际 ' + clicked);
  log.push(['A 进入编辑态', await isEditing()]);
  exp(await isEditing(), '场景A：应渲染出编辑表单行');

  const fields = await step('步骤2', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return null;
      return {
        hasTitle: !!row.querySelector('.bm-edit-title'),
        hasUrl: !!row.querySelector('.bm-edit-url'),
        hasSave: !!row.querySelector('.bm-edit-save'),
        titleValue: row.querySelector('.bm-edit-title') ? row.querySelector('.bm-edit-title').value : null,
        urlValue: row.querySelector('.bm-edit-url') ? row.querySelector('.bm-edit-url').value : null,
      };
    })();
  `);
  log.push(['A 表单字段', JSON.stringify(fields)]);
  exp(fields && fields.hasTitle, '场景A：编辑表单应有标题输入框');
  exp(fields && fields.hasUrl, '场景A：编辑表单应有地址输入框');
  exp(fields && fields.hasSave, '场景A：编辑表单应有保存按钮');
  exp(fields && fields.titleValue === '原始标题', '场景A：标题输入框应预填原值');
  exp(fields && fields.urlValue === URL_A, '场景A：地址输入框应预填原值');

  // ---------- B. 修改标题并保存 ----------
  await step('步骤3', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      const t = row.querySelector('.bm-edit-title');
      t.value = '改过的标题';
      row.querySelector('.bm-edit-save').click();
    })();
  `);
  await wait(400);
  let raw = await readBookmarks();
  log.push(['B 保存后仍在编辑态?', await isEditing()]);
  exp(!(await isEditing()), '场景B：保存后应退出编辑态');
  exp(raw.indexOf('改过的标题') >= 0, '场景B：新标题应已持久化');
  exp(raw.indexOf('原始标题') < 0, '场景B：旧标题不应残留');
  log.push(['B 新标题已持久化', raw.indexOf('改过的标题') >= 0]);

  // ---------- C. 修改地址并保存 ----------
  const URL_C = 'https://example.com/edit-c-' + stamp;
  await openPopover();
  await enterEdit(URL_A);
  await step('步骤5', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      const u = row.querySelector('.bm-edit-url');
      u.value = ${JSON.stringify(URL_C)};
      row.querySelector('.bm-edit-save').click();
    })();
  `);
  await wait(400);
  raw = await readBookmarks();
  log.push(['C 新地址已持久化', raw.indexOf(URL_C) >= 0]);
  exp(raw.indexOf(URL_C) >= 0, '场景C：新地址应已持久化');
  exp(raw.indexOf(URL_A) < 0, '场景C：旧地址不应残留');
  // 收藏夹栏的条目也应同步（renderBookmarks）
  const barHasNew = await step('步骤6', `
    (() => {
      const bar = document.querySelector('.bookmarks-bar') || document.getElementById('bookmarks-bar');
      return bar ? bar.textContent.indexOf('改过的标题') >= 0 : false;
    })();
  `);
  log.push(['C 收藏夹栏已同步', barHasNew]);
  exp(barHasNew, '场景C：收藏夹栏应同步显示新标题');

  // ---------- D. 取消不改动数据 ----------
  await openPopover();
  await enterEdit(URL_C);
  await step('步骤8', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      row.querySelector('.bm-edit-title').value = '不该被保存的标题';
      const btns = Array.from(row.querySelectorAll('.bm-edit-btn'));
      const cancel = btns.find(b => b.textContent === '取消');
      cancel.click();
    })();
  `);
  await wait(400);
  raw = await readBookmarks();
  log.push(['D 取消后仍在编辑态?', await isEditing()]);
  exp(!(await isEditing()), '场景D：取消后应退出编辑态');
  exp(raw.indexOf('不该被保存的标题') < 0, '场景D：取消不应改动数据');
  log.push(['D 数据未被改动', raw.indexOf('不该被保存的标题') < 0]);

  // ---------- E. 地址重复应被拒绝 ----------
  const URL_E = 'https://example.com/edit-e-' + stamp;
  await step('步骤9', `
    (() => {
      const root = window.BookmarksIO.normalizeRoot(JSON.parse(localStorage.getItem('mb_bookmarks')));
      root.children.push({ type: 'bookmark', title: '占位书签', url: ${JSON.stringify(URL_E)} });
      localStorage.setItem('mb_bookmarks', JSON.stringify(root));
    })();
  `);
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1500);
  await openPopover();
  await enterEdit(URL_C);
  await step('步骤11', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      row.querySelector('.bm-edit-url').value = ${JSON.stringify(URL_E)};
      row.querySelector('.bm-edit-save').click();
    })();
  `);
  await wait(400);
  raw = await readBookmarks();
  const dupCount = (raw.match(new RegExp(URL_E.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  log.push(['E 重复地址出现次数', dupCount]);
  exp(dupCount === 1, '场景E：地址重复时应拒绝保存（出现次数应为 1），实际 ' + dupCount);
  log.push(['E 仍在编辑态（提示未保存）', await isEditing()]);
  exp(await isEditing(), '场景E：地址重复时应保持在编辑态让用户改');

  // ---------- F. 空值应被拒绝 ----------
  await step('步骤12', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      row.querySelector('.bm-edit-title').value = '';
      row.querySelector('.bm-edit-save').click();
    })();
  `);
  await wait(300);
  log.push(['F 空标题后仍在编辑态', await isEditing()]);
  exp(await isEditing(), '场景F：标题为空时应拒绝保存');
  await step('步骤13', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      row.querySelector('.bm-edit-title').value = '有标题';
      row.querySelector('.bm-edit-url').value = '';
      row.querySelector('.bm-edit-save').click();
    })();
  `);
  await wait(300);
  log.push(['F 空地址后仍在编辑态', await isEditing()]);
  exp(await isEditing(), '场景F：地址为空时应拒绝保存');

  // ---------- G. Esc 取消 ----------
  await step('步骤14', `
    (() => {
      const row = document.querySelector('#bm-list .bm-edit-row');
      if (!row) return 'no-edit-row';
      const t = row.querySelector('.bm-edit-title');
      t.value = 'Esc取消的标题';
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })();
  `);
  await wait(400);
  raw = await readBookmarks();
  log.push(['G Esc 后仍在编辑态?', await isEditing()]);
  exp(!(await isEditing()), '场景G：Esc 应退出编辑态');
  exp(raw.indexOf('Esc取消的标题') < 0, '场景G：Esc 不应保存改动');

  console.log('\n======== 书签编辑功能 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(26, ' ') + v));
  console.log('=======================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：编辑标题/地址、取消、重复地址拦截、空值拦截、Esc 均正常。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
