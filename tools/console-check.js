'use strict';

/**
 * 控制台编码自检：在当前终端里用**三种写入策略**各输出一行同样的中文，
 * 让人眼直接判断哪种不乱码。
 *
 * 【为什么要这个】
 * Windows 上往控制台写中文有两条路径（TTY → WriteConsoleW 走 UTF-8→UTF-16；
 * 重定向 → WriteFile 直接写字节），选错了就是乱码。
 * 而「哪种对」取决于终端到底是哪一种 —— 机器上判断容易出错，
 * **让人眼看一眼最可靠**。
 *
 * 跑法（在 cmd / PowerShell 里）：
 *   node tools/console-check.js
 *
 * 预期：其中**有一行**（或几行）中文显示正常，其余乱码。
 * 看完把结果告诉开发者，据此确定默认策略。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SAMPLE = '中文测试：连接失败，窗口已创建 1280x820';

const MODES = [
  { mode: 'auto', desc: '自动（TTY 写字符串 / 非 TTY 按代码页）' },
  { mode: 'raw', desc: '始终写 UTF-8 字节' },
  { mode: 'cp', desc: '始终按控制台代码页写字节' },
];

// 复用被测模块：以环境变量控制它的行为，逐个模式跑一遍。
const probe = path.join(ROOT, 'tools', 'console-check-probe.js');

console.log('=== 控制台编码自检 ===');
console.log('下面每种模式各输出一行相同的中文，请看**哪一行显示正常**：');
console.log('');

MODES.forEach((m, i) => {
  const r = spawnSync(process.execPath, [probe], {
    cwd: ROOT,
    env: { ...process.env, MB_CONSOLE_MODE: m.mode },
    stdio: 'inherit',
  });
  if (r.error) {
    console.log('  模式 ' + m.mode + ' 运行失败：' + r.error.message);
  }
  console.log('  ↑ 第 ' + (i + 1) + ' 行 = ' + m.desc);
  console.log('');
});

console.log('请把「哪几行正常」的结果反馈给开发者。');
console.log('（如果只有第 1 行正常 → 默认策略正确，无需改动。）');
