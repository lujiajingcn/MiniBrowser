'use strict';

/**
 * 视频下载（ffmpeg 调用）纯逻辑：不依赖 electron，可在 Node 中直接单测。
 * video-download.js 负责 electron / 子进程 / IPC 的部分，并引用本模块的纯函数。
 */

// 文件名安全化：去掉 Windows / 大多数文件系统不允许的字符，截断到合理长度
function safeBaseName(title, fallback) {
  let base = (title || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80);
  if (!base) base = fallback || 'video';
  return base;
}

// 从 session.resolveProxy 的结果里提取代理地址：
// 形如 "PROXY host:port" 时返回 "host:port"，其它（DIRECT / 空）返回 ''
function parseProxyResult(resolved) {
  if (!resolved) return '';
  const m = /^\s*PROXY\s+(.+)$/i.exec(resolved);
  return m ? m[1].trim() : '';
}

// 给代理补上 http:// 前缀（ffmpeg -http_proxy 需要完整 scheme）
function withScheme(proxy) {
  return /^https?:\/\//i.test(proxy) ? proxy : 'http://' + proxy;
}

// 提取 URL 的「源」（scheme://host[:port]）。非法 / 空值返回 ''（调用方据此跳过 Referer/Origin）。
function originOf(u) {
  if (!u) return '';
  try {
    const o = new URL(u).origin;
    return o && o !== 'null' ? o : '';
  } catch (_) {
    return '';
  }
}

/**
 * 构造 ffmpeg 参数：所有视频统一产出 MP4（默认 -c copy 无损且快）。
 *
 * 【顺序很重要】-user_agent / -headers / -http_proxy 等「输入选项」一律放在 -i <url> 之前；
 * 放到 -i 之后会被 ffmpeg 当作输出文件的选项而**静默丢弃**（不报错，但请求里没有这些头），
 * 导致带防盗链校验的站点 403。参见下方 buildFfmpegArgs 内的注释与单测 [9]。
 *
 * @param {string} url       视频源地址（直链 mp4 或 HLS 的 .m3u8）
 * @param {string} outPath   输出 .mp4 路径
 * @param {object} descriptor 可选：{ referer, pageUrl, ua } 用于构造请求头
 *   referer / pageUrl 会被归一化为 origin（scheme://host[:port]）后作为 Referer + Origin 发送
 * @param {string} proxy     可选：已解析的代理 host:port
 * @param {object} options   可选：
 *   reencode=false（默认）：-c copy 直接转封装，无损、秒级完成；
 *   reencode=true：源编码无法塞进 MP4（典型是 webm 的 VP9/Opus）时，重编码为 H.264 + AAC。
 *   startSeconds > 0：在**输入侧**插入 `-ss`，从源时间轴的该秒数继续下载（暂停后恢复）。
 * @returns {string[]} ffmpeg 参数数组
 */
