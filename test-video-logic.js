'use strict';

// 纯 Node 单元测试：覆盖视频探测 / ffmpeg 构造的纯逻辑（不依赖 electron，秒级、稳定）。
// 运行：node test-video-logic.js

const det = require('./video-detect');
const ffmpeg = require('./video-ffmpeg');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(name, g === w, 'got=' + g + ' want=' + w);
}

console.log('[1] classifyVideoUrl');
eq('m3u8 -> hls', det.classifyVideoUrl('https://x.com/a/b/master.m3u8'), 'hls');
eq('m3u8 with query -> hls', det.classifyVideoUrl('https://x.com/a.m3u8?token=1'), 'hls');
eq('.mp4 -> mp4', det.classifyVideoUrl('https://x.com/clip.mp4'), 'mp4');
eq('.m4v -> mp4', det.classifyVideoUrl('https://x.com/clip.m4v'), 'mp4');
eq('.mp4?x=1 -> mp4', det.classifyVideoUrl('https://x.com/clip.mp4?a=b'), 'mp4');
eq('webm -> other', det.classifyVideoUrl('https://x.com/clip.webm'), 'other');
eq('empty -> other', det.classifyVideoUrl(''), 'other');

console.log('[2] normalizeUrl');
eq('absolute passthrough', det.normalizeUrl('https://x.com/a.mp4', 'https://base.com/'), 'https://x.com/a.mp4');
eq('relative resolved', det.normalizeUrl('/path/clip.mp4', 'https://base.com/page'), 'https://base.com/path/clip.mp4');
// 注意：'not a url' 这类会被当作相对路径解析成 base + 编码串（符合 URL 规范，不抛错）。
// 真正抛错的输入（如缺少主机的 'http://'）才走 catch 返回原值。
eq('throws -> original', det.normalizeUrl('http://', 'https://base.com/'), 'http://');

console.log('[3] collectVideoSources');
// 直链 mp4（currentSrc 为绝对地址）
eq(
  'direct mp4',
  det.collectVideoSources({ src: 'https://x.com/clip.mp4', currentSrc: 'https://x.com/clip.mp4', sources: [] }, [], 'https://x.com/'),
  [{ url: 'https://x.com/clip.mp4', kind: 'mp4' }]
);
// blob currentSrc 被跳过，但 <source> 提供 mp4
eq(
  'blob currentSrc skipped, source used',
  det.collectVideoSources({ src: '', currentSrc: 'blob:https://x.com/abc', sources: ['/s/clip.mp4'] }, [], 'https://x.com/'),
  [{ url: 'https://x.com/s/clip.mp4', kind: 'mp4' }]
);
// HLS：video.src 直链 .m3u8
eq(
  'hls direct',
  det.collectVideoSources({ src: 'https://x.com/live.m3u8', currentSrc: 'https://x.com/live.m3u8', sources: [] }, [], 'https://x.com/'),
  [{ url: 'https://x.com/live.m3u8', kind: 'hls' }]
);
// 多源去重：src 与 source 指向同一地址只保留一个
eq(
  'dedup same url',
  det.collectVideoSources({ src: '/clip.mp4', currentSrc: '/clip.mp4', sources: ['/clip.mp4'] }, [], 'https://x.com/'),
  [{ url: 'https://x.com/clip.mp4', kind: 'mp4' }]
);
// 页面级捕获的 m3u8 合并进来（HLS 经 MediaSource，video 无直链）
eq(
  'merge captured m3u8',
  det.collectVideoSources({ src: '', currentSrc: 'blob:x', sources: [] }, ['https://cdn.com/h/master.m3u8'], 'https://x.com/'),
  [{ url: 'https://cdn.com/h/master.m3u8', kind: 'hls' }]
);
// 多源不同地址都保留
eq(
  'multiple distinct',
  det.collectVideoSources(
    { src: '/a.mp4', currentSrc: '/a.mp4', sources: ['/b.mp4'] },
    [],
    'https://x.com/'
  ),
  [
    { url: 'https://x.com/a.mp4', kind: 'mp4' },
    { url: 'https://x.com/b.mp4', kind: 'mp4' }
  ]
);

