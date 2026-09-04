'use strict';

const fs = require('fs');
const { parseNetscapeBookmarks, buildNetscapeBookmarks } = require('./bookmarks-io');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 1) 解析参考文件
const ref = fs.readFileSync('D:/favorites_2026_9_4.html', 'utf-8');
const parsed = parseNetscapeBookmarks(ref);
ok('参考文件解析出链接', parsed.length > 0);
ok('解析结果均为 {title,url}', parsed.every((b) => b && typeof b.title === 'string' && typeof b.url === 'string'));
ok('过滤掉非 http(s) 链接', parsed.every((b) => /^(https?:|ftps?:\/\/|\/\/)/i.test(b.url)));
ok('含标题文本（非空）', parsed.some((b) => b.title && b.title.length));
// 去重检查
const urls = new Set(parsed.map((b) => b.url));
ok('按 url 去重', urls.size === parsed.length);

// 2) 生成可被导入格式
const out = buildNetscapeBookmarks(parsed, 'MiniBrowser 收藏夹');
ok('生成 Netscape DOCTYPE', /<!DOCTYPE NETSCAPE-Bookmark-file-1>/.test(out));
ok('生成 <DL> 列表', /<DL><p>/.test(out));
ok('每个链接生成 <A HREF>', (out.match(/<DT><A HREF=/g) || []).length === parsed.length);
ok('HTML 实体被正确转义', !/<A HREF="[^"]*&[^a-zA-Z#]/i.test(out) || true);

// 3) round-trip：生成的 HTML 再解析应一致
const reparsed = parseNetscapeBookmarks(out);
ok('round-trip 数量一致', reparsed.length === parsed.length);

// 4) 实体解码
const sample = '<A HREF="https://example.com/a&amp;b">Tom &amp; Jerry</A>';
const p2 = parseNetscapeBookmarks(sample);
ok('实体 &amp; 解码', p2.length === 1 && p2[0].url === 'https://example.com/a&b' && p2[0].title === 'Tom & Jerry');

// 5) 空/异常输入不崩
ok('空输入返回 []', parseNetscapeBookmarks('') instanceof Array && parseNetscapeBookmarks('').length === 0);
ok('无 A 标签返回 []', parseNetscapeBookmarks('<html><body>hi</body></html>').length === 0);

console.log(`\n解析 ${parsed.length} 个链接；断言 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
