'use strict';

const fs = require('fs');
const {
  parseNetscapeBookmarks,
  buildNetscapeBookmarks,
  flattenBookmarks,
  findBookmarkByUrl,
  removeBookmarkByUrl,
  countFolders,
  normalizeRoot
} = require('./bookmarks-io');

let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name);
  }
}

function findFolder(node, title) {
  for (const c of node.children || []) {
    if (c.type === 'folder' && c.title === title) return c;
    if (c.type === 'folder') {
      const f = findFolder(c, title);
      if (f) return f;
    }
  }
  return null;
}

// 1) 解析参考文件（含嵌套文件夹）
//
// 参考文件是本机导出的真实书签，路径随机器而异：
// D:/favorites_2026_9_4.html 是 2026-09-04 那次导出的位置。
// 文件不在时**退回内嵌样例**（而不是整个脚本报错退出 ——
// 那会让 CI/别的机器上根本跑不了这个测试）。内嵌样例保留了
// 「嵌套文件夹 + 多条书签 + 实体转义」这些结构性特征，足够覆盖解析逻辑。
const REF_PATH = process.env.MB_BOOKMARKS_REF || 'D:/favorites_2026_9_4.html';
const hasRef = fs.existsSync(REF_PATH);
if (!hasRef) {
  console.log('  · 未找到参考文件 ' + REF_PATH + '，改用内嵌样例');
  console.log('    设置 MB_BOOKMARKS_REF=<路径> 可改用真实书签');
}
const EMBEDDED_REF = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" LAST_MODIFIED="1">收藏夹栏</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1" LAST_MODIFIED="1">临时</H3>
        <DL><p>
            <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1">A &amp; B</A>
            <DT><A HREF="https://github.com/owner/repo" ADD_DATE="1" ICON="https://github.com/favicon.ico">repo</A>
            <DT><A HREF="https://example.com/data" ADD_DATE="1" ICON="data:image/png;base64,AAAABBBB">data-icon</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://zhihu.com/" ADD_DATE="1">知乎</A>
