'use strict';

/**
 * 文件夹新建/重命名与面包屑层级验证。
 *
 * A. 点「新建文件夹」应出现行内输入框（Electron 不支持 window.prompt），
 *    回车保存后书签树里多一个文件夹。
 * B. 进入子文件夹再建一层，面包屑应显示「全部书签 › 父 › 子」（此前 path 恒空）。
 * C. 点文件夹的 ✎ 应出现预填旧名的输入框，改名后生效。
 *
 * 使用独立 userData，避免污染真实 profile。
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'minibrowser-diag-folder-' + process.pid));

const ROOT = __dirname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const log = [];
  const exp = (c, m) => { if (!c) fails.push(m); };

  const win = new BrowserWindow({
    show: false, width: 1100, height: 750,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(ROOT, 'preload.js'), webviewTag: true, sandbox: false,
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'index.html'));
  await wait(1800);
  await wc.executeJavaScript("localStorage.removeItem('mb_bookmarks');");
  await wc.reload();
  await wait(1800);

  // ---- A：新建文件夹 ----
  const created = JSON.parse(await wc.executeJavaScript(`
    (() => {
      openBookmarksPopover(getBookmarks());
      document.getElementById('bm-new-folder').click();
      const input = document.querySelector('#bm-list .bm-edit-title');
      const appeared = !!input;
      if (input) {
        input.value = '测试文件夹';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      const folders = getBookmarks().children.filter(n => n.type === 'folder');
      return JSON.stringify({ appeared, names: folders.map(n => n.title) });
    })();
  `));
  log.push(['A 新建文件夹', JSON.stringify(created)]);
  exp(created.appeared, 'A：点新建文件夹应出现行内输入框，而不是抛 prompt() 异常');
  exp(created.names.includes('测试文件夹'), 'A：回车保存后应新增文件夹');

  // ---- B：子文件夹与面包屑 ----
  const crumbs = JSON.parse(await wc.executeJavaScript(`
    (() => {
      const root = getBookmarks();
      const parent = root.children.find(n => n.title === '测试文件夹');
      openBookmarksPopover(parent);
      document.getElementById('bm-new-folder').click();
      const input = document.querySelector('#bm-list .bm-edit-title');
      if (input) {
        input.value = '子文件夹';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      const child = parent.children.find(n => n.type === 'folder');
      openBookmarksPopover(child);
      return JSON.stringify({
        crumbs: Array.from(document.querySelectorAll('#bm-crumbs .bm-crumb')).map(e => e.textContent),
        childName: child && child.title
      });
    })();
  `));
  log.push(['B 面包屑', JSON.stringify(crumbs)]);
  exp(crumbs.childName === '子文件夹', 'B：子文件夹应创建成功');
  exp(crumbs.crumbs.length === 3 && crumbs.crumbs[1] === '测试文件夹' &&
      crumbs.crumbs[2] === '子文件夹',
    'B：面包屑应显示三级路径，实际 ' + JSON.stringify(crumbs.crumbs));

  // ---- C：重命名 ----
  const renamed = JSON.parse(await wc.executeJavaScript(`
    (() => {
      const root = getBookmarks();
      const parent = root.children.find(n => n.title === '测试文件夹');
      openBookmarksPopover(parent);
      const rows = Array.from(document.querySelectorAll('#bm-list .bm-row-folder'));
      const row = rows.find(r => (r.querySelector('.bm-row-main') || {}).textContent === '📁 子文件夹');
      if (!row) return JSON.stringify({ foundRow: false });
      const act = row.querySelector('.bm-row-act');
      if (!act) return JSON.stringify({ foundRow: true, foundAct: false });
      act.click();
      const input = document.querySelector('#bm-list .bm-edit-title');
      const prefilled = input && input.value;
      if (input) {
        input.value = '改名后的文件夹';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      return JSON.stringify({
        foundRow: true, foundAct: true, prefilled,
        titles: parent.children.filter(n => n.type === 'folder').map(n => n.title)
      });
    })();
  `));
  log.push(['C 重命名', JSON.stringify(renamed)]);
  exp(renamed.foundRow && renamed.foundAct, 'C：文件夹行应有重命名按钮');
  exp(renamed.prefilled === '子文件夹', 'C：输入框应预填旧名，实际 ' + renamed.prefilled);
  exp(renamed.titles && renamed.titles.includes('改名后的文件夹'), 'C：重命名应写入书签树');

  console.log('\n======== 文件夹编辑与面包屑 验证 ========');
  log.forEach(([k, v]) => console.log('  ' + String(k).padEnd(20, ' ') + v));
  console.log('============================================');
  if (fails.length) {
    console.error('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  X ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n全部通过：行内新建/重命名与面包屑层级均正常。');
  }
  app.quit();
}).catch((e) => { console.error(e && e.stack); app.quit(); });
