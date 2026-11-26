'use strict';

/**
 * console-check.js 的被测端：只输出一行中文。
 * 写入策略由环境变量 MB_CONSOLE_MODE 决定（见 console-encoding.js）。
 */

const { writeLine } = require('../console-encoding');

writeLine('中文测试：连接失败，窗口已创建 1280x820');
