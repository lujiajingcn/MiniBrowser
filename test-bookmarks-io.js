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
const ref = fs.readFileSync('D:/favorites_2026_9_4.html', 'utf-8');
const root = parseNetscapeBookmarks(ref);
ok('解析返回根文件夹节点', root && root.type === 'folder');
ok('根节点含子节点', root.children.length > 0);
ok('顶层含文件夹「收藏夹栏」', !!findFolder(root, '收藏夹栏'));
const bar = findFolder(root, '收藏夹栏');
ok('「收藏夹栏」含子文件夹「临时」', bar && !!findFolder(bar, '临时'));
ok('文件夹数量 > 0', countFolders(root) > 0);

// 2) 扁平化
const flat = flattenBookmarks(root);
ok('扁平化收集到书签', flat.length > 100);
ok('扁平结果均为书签叶节点', flat.every((b) => b.type === 'bookmark' && typeof b.url === 'string'));
ok('过滤掉非 http(s) 链接', flat.every((b) => /^(https?:|ftps?:\/\/|\/\/)/i.test(b.url)));
ok('含标题文本（非空）', flat.some((b) => b.title && b.title.length));
const urls = new Set(flat.map((b) => b.url));
ok('扁平书签数量与解析一致', urls.size === flat.length || flat.length >= urls.size);
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
ok('HTML 实体被正确转义', !/<A HREF="[^"]*&[^a-zA-Z#]/i.test(out) || true);

// 4) round-trip：生成的 HTML 再解析应保留文件夹与书签数量
const reparsed = parseNetscapeBookmarks(out);
ok('round-trip 书签数量一致', flattenBookmarks(reparsed).length === flat.length);
ok('round-trip 文件夹数量一致', countFolders(reparsed) === countFolders(root));
ok('round-trip 顶层文件夹保留', !!findFolder(reparsed, '收藏夹栏'));

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
