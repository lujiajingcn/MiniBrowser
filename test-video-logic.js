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

console.log('[4c] pickVideoAtPoint (右键穿透覆盖层命中视频)');
const rect = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
const V = (r, extra) => Object.assign({ rect: r, visible: true, paused: true, readyState: 4 }, extra || {});

eq('no videos -> -1', det.pickVideoAtPoint([], 10, 10), -1);
eq('null input -> -1', det.pickVideoAtPoint(null, 10, 10), -1);
// 单命中
eq('point inside -> index 0', det.pickVideoAtPoint([V(rect(0, 0, 300, 200))], 10, 10), 0);
// 点在框外
eq('point outside -> -1', det.pickVideoAtPoint([V(rect(0, 0, 300, 200))], 400, 10), -1);
// 边界包含
eq('point on edge -> hit', det.pickVideoAtPoint([V(rect(0, 0, 300, 200))], 300, 200), 0);
// 多个都命中：正在播放者优先（即使面积更大）
eq(
  'playing beats paused',
  det.pickVideoAtPoint(
    [V(rect(0, 0, 100, 100), { paused: true }), V(rect(0, 0, 300, 300), { paused: false })],
    10,
    10
  ),
  1
);
// 两个都在播：面积小的那个（更像真正的播放器，而非铺满页面的背景视频）优先
eq(
  'smaller area wins among playing',
  det.pickVideoAtPoint(
    [V(rect(0, 0, 800, 600), { paused: false }), V(rect(0, 0, 320, 240), { paused: false })],
    10,
    10
  ),
  1
);
// 面积同为 0（退化 rect）时按「谁都不命中」处理（尺寸过小被剔除）
eq('tiny video filtered out', det.pickVideoAtPoint([V(rect(0, 0, 4, 4))], 1, 1), -1);
// 同优先级同面积：DOM 靠后者优先（层级通常更高）
eq(
  'later DOM wins on tie',
  det.pickVideoAtPoint([V(rect(0, 0, 300, 200)), V(rect(0, 0, 300, 200))], 10, 10),
  1
);
// 不可见 / rect 缺失 被剔除
eq('invisible filtered', det.pickVideoAtPoint([V(rect(0, 0, 300, 200), { visible: false })], 10, 10), -1);
eq('null rect filtered', det.pickVideoAtPoint([{ rect: null, visible: true }], 10, 10), -1);
// readyState 不足（<2，还没拿到元数据）不算「正在播放」：两者同档，改由面积决定 → 小的那个
eq(
  'readyState<2 not treated as playing (area decides)',
  det.pickVideoAtPoint(
    [V(rect(0, 0, 800, 600), { paused: false, readyState: 1 }), V(rect(0, 0, 320, 240), { paused: true })],
    10,
    10
  ),
  1
);
// paused=false 且未提供 readyState 时按正在播放处理
eq(
  'playing when readyState unknown',
  det.pickVideoAtPoint(
    [V(rect(0, 0, 800, 600), { paused: false, readyState: undefined }), V(rect(0, 0, 320, 240), { paused: true })],
    10,
    10
  ),
  0
);
ok('MIN_VIDEO_EDGE exported', typeof det.MIN_VIDEO_EDGE === 'number' && det.MIN_VIDEO_EDGE > 0);

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
ok('has -user_agent (默认 UA)',
  a1.indexOf('-user_agent') >= 0 && a1[a1.indexOf('-user_agent') + 1] === 'Mozilla/5.0');
ok('无 descriptor 时不产生 -headers', a1.indexOf('-headers') === -1, JSON.stringify(a1));

// ★ 本轮修复的核心回归守卫：所有「输入选项」必须在 -i **之前**。
// ffmpeg 规则是「选项作用于其后第一次出现的文件」，放在 -i 之后会被当成输出选项而被
// 静默忽略——请求里既没有 Referer/Origin，UA 也仍是默认的 Lavf/xxx，于是被做防盗链校验的
// CDN 直接 403。（实测 allappy.com 的 playergo CDN：curl / node fetch 均 200，ffmpeg 403。）
ok('regression: -user_agent 在 -i 之前', a1.indexOf('-user_agent') < a1.indexOf('-i'),
  'uaIdx=' + a1.indexOf('-user_agent') + ' iIdx=' + a1.indexOf('-i'));