function buildFfmpegArgs(url, outPath, descriptor, proxy, options) {
  const opts = options || {};
  const ua = (descriptor && descriptor.ua) || 'Mozilla/5.0';
  const headers = [];

  // Referer / Origin 统一用「源（origin）」形式，与浏览器默认的 referrer policy 一致：
  // 跨源请求（页面域名 → 独立 CDN 域名）时浏览器只发 origin（strict-origin-when-cross-origin），
  // 不带路径；Origin 头本身也从不含路径。照搬浏览器行为，兼容性最好（实测该 CDN 按此放行）。
  const origin = originOf((descriptor && (descriptor.referer || descriptor.pageUrl)) || '');
  if (origin) {
    headers.push('Referer: ' + origin + '/');
    headers.push('Origin: ' + origin);
  }

  // 【关键】输入相关的选项（-user_agent / -headers / -http_proxy / -ss）必须出现在 -i <url> **之前**。
  // ffmpeg 的选项绑定规则是「作用于其后第一次出现的文件」，放在 -i 之后会被当成**输出**文件的
  // 选项而被静默忽略——表现是请求里既没有 Referer/Origin，UA 也仍是 ffmpeg 默认的 Lavf/xxx，
  // 于是被做了防盗链校验的 CDN 直接返回 403（实测：同一 URL，curl / node fetch 均 200，ffmpeg 403）。
  // 另：UA 用 -user_agent 而非写进 -headers —— 后者不会覆盖默认 UA，会发出两个 User-Agent 头。
  const args = ['-y'];
  args.push('-user_agent', ua);
  if (headers.length) args.push('-headers', headers.join('\r\n'));
  if (proxy) args.push('-http_proxy', withScheme(proxy));
  // -ss 同样是输入侧选项：放在 -i 之前 = 输入 seek（快、精确到关键帧），
  // 放在 -i 之后 = 输出 seek（会把 -ss 秒之前的内容也写进输出，等于没跳过）。
  // 暂停恢复正是靠它把断点之后的内容单独写进一个分段文件，再由 concat 拼回去。
  if (typeof opts.startSeconds === 'number' && opts.startSeconds > 0) {
    args.push('-ss', formatSeekTime(opts.startSeconds));
  }
  args.push('-i', url);

  if (opts.reencode) {
    // 兜底路径：无法 -c copy 进 MP4 的源重编码为 MP4 兼容编码。
    // 这条路径的唯一目标是「必定产出 MP4」，因此：
    //  - 视频/音频重编码为 H.264 + AAC；
    //  - MP4 容器放不下的附加流（字幕 subrip/ass、数据流）用 -sn -dn 直接丢弃——
    //    否则一条字幕轨道就会让整次下载失败（这正是 -c copy 最常见的失败原因）。
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k');
    args.push('-sn', '-dn');
  } else {
    args.push('-c', 'copy');
    // aac_adtstoasc 只在 HLS/TS 里的 ADTS-AAC 需要；对直链 mp4/webm 施加会因音频不是
    // AAC 而报错（这正是 webm 转 MP4 失败的常见原因之一），故仅对 .m3u8 添加。
    if (/m3u8/i.test(url || '')) args.push('-bsf:a', 'aac_adtstoasc');
    // Opus / VP9 等封装进 MP4 属「实验性」，需要放开 strict 校验
    args.push('-strict', '-2');
  }
  // faststart：把 moov 移到文件头，边下边播体验更好（对 -c copy 只是重写索引，开销很小）
  args.push('-movflags', '+faststart', outPath);
  return args;
}

/**
 * 秒数 → ffmpeg `-ss` 接受的时间串。
 * 固定输出 `HH:MM:SS.mmm`（不带符号），负数/非法值归零。
 * 保留毫秒是为了让分段断点尽量贴近真实进度——只到秒会让每段最多多下/少下 1 秒。
 */
function formatSeekTime(seconds) {
  const total = Number(seconds);
  const s = isFinite(total) && total > 0 ? total : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    sec.toFixed(3).padStart(6, '0')
  );
}

/**
 * 暂停 → 恢复时要写入的分段起点（秒）。
 *
 * ffmpeg 的输入侧 `-ss` 只能 seek 到**关键帧及之前**，所以「已经下到第 N 秒」并不等于
 * 「可以从第 N 秒无损接上」——关键帧可能落在 N 秒前几秒的位置。直接用 N 秒作为断点，
 * 两个分段交界处会缺一截画面。
 *
 * 这里统一**回退 SEEK_OVERLAP 秒**做下一段的起点：宁可让相邻两段在交界处重叠一点
 * （concat 后表现为画面短暂重复，无感），也不要出现内容缺失（有感且不可修复）。
 */
const SEEK_OVERLAP = 3;

function resumePointFrom(downloadedSeconds) {
  const s = Number(downloadedSeconds);
  if (!isFinite(s) || s <= 0) return 0;
  return Math.max(0, s - SEEK_OVERLAP);
}

