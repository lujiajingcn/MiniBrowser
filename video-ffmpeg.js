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

/**
 * 构造 ffmpeg 参数：所有视频统一转封装为 MP4（-c copy 无损且快）。
 * @param {string} url       视频源地址（直链 mp4 或 HLS 的 .m3u8）
 * @param {string} outPath   输出 .mp4 路径
 * @param {object} descriptor 可选：{ referer, pageUrl, ua } 用于构造请求头
 * @param {string} proxy     可选：已解析的代理 host:port
 * @returns {string[]} ffmpeg 参数数组
 */
function buildFfmpegArgs(url, outPath, descriptor, proxy) {
  const headers = [];
  if (descriptor && descriptor.referer) headers.push('Referer: ' + descriptor.referer);
  if (descriptor && descriptor.pageUrl) headers.push('Origin: ' + descriptor.pageUrl);
  headers.push('User-Agent: ' + (descriptor && descriptor.ua ? descriptor.ua : 'Mozilla/5.0'));

  // 注意：-headers / -http_proxy 都是与「输入 URL」相关的 demuxer 选项，
  // 必须放在对应的 -i 之后才生效；放在 -i 之前会被 ffmpeg 当作全局选项拒绝
  // （报 "Option headers not found" 并退出）。
  const args = ['-y', '-i', url];
  if (headers.length) args.push('-headers', headers.join('\r\n'));
  if (proxy) args.push('-http_proxy', withScheme(proxy));
  args.push(
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc', // 部分 AAC 流需要此 bitstream filter 才能封装进 MP4
    outPath
  );
  return args;
}

module.exports = { safeBaseName, parseProxyResult, withScheme, buildFfmpegArgs };
