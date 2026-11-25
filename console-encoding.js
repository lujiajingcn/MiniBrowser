'use strict';

/**
 * 终端编码适配：让中文日志在 Windows 控制台上正常显示。
 *
 * 【问题】
 * Windows 控制台（cmd / PowerShell）默认代码页是 **936(GBK)**，
 * 而 Node 与 Electron 往 stdout 写的是 **UTF-8** 字节。
 * cmd 按 936 去解码这些字节，中文就变成「宸插惎鍔」这样的乱码。
 * 这不是应用 bug，是「写入编码」与「终端解码编码」不一致。
 *
 * 【为什么不用「把日志改成英文」绕开】
 * 那样确实能避开乱码，但会丢掉中文日志，而且只覆盖 stdout 上我们自己打的日志；
 * 第三方库（Electron 内部、依赖包）打的英文/中文日志照样可能乱码。
 * 按终端实际代码页编码输出是更彻底的解法。
 *
 * 【为什么不用 TextEncoder】
 * WHATWG 的 TextDecoder 支持 gbk 等编码（可以解码），
 * 但 TextEncoder **只支持 UTF-8**，没法把 UTF-8 转成 GBK 字节。
 * 所以这里用 iconv-lite 做编码转换。
 *
 * 【什么时候才需要】
 * 只有 stdout/stderr **是终端**时才需要 —— 重定向到文件或管道时，
 * UTF-8 才是更通用、更正确的选择（乱码反而是编码成 GBK 才会造成的问题）。
 */

const { execSync } = require('node:child_process');

/** Windows 代码页 → iconv-lite 支持的编码名。 */
const WIN_CP_TO_ENCODING = {
  936: 'gbk',
  950: 'big5',
  932: 'shift_jis',
  949: 'cp949',
  1252: 'windows-1252',
  1251: 'windows-1251',
  65001: 'utf8',
};

let _cached = null; // null = 尚未探测

/**
 * 探测当前终端的输出代码页，返回 iconv-lite 的编码名。
 * 探测失败或非终端时返回 'utf8'。
 */
function detectEncoding() {
  if (_cached) return _cached;
  _cached = 'utf8';
  if (process.platform !== 'win32') return _cached;
  if (!process.stdout.isTTY) return _cached;
  try {
    // chcp 的输出本身可能就是乱码（GBK 系统输出中文、活动代码页: 936），
    // 但**数字**总是 ASCII 的，直接正则提取即可。
    const out = execSync('chcp', {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).toString();
    const m = out.match(/(\d{3,5})/);
    const cp = m ? parseInt(m[1], 10) : 0;
    const enc = WIN_CP_TO_ENCODING[cp];
    if (enc && enc !== 'utf8') _cached = enc;
  } catch (_) {
    /* 探测失败就用 utf8 */
  }
  return _cached;
}

/**
 * 按终端编码写一行到 stdout。
 * @param {...any} args 与 console.log 相同的参数
 */
function writeLine(...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : require('node:util').inspect(a)))
    .join(' ');
  const enc = detectEncoding();
  if (enc === 'utf8') {
    process.stdout.write(text + '\n');
    return;
  }
  try {
    const iconv = require('iconv-lite');
    process.stdout.write(iconv.encode(text + '\n', enc));
  } catch (_) {
    // iconv-lite 不可用时退回 UTF-8（可能乱码，但至少不会丢日志）
    process.stdout.write(text + '\n');
  }
}

/** 与 writeLine 相同，但写到 stderr。 */
function writeErrLine(...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : require('node:util').inspect(a)))
    .join(' ');
  const enc = detectEncoding();
  if (enc === 'utf8') {
    process.stderr.write(text + '\n');
    return;
  }
  try {
    const iconv = require('iconv-lite');
    process.stderr.write(iconv.encode(text + '\n', enc));
  } catch (_) {
    process.stderr.write(text + '\n');
  }
}

module.exports = { detectEncoding, writeLine, writeErrLine };