const a2 = ffmpeg.buildFfmpegArgs(
  'https://x.com/clip.mp4',
  '/out/v.mp4',
  { referer: 'https://x.com/', pageUrl: 'https://x.com/page', ua: 'MB-UA/9' },
  '127.0.0.1:7890'
);
ok('ua 取自 descriptor', a2[a2.indexOf('-user_agent') + 1] === 'MB-UA/9');
ok('referer header', a2.some((x) => /Referer: https:\/\/x\.com\//.test(x)));
// Referer / Origin 归一化为 origin 形式（与浏览器跨源 referrer policy 一致，不带路径）
ok('origin 归一化（不带路径）', a2.some((x) => /Origin: https:\/\/x\.com$/.test(x)), JSON.stringify(a2));
ok('referer 归一化（不带路径）', !a2.some((x) => /Referer: https:\/\/x\.com\/page/.test(x)));
ok('regression: -headers 在 -i 之前', a2.indexOf('-headers') < a2.indexOf('-i'),
  'iIdx=' + a2.indexOf('-i') + ' hIdx=' + a2.indexOf('-headers'));
ok('regression: -http_proxy 在 -i 之前', a2.indexOf('-http_proxy') < a2.indexOf('-i'),
  'pIdx=' + a2.indexOf('-http_proxy') + ' iIdx=' + a2.indexOf('-i'));
ok('http_proxy with scheme', a2.indexOf('-http_proxy') >= 0 && a2[a2.indexOf('-http_proxy') + 1] === 'http://127.0.0.1:7890');
// UA 走 -user_agent；不塞进 -headers（后者不覆盖默认 UA，会发出两个 User-Agent 头）
ok('UA 不再塞进 -headers', !a2.some((x) => /^User-Agent:/.test(x)), JSON.stringify(a2));

const a3 = ffmpeg.buildFfmpegArgs('https://x.com/c.mp4', '/out/v.mp4', null, 'https://proxy:3128');
ok('proxy already has scheme kept', a3[a3.indexOf('-http_proxy') + 1] === 'https://proxy:3128');

// ---- 统一产出 MP4 的加固项 ----
// aac_adtstoasc 只对 HLS/TS 的 ADTS-AAC 有意义；直链 mp4 硬加会让 ffmpeg 因音频不是
// AAC 而报错（webm→MP4 失败的常见原因），故仅 HLS 带
ok('hls has aac_adtstoasc', a1.indexOf('-bsf:a') >= 0 && a1[a1.indexOf('-bsf:a') + 1] === 'aac_adtstoasc');
ok('direct mp4: no aac_adtstoasc', a2.indexOf('-bsf:a') === -1);
// faststart：moov 前置；且 outPath 仍是最后一个参数（顺序回归守卫）
ok('has -movflags +faststart', a1.indexOf('-movflags') >= 0 && a1[a1.indexOf('-movflags') + 1] === '+faststart');
ok('direct mp4 has faststart', a2.indexOf('-movflags') >= 0);
ok('outPath still last after movflags', a1[a1.length - 1] === '/out/v.mp4');
// strict 放开：Opus / VP9 等封装进 MP4 属「实验性」
ok('has -strict -2', a1.indexOf('-strict') >= 0 && a1[a1.indexOf('-strict') + 1] === '-2');
// 重编码兜底路径（首次 -c copy 失败后由 video-download 触发）
const a4 = ffmpeg.buildFfmpegArgs('https://x.com/clip.webm', '/out/v.mp4', null, '', { reencode: true });
ok('reencode: libx264', a4.indexOf('-c:v') >= 0 && a4[a4.indexOf('-c:v') + 1] === 'libx264');
ok('reencode: aac', a4.indexOf('-c:a') >= 0 && a4[a4.indexOf('-c:a') + 1] === 'aac');
ok('reencode: no -c copy', a4[a4.indexOf('-c') + 1] !== 'copy');
ok('reencode: no aac_adtstoasc', a4.indexOf('-bsf:a') === -1);
// 兜底路径必须丢弃 MP4 容器放不下的附加流（字幕/数据流），否则一条字幕轨道会让整单失败
ok('reencode: -sn -dn 丢弃附加流', a4.indexOf('-sn') >= 0 && a4.indexOf('-dn') >= 0);
ok('reencode: outPath last', a4[a4.length - 1] === '/out/v.mp4');

console.log('[8] ffmpegCandidates (ffmpeg 路径发现)');
const wc = ffmpeg.ffmpegCandidates('win32');
const nc = ffmpeg.ffmpegCandidates('linux');
ok('win32: 包含 D:\\ffmpeg\\ffmpeg.exe', wc.indexOf('D:\\ffmpeg\\ffmpeg.exe') >= 0, JSON.stringify(wc));
ok('win32: 包含 D:\\ffmpeg\\bin\\ffmpeg.exe', wc.indexOf('D:\\ffmpeg\\bin\\ffmpeg.exe') >= 0);
ok('win32: 末尾是 PATH 兜底 ffmpeg', wc[wc.length - 1] === 'ffmpeg');
ok('linux: 包含 /usr/local/bin/ffmpeg', nc.indexOf('/usr/local/bin/ffmpeg') >= 0, JSON.stringify(nc));
ok('linux: 不含 Windows 路径', nc.every((p) => p.indexOf(':\\') === -1));
ok('无重复项', wc.length === new Set(wc).size);
ok('D:\\ffmpeg 在 bin 子目录之前（本机实测布局）', wc.indexOf('D:\\ffmpeg\\ffmpeg.exe') < wc.indexOf('D:\\ffmpeg\\bin\\ffmpeg.exe'));

console.log('[9] originOf (Referer/Origin 归一化)');
eq('带路径的 URL -> origin', ffmpeg.originOf('https://a.com/x/y?z=1'), 'https://a.com');
eq('保留端口', ffmpeg.originOf('http://a.com:8080/p'), 'http://a.com:8080');
eq('空值 -> 空串', ffmpeg.originOf(''), '');
eq('相对地址 -> 空串', ffmpeg.originOf('/foo/bar'), '');
eq('blob: 前缀 -> 内层 origin', ffmpeg.originOf('blob:https://a.com/uuid-1'), 'https://a.com');
eq('非法地址 -> 空串', ffmpeg.originOf('http://'), '');

console.log('[10] formatSeekTime (-ss 时间串格式化)');
eq('整秒', ffmpeg.formatSeekTime(0), '00:00:00.000');
eq('秒级', ffmpeg.formatSeekTime(75), '00:01:15.000');
eq('带毫秒', ffmpeg.formatSeekTime(90.5), '00:01:30.500');
eq('超过一小时', ffmpeg.formatSeekTime(3725.25), '01:02:05.250');
eq('负数归零', ffmpeg.formatSeekTime(-5), '00:00:00.000');
eq('非法输入归零', ffmpeg.formatSeekTime(NaN), '00:00:00.000');
ok('始终匹配 HH:MM:SS.mmm', /^\d{2,}:\d{2}:\d{2}\.\d{3}$/.test(ffmpeg.formatSeekTime(3661.007)));

console.log('[11] resumePointFrom (续传断点回退)');
eq('断点 0 -> 0', ffmpeg.resumePointFrom(0), 0);
eq('断点小于回退量 -> 0', ffmpeg.resumePointFrom(2), 0);
eq('正好等于回退量 -> 0', ffmpeg.resumePointFrom(ffmpeg.SEEK_OVERLAP), 0);
eq('正常断点回退 SEEK_OVERLAP', ffmpeg.resumePointFrom(100), 100 - ffmpeg.SEEK_OVERLAP);
ok('永远 <= 已下载秒数（不会越过已下内容）', ffmpeg.resumePointFrom(50) <= 50);
ok('非法输入 -> 0', ffmpeg.resumePointFrom(NaN) === 0);

console.log('[12] buildFfmpegArgs 的 startSeconds (暂停续传)');
const a5 = ffmpeg.buildFfmpegArgs('https://x.com/live.m3u8', '/out/v.mp4', null, '', { startSeconds: 0 });
ok('startSeconds=0 不加 -ss', a5.indexOf('-ss') === -1, JSON.stringify(a5));
const a6 = ffmpeg.buildFfmpegArgs('https://x.com/live.m3u8', '/out/v2.mp4', null, '', { startSeconds: 97.5 });
ok('startSeconds>0 加 -ss', a6.indexOf('-ss') >= 0);
eq('-ss 的值', a6[a6.indexOf('-ss') + 1], '00:01:37.500');
// ★ 回归守卫：-ss 必须在 -i **之前**（输入侧 seek）。
// 放在 -i 之后会变成输出 seek：前面被跳过的内容照样写进输出，等于没跳过，
// 而且会让每个分段文件都从 0 开始——concat 后内容重复。
ok('regression: -ss 在 -i 之前', a6.indexOf('-ss') < a6.indexOf('-i'),
  'ssIdx=' + a6.indexOf('-ss') + ' iIdx=' + a6.indexOf('-i'));
ok('regression: -ss 仍在 -user_agent 之后（都是输入选项）',
  a6.indexOf('-ss') > a6.indexOf('-user_agent'));
ok('startSeconds + reencode 同时生效',
  (() => {
    const a = ffmpeg.buildFfmpegArgs('https://x.com/c.webm', '/out/v.mp4', null, '', { reencode: true, startSeconds: 30 });
    return a.indexOf('-ss') < a.indexOf('-i') && a[a.indexOf('-c:v') + 1] === 'libx264';
  })());

console.log('[13] buildConcatArgs (分段拼接)');
eq('空分段抛错', (() => {
  try { ffmpeg.buildConcatArgs([], '/out/v.mp4'); return 'no-throw'; } catch (e) { return 'throw'; }
})(), 'throw');

const c1 = ffmpeg.buildConcatArgs(['/out/v.part-1.mp4', '/out/v.part-2.mp4'], '/out/v.mp4');
// 用 concat filter（-filter_complex），不是 concat demuxer。
// demuxer + -c copy 实测有两个绕不过去的问题：inpoint 对最后一段不生效、
// 以及交界处反复报 non-monotonical DTS。
ok('用 filter_complex', c1.args.indexOf('-filter_complex') >= 0, JSON.stringify(c1.args));
ok('不再用 concat demuxer', c1.args.indexOf('-f') === -1 || c1.args[c1.args.indexOf('-f') + 1] !== 'concat');
ok('不再往 stdin 写清单', c1.listFile === '', JSON.stringify(c1.listFile));
ok('无 -c copy（filter 必须解码）', c1.args.indexOf('-c') === -1 || c1.args[c1.args.indexOf('-c') + 1] !== 'copy');
ok('统一重编码为 libx264', c1.args[c1.args.indexOf('-c:v') + 1] === 'libx264');
ok('音频转 aac', c1.args[c1.args.indexOf('-c:a') + 1] === 'aac');
// 两个分段 = 两个 -i
eq('-i 数量=分段数', c1.args.filter((x, i) => x === '-i').length, 2);
ok('第 1 个输入是首段', c1.args[c1.args.indexOf('-i') + 1] === '/out/v.part-1.mp4');
ok('第 2 个输入是末段',
  c1.args[c1.args.indexOf('-i', c1.args.indexOf('-i') + 1) + 1] === '/out/v.part-2.mp4');
const fc = c1.args[c1.args.indexOf('-filter_complex') + 1];
ok('concat 节点按分段数声明 n', /concat=n=2:v=1:a=1/.test(fc), fc);
ok('成品是最后一个参数', c1.args[c1.args.length - 1] === '/out/v.mp4');
ok('丢弃附加流', c1.args.indexOf('-sn') >= 0 && c1.args.indexOf('-dn') >= 0);

// ★ 回归守卫：分段交界处故意重叠（关键帧对齐需要），拼接必须 trim 裁掉，
// 否则成品时长一段段虚长（实测 60s 源拼成 63s），重复的画面/声音也一起进去。
const c4 = ffmpeg.buildConcatArgs(
  [{ path: '/out/v.part-0.mp4', trimHead: 0 }, { path: '/out/v.part-1.mp4', trimHead: 17.34 }],
  '/out/v.mp4'
);
const fc4 = c4.args[c4.args.indexOf('-filter_complex') + 1];
ok('首段不裁（trim 从 0 起）', /\[0:v\]trim=start=0,/.test(fc4), fc4);
ok('非首段按 trimHead 裁视频', /\[1:v\]trim=start=17\.340,/.test(fc4), fc4);
ok('非首段按 trimHead 裁音频', /\[1:a\]atrim=start=17\.340,/.test(fc4), fc4);
// 每段都归零时间戳（concat filter 要求各段从 0 开始）
// 注意用 \b 词边界：setpts 是 asetpts 的子串，不加边界会把音频的也算进视频。
ok('每段视频都归零时间戳',
  (fc4.match(/\bsetpts=PTS-STARTPTS/g) || []).length === 2, fc4);
ok('每段音频都归零时间戳',
  (fc4.match(/\basetpts=PTS-STARTPTS/g) || []).length === 2, fc4);
// 字符串形式（无 trimHead）应兼容，且全从 0 起
const c5 = ffmpeg.buildConcatArgs(['/out/a.mp4', '/out/b.mp4'], '/out/v.mp4');
const fc5 = c5.args[c5.args.indexOf('-filter_complex') + 1];
ok('字符串形式向后兼容（都不裁）',
  /\[0:v\]trim=start=0,/.test(fc5) && /\[1:v\]trim=start=0,/.test(fc5), fc5);
// 路径含单引号/空格（Windows 允许）不能破坏 filter graph
const c2 = ffmpeg.buildConcatArgs(["C://out//it's v.mp4"], 'C://out//v.mp4');
ok('含单引号与反斜杠的路径原样传入 -i',
  c2.args[c2.args.indexOf('-i') + 1] === "C://out//it's v.mp4",
  JSON.stringify(c2.args.slice(0, 4)));

console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail === 0 ? 0 : 1);
