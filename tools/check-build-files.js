'use strict';

/**
 * 检查：build.files 是否覆盖了所有被 require 的本地模块。
 *
 * 【为什么必须有这个检查】
 * package.json 的 build.files 是**手写白名单**。新增一个模块文件时，
 * 如果忘了把它加进去，打包出来的 exe 会在运行时报
 *
 *     A JavaScript error occurred in the main process
 *     Uncaught Exception: Error: Cannot find module './xxx'
 *
 * 而且这个错误**只在打包版里出现**（开发模式直接读工作目录，永远正常），
 * 也就是说：本地测试全绿，交给用户的 exe 却根本起不来。
 *
 * 真实踩过两次：
 *   - console-encoding.js（main.js / show.js require）→ 打包版起不来
 *   - window-bounds.js（window-drag.js require）      → 同上
 *
 * 所以把这个检查接进 lint：漏了就立刻报错，而不是等打包完才发现。
 *
 * 用法：node tools/check-build-files.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error('[build-files] ' + msg);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};
if (!Array.isArray(build.files)) {
  fail('package.json 里没有 build.files（数组）');
}

const listed = new Set(build.files.map((f) => f.replace(/^!/, '')));

// 需要扫描的源文件 = build.files 里列出的 .js（它们会进包，依赖也得进包）
const sources = build.files.filter((f) => f.endsWith('.js') && !f.startsWith('!'));

const missing = new Map();
for (const f of sources) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) {
    fail('build.files 里列了不存在的文件：' + f);
  }
  const src = fs.readFileSync(abs, 'utf8');
  // 只看相对路径的 require（'./xxx'）—— 第三方依赖由 node_modules 提供，
  // 而 build.files 里 "!node_modules/**/*" 已明确排除。
  const re = /require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let dep = m[1];
    if (!dep.endsWith('.js')) dep += '.js';
    if (!fs.existsSync(path.join(ROOT, dep))) continue; // 内联块/可选依赖
    if (!listed.has(dep)) {
      if (!missing.has(dep)) missing.set(dep, []);
      missing.get(dep).push(f);
    }
  }
}

if (missing.size) {
  console.error('[build-files] ✗ 以下模块被 require，但没有列入 build.files：');
  for (const [dep, by] of missing) {
    console.error('    ' + dep + '   ← ' + by.join(', '));
  }
  console.error('  打包版会在运行时报 "Cannot find module"，');
  console.error('  而开发模式一切正常 —— 所以这个错误很容易漏到用户手里。');
  process.exit(1);
}

console.log('[build-files] ✅ build.files 覆盖了所有被 require 的本地模块（' +
  sources.length + ' 个源文件）');