/**
 * 构造「把若干分段拼成一个成品」的 ffmpeg 参数。
 *
 * 【为什么用 concat filter 而不是 concat demuxer】
 * demuxer + `-c copy` 在本项目实测有两个绕不过去的问题：
 *  1) `inpoint` 只在**读到下一条 file 指令时**才结算，最后一段的 inpoint 无处落地
 *     ——分段表最后一项永远裁不掉（实测 60s 的源拼出 85s）；
 *  2) 拼接处反复报 "non monotonically increasing dts"。
 * 补 `duration` 收尾也解决不了（实测同样无效）。
 *
 * filter 必须解码，因此拼接统一重编码为 H.264 + AAC。这个代价只落在**被暂停/失败过
 * 的任务**上——一次跑到底的下载只有一段，走单段改名路径，完全不经过这里。
 *
 * 各分段头部的重叠（见 resumePointFrom）用 trim/atrim 精确裁掉，
 * 保证成品时长与源一致（不裁会一段段虚长）。
 *
 * @param {Array<string|{path:string, trimHead?:number}>} parts 分段（按播放顺序）
 * @param {string} outPath 成品路径
 * @param {object} options  可选：{ reencode:boolean } —— 分段是重编码产物时拼接也需重编码
 * @returns {{args: string[], listFile: string}}
 *   listFile 恒为空串（不再需要清单文件）；保留该字段仅为调用方接口稳定。
 */
function buildConcatArgs(parts, outPath, options) {
  const opts = options || {};
  const list = (parts || []).filter(Boolean);
  if (!list.length) throw new Error('没有可拼接的分段');

  const asEntry = (p) =>
    typeof p === 'string' ? { path: p, trimHead: 0 } : { path: p.path, trimHead: p.trimHead || 0 };

  const args = ['-y'];
  list.forEach((p) => args.push('-i', String(asEntry(p).path)));

  // 每段：裁掉开头与上一段重叠的那截，再把时间戳归零（filter 要求从 0 开始）
  const chains = [];
  const labels = [];
  list.forEach((raw, i) => {
    const e = asEntry(raw);
    const v = 'v' + i;
    const a = 'a' + i;
    const trim = i === 0 ? 0 : e.trimHead;
    const head = trim > 0 ? 'trim=start=' + trim.toFixed(3) + ',' : 'trim=start=0,';
    const ahead = trim > 0 ? 'atrim=start=' + trim.toFixed(3) + ',' : 'atrim=start=0,';
    chains.push('[' + i + ':v]' + head + 'setpts=PTS-STARTPTS[' + v + ']');
    chains.push('[' + i + ':a]' + ahead + 'asetpts=PTS-STARTPTS[' + a + ']');
    labels.push('[' + v + '][' + a + ']');
  });
  chains.push(
    labels.join('') + 'concat=n=' + list.length + ':v=1:a=1[v][a]'
  );
  args.push('-filter_complex', chains.join(';'), '-map', '[v]', '-map', '[a]');

  // filter 必须解码，所以无论分段原本是 -c copy 还是重编码产物，拼接统一重编码为
  // H.264 + AAC（opts.reencode 因此不再影响参数，保留仅为接口兼容）。
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k');
  args.push('-sn', '-dn', '-movflags', '+faststart', outPath);
  return { args, listFile: '' };
}

/**
 * ffmpeg 可执行文件的候选路径（纯函数，便于单测）。
 * 只返回「除 PATH 兜底以外」的常见安装位置，末尾固定带 'ffmpeg' 作为 PATH 兜底。
 * @param {string} platform process.platform
 * @returns {string[]} 按优先级排列的候选路径
 */
function ffmpegCandidates(platform) {
  const list = [];
  if (platform === 'win32') {
    list.push(
      'D:\\ffmpeg\\ffmpeg.exe',
      'D:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe'
    );
  } else {
    list.push('/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg');
  }
  list.push('ffmpeg'); // 交给 PATH 解析（找不到会在 spawn 时给出明确错误）
  return list;
}

module.exports = {
  safeBaseName,
  parseProxyResult,
  withScheme,
  originOf,
  buildFfmpegArgs,
  buildConcatArgs,
  formatSeekTime,
  resumePointFrom,
  SEEK_OVERLAP,
  ffmpegCandidates
};