</DL><p>
`;
const ref = hasRef ? fs.readFileSync(REF_PATH, 'utf-8') : EMBEDDED_REF;
const root = parseNetscapeBookmarks(ref);
if (hasRef) {
  ok('解析返回根文件夹节点', root && root.type === 'folder');
  ok('根节点含子节点', root.children.length > 0);
  ok('顶层含文件夹「收藏夹栏」', !!findFolder(root, '收藏夹栏'));
  const bar = findFolder(root, '收藏夹栏');
  ok('「收藏夹栏」含子文件夹「临时」', bar && !!findFolder(bar, '临时'));
  ok('文件夹数量 > 0', countFolders(root) > 0);
}

// 2) 扁平化
const flat = flattenBookmarks(root);
ok('扁平化收集到书签', flat.length >= (hasRef ? 100 : 3));
ok('扁平结果均为书签叶节点', flat.every((b) => b.type === 'bookmark' && typeof b.url === 'string'));
ok('过滤掉非 http(s) 链接', flat.every((b) => /^(https?:|ftps?:\/\/|\/\/)/i.test(b.url)));
ok('含标题文本（非空）', flat.some((b) => b.title && b.title.length));
const urls = new Set(flat.map((b) => b.url));
// 旧断言 `urls.size === flat.length || flat.length >= urls.size` 右支由 Set 定义保证恒真，
// 永远通过。改为与树中书签总数对比，才能真正抓到漏收集/重复收集。
function countBookmarks(node) {
  return (node.children || []).reduce(
    (n, c) => n + (c.type === 'bookmark' ? 1 : countBookmarks(c)), 0);
}
ok('扁平书签数量与树中书签数一致', flat.length === countBookmarks(root));
// 树模型允许同一地址出现在不同文件夹（与 Chrome/Edge 一致），但「同一文件夹内」按 url 去重
function intraFolderUnique(node) {
  const seen = new Set();
  for (const c of node.children || []) {
    if (c.type === 'bookmark') {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
    } else if (!intraFolderUnique(c)) {
      return false;
    }
  }
  return true;
}
ok('同一文件夹内按 url 去重', intraFolderUnique(root));

// 3) 生成可被导入格式
const out = buildNetscapeBookmarks(root, 'MiniBrowser 收藏夹');
ok('生成 Netscape DOCTYPE', /<!DOCTYPE NETSCAPE-Bookmark-file-1>/.test(out));
ok('生成 <DL> 列表', /<DL><p>/.test(out));
ok('每个书签生成 <A HREF>', (out.match(/<DT><A HREF=/g) || []).length === flat.length);
ok('文件夹生成 <DT><H3>', (out.match(/<DT><H3/g) || []).length === countFolders(root));
ok('HTML 实体被正确转义', !/<A HREF="[^"]*&[^a-zA-Z#]/i.test(out));

// 4) round-trip：生成的 HTML 再解析应保留文件夹与书签数量
const reparsed = parseNetscapeBookmarks(out);
ok('round-trip 书签数量一致', flattenBookmarks(reparsed).length === flat.length);
ok('round-trip 文件夹数量一致', countFolders(reparsed) === countFolders(root));
ok('round-trip 顶层文件夹保留', hasRef ? !!findFolder(reparsed, '收藏夹栏')
  : !!findFolder(reparsed, '收藏夹栏'));

// ---------- 5) 书签图标（ICON 属性） ----------
{
  const flat2 = flattenBookmarks(root);
  const withIcon = flat2.find((b) => b.url === 'https://github.com/owner/repo');
  ok('带 ICON 的书签解析出 icon', withIcon && withIcon.icon === 'https://github.com/favicon.ico',
    JSON.stringify(withIcon && withIcon.icon));

  const dataIcon = flat2.find((b) => b.url === 'https://example.com/data');
  ok('data: URI 的图标被丢弃（太占 localStorage 空间）',
    !dataIcon || !dataIcon.icon, JSON.stringify(dataIcon && dataIcon.icon));

  const noIcon = flat2.find((b) => b.url === 'https://zhihu.com/');
  ok('没有 ICON 属性的书签不带 icon 字段',
    !noIcon || noIcon.icon === undefined || noIcon.icon === '',
    JSON.stringify(noIcon && noIcon.icon));

  // 导出时应带上 ICON 属性
  const out2 = buildNetscapeBookmarks(root, 'Bookmarks');
  ok('导出包含 ICON 属性', (out2.split('\n').find((l) => l.indexOf('github.com/owner/repo') >= 0) || '').indexOf('ICON="https://github.com/favicon.ico"') >= 0,
    out2.split('\n').filter((l) => l.indexOf('github.com/owner/repo') >= 0).join(' | '));
  ok('导出不包含 data: URI 图标', out2.indexOf('ICON="data:') < 0);

  // round-trip：图标应当被保留
  const re2 = parseNetscapeBookmarks(out2);
  const rtIcon = flattenBookmarks(re2).find((b) => b.url === 'https://github.com/owner/repo');
  ok('round-trip 后图标仍在', rtIcon && rtIcon.icon === 'https://github.com/favicon.ico',
    JSON.stringify(rtIcon && rtIcon.icon));
}

// 5) 实体解码
const sample = '<A HREF="https://example.com/a&amp;b">Tom &amp; Jerry</A>';
const p2 = parseNetscapeBookmarks(sample);
ok('实体 &amp; 解码', p2.children.length === 1 && p2.children[0].url === 'https://example.com/a&b' && p2.children[0].title === 'Tom & Jerry');

// 6) 树操作纯函数
const tree = { type: 'folder', title: '', children: [{ type: 'bookmark', title: 'A', url: 'https://a.com' }] };
ok('findBookmarkByUrl 命中', findBookmarkByUrl(tree, 'https://a.com') !== null);
ok('findBookmarkByUrl 未命中返回 null', findBookmarkByUrl(tree, 'https://x.com') === null);
ok('removeBookmarkByUrl 删除成功', removeBookmarkByUrl(tree, 'https://a.com') === true && flattenBookmarks(tree).length === 0);
ok('removeBookmarkByUrl 未命中返回 false', removeBookmarkByUrl(tree, 'https://x.com') === false);

// 7) normalizeRoot 兼容旧 flat 数组与异常输入
const migrated = normalizeRoot([{ title: 'X', url: 'https://x.com' }]);
ok('旧 flat 数组迁移为根文件夹子节点', migrated.type === 'folder' && migrated.children.length === 1 && migrated.children[0].type === 'bookmark');
ok('非对象规整为空根', normalizeRoot(null).type === 'folder' && normalizeRoot(null).children.length === 0);
ok('已是文件夹节点原样返回', normalizeRoot(root) === root);

// 8) 空/异常输入不崩
ok('空输入返回根文件夹', parseNetscapeBookmarks('').type === 'folder');
ok('无 A 标签返回空根', parseNetscapeBookmarks('<html><body>hi</body></html>').children.length === 0);

console.log(`\n解析 ${flat.length} 个书签 / ${countFolders(root)} 个文件夹；断言 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