console.log('[4] findVideoInPath');
eq('finds VIDEO in path', !!det.findVideoInPath([{ nodeType: 1, tagName: 'DIV' }, { nodeType: 1, tagName: 'VIDEO' }]), true);
eq('null when absent', det.findVideoInPath([{ nodeType: 1, tagName: 'DIV' }]), null);
eq('null on empty', det.findVideoInPath([]), null);
eq('ignores non-element', det.findVideoInPath([{ nodeType: 3, tagName: '#text' }]), null);

console.log('[4b] shouldAttachPageM3u8 (HLS 兜底判定)');
eq('empty src -> attach (conservative)', det.shouldAttachPageM3u8('', ''), true);
eq('m3u8 src -> no attach (own src suffices)', det.shouldAttachPageM3u8('https://x.com/live.m3u8', ''), false);
eq('blob currentSrc -> attach (MediaSource HLS)', det.shouldAttachPageM3u8('blob:https://x.com/abc', ''), true);
eq('loaded mp4 currentSrc -> no attach', det.shouldAttachPageM3u8('https://x.com/clip.mp4', ''), false);
eq('loaded mp4 src -> no attach', det.shouldAttachPageM3u8('', 'https://x.com/clip.mp4'), false);
eq('webm currentSrc -> no attach', det.shouldAttachPageM3u8('https://x.com/c.webm', ''), false);

console.log('[5] safeBaseName (filename sanitize)');
eq('strip illegal chars', ffmpeg.safeBaseName('a/b:c*?', 'fall'), 'a_b_c_');
eq('fallback when empty', ffmpeg.safeBaseName('   ', 'vid'), 'vid');
eq('truncate to 80', ffmpeg.safeBaseName('x'.repeat(200), 'v'), 'x'.repeat(80));
eq('keeps normal', ffmpeg.safeBaseName('My Clip 01', 'v'), 'My Clip 01');

console.log('[6] parseProxyResult');
eq('PROXY host:port', ffmpeg.parseProxyResult('PROXY 127.0.0.1:7890'), '127.0.0.1:7890');
eq('PROXY with spaces', ffmpeg.parseProxyResult('  PROXY proxy.example.com:8080  '), 'proxy.example.com:8080');
eq('DIRECT -> empty', ffmpeg.parseProxyResult('DIRECT'), '');
eq('empty -> empty', ffmpeg.parseProxyResult(''), '');

console.log('[7] buildFfmpegArgs');
const a1 = ffmpeg.buildFfmpegArgs('https://x.com/live.m3u8', '/out/v.mp4', null, '');
ok('has -i url', a1.indexOf('-i') >= 0 && a1[a1.indexOf('-i') + 1] === 'https://x.com/live.m3u8');
ok('has -c copy', a1.indexOf('-c') >= 0 && a1[a1.indexOf('-c') + 1] === 'copy');
ok('has -bsf:a aac_adtstoasc', a1.indexOf('-bsf:a') >= 0 && a1[a1.indexOf('-bsf:a') + 1] === 'aac_adtstoasc');
ok('ends with outPath', a1[a1.length - 1] === '/out/v.mp4');
ok('no -http_proxy when no proxy', a1.indexOf('-http_proxy') === -1);
ok('default UA present', a1.some((x) => /User-Agent: Mozilla\/5.0/.test(x)));
// 回归守卫：-headers 必须位于 -i 之后，否则 ffmpeg 报 "Option headers not found" 并退出
ok('regression: -headers after -i', a1.indexOf('-headers') > a1.indexOf('-i'),
  'iIdx=' + a1.indexOf('-i') + ' hIdx=' + a1.indexOf('-headers'));

const a2 = ffmpeg.buildFfmpegArgs(
  'https://x.com/clip.mp4',
  '/out/v.mp4',
  { referer: 'https://x.com/', pageUrl: 'https://x.com/page' },
  '127.0.0.1:7890'
);
ok('referer header', a2.some((x) => /Referer: https:\/\/x\.com\//.test(x)));
ok('origin header', a2.some((x) => /Origin: https:\/\/x\.com\/page/.test(x)));
ok('http_proxy with scheme', a2.indexOf('-http_proxy') >= 0 && a2[a2.indexOf('-http_proxy') + 1] === 'http://127.0.0.1:7890');

const a3 = ffmpeg.buildFfmpegArgs('https://x.com/c.mp4', '/out/v.mp4', null, 'https://proxy:3128');
ok('proxy already has scheme kept', a3[a3.indexOf('-http_proxy') + 1] === 'https://proxy:3128');

console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail === 0 ? 0 : 1);
