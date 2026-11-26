'use strict';

/**
 * 终端编码适配：让中文日志在 Windows 控制台上正常显示。
 *
 * 【Windows 上有两条完全不同的写入路径】
 *
 * 1) stdout 连着**控制台**（TTY）：
 *    libuv 走 `WriteConsoleW`，写入前会把内容按 **UTF-8 → UTF-16** 转换。
 *    → 所以必须传**字符串**，中文才能正确显示。
 *    → 传 Buffer（比如 GBK 字节）会被当成 UTF-8 解码 → **必然乱码**。
 *
 * 2) stdout 被**重定向**到文件/管道（IDE 集成终端、npm start 的管道等）：
 *    libuv 走 `WriteFile`，直接写字节，控制台代码页不参与。
 *    → 显示端按自己的方式解码；显示端若是 GBK(936)，就得写 GBK 字节，
 *      否则乱码。
 *
 * 【所以策略是】
 *   TTY      → 写**字符串**（不做任何转码）
 *   非 TTY   → 按终端**实际代码页**写字节（iconv-lite 转换）
 *
 * 【曾经踩过的两个坑】
 *
 * 坑一：在 TTY 下也转 GBK —— 方向反了。
 *   WriteConsoleW 会把传入的 Buffer 当 UTF-8 解码，
 *   GBK 字节不是合法 UTF-8 → 乱码。
 *   （本文件的旧版本正是这么做的，导致 cmd 里中文全是乱码。）
 *
 * 坑二：用 `!process.stdout.isTTY` 判断「是否终端」。
 *   某些环境下 isTTY 是 **undefined** 而不是 false，
 *   `!undefined` 为 true → 被误判成「重定向到文件」→ 走错分支。
 *   只有**明确**是 false 才算重定向。
 *
 * 【环境变量】
 *   MB_CONSOLE_ENCODING=gbk|utf8|big5 …  强制指定编码（跳过代码页探测）
 *   MB_CONSOLE_MODE=auto|raw|cp         强制指定写入策略
 *       auto（默认）TTY 写字符串 / 非 TTY 按代码页写字节
 *       raw           始终写 UTF-8 字节
 *       cp            始终按代码页写字节
 *
 * 【为什么不用 TextEncoder】
 * WHATWG 的 TextDecoder 支持 gbk 等编码（可以解码），
 * 但 TextEncoder **只支持 UTF-8**，没法把 UTF-8 转成 GBK 字节。
 * 所以非 TTY 场景用 iconv-lite 做编码转换。
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

  // 显式覆盖：MB_CONSOLE_ENCODING=gbk / utf8 / big5 …
  const forced = (process.env.MB_CONSOLE_ENCODING || '').toLowerCase();
  if (forced) {
    _cached = forced === 'utf8' ? 'utf8' : forced;
    return _cached;
  }

  // 【坑二】只有**明确**是 false 才算「重定向到文件」。
  // isTTY 为 undefined 时，stdout 往往仍然连着控制台，
  // 此时仍应按控制台代码页来判断编码。
  if (process.stdout.isTTY === false) return _cached;

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
 * stdout 是否连着控制台。
 * isTTY 为 undefined 时按「是控制台」处理（见文件头坑二）。
 */
function isConsole() {
  return process.stdout.isTTY !== false;
}

/**
 * 按当前策略写一行到 stdout。
 * @param {...any} args 与 console.log 相同的参数
 */
function writeLine(...args) {
  writeTo(process.stdout, args);
}

/** 与 writeLine 相同，但写到 stderr。 */
function writeErrLine(...args) {
  writeTo(process.stderr, args);
}

/**
 * 真正的写入实现。
 * @param {NodeJS.WriteStream} stream 目标流
 * @param {any[]} args 与 console.log 相同的参数
 */
function writeTo(stream, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : require('node:util').inspect(a)))
    .join(' ');

  const mode = (process.env.MB_CONSOLE_MODE || 'auto').toLowerCase();
  // raw → 始终写字符串（内容是 UTF-8 字节，由 Node/终端自己处理）
  // cp  → 始终按控制台代码页写字节（iconv 转换）
  // auto→ TTY 写字符串；非 TTY 按代码页写字节
  const useString = mode === 'raw' ? true : mode === 'cp' ? false : isConsole();

  // 控制台：传**字符串**，让 libuv 走 WriteConsoleW 的 UTF-8→UTF-16 转换。
  // 传 Buffer 会被当成 UTF-8 解码，GBK 字节必然乱码（见文件头坑一）。
  if (useString) {
    stream.write(text + '\n');
    return;
  }

  // 重定向：按代码页写字节，让 GBK 显示端能正确解码。
  const enc = detectEncoding();
  if (enc === 'utf8') {
    stream.write(text + '\n');
    return;
  }
  try {
    const iconv = require('iconv-lite');
    stream.write(iconv.encode(text + '\n', enc));
  } catch (_) {
    // iconv-lite 不可用时退回 UTF-8（可能乱码，但至少不会丢日志）
    stream.write(text + '\n');
  }
}

module.exports = { detectEncoding, writeLine, writeErrLine };
