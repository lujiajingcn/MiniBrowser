'use strict';

/**
 * 把 video-detect.js 的逻辑内联进 webview-preload.js。
 *
 * 【为什么必须内联】
 * <webview> 的 preload 运行在**完全沙箱化**的 guest 渲染进程里，
 * 它无法 require 任何外部模块：
 *   - 相对路径 './video-detect' → "module not found"
 *   - 字面量绝对路径            → "module not found"
 *   - file:// URL               → "module not found"
 * 该沙箱里连 __dirname 与 require.resolve 都没有。
 * 后果很严重：**整个 preload 加载失败**，于是 preload 里注册的所有能力
 * 全部失效 —— 右键菜单、下载页面视频、保存网页、页内查找、Alt+拖动、
 * 以及「点网页空白处关闭浮层」的 mb-page-pointer-down 通道。
 * （此问题自 ab9d0eb「实现下载页面中视频的功能」引入 require 起就存在。）
 *
 * 【如何避免两份代码漂移】
 * video-detect.js 仍是**唯一真源**：Node 单测（test-video-logic.js）直接
 * require 它。本脚本在构建/测试前把它内联进 webview-preload.js，
 * 源文件顶部有「本文件由 tools/inline-video-detect.js 生成」的标记，
 * 改动真源后重新运行本脚本即可。
 *
 * 用法：node tools/inline-video-detect.js [--check]
 *   --check 只检查是否已同步（不修改），用于 CI/测试前校验
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'video-detect.js');
const TARGET = path.join(ROOT, 'webview-preload.js');

const BEGIN = '// >>> BEGIN INLINED video-detect.js (由 tools/inline-video-detect.js 生成，请勿手改) >>>';
const END = '// <<< END INLINED video-detect.js <<<';

function buildInlineBlock() {
  const src = fs.readFileSync(SRC, 'utf8');
  // 去掉 module.exports 那一段（内联时用对象字面量代替）
  const exportIdx = src.indexOf('module.exports');
  if (exportIdx < 0) {
    throw new Error('video-detect.js 里找不到 module.exports');
  }
  const body = src.slice(0, exportIdx);
  const exportsObj = src.slice(exportIdx);

  // 从 module.exports = { ... } 里提取键名。
  // 用括号配对定位对象字面量的结束位置，避免依赖具体缩进/换行格式。
  const objStart = exportsObj.indexOf('{');
  if (objStart < 0) throw new Error('无法定位 module.exports 的对象字面量');
  let depth = 0;
  let objEnd = -1;
  for (let i = objStart; i < exportsObj.length; i++) {
    const ch = exportsObj[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { objEnd = i; break; }
    }
  }
  if (objEnd < 0) throw new Error('module.exports 的对象字面量未闭合');

  const inner = exportsObj.slice(objStart + 1, objEnd);
  const names = [];
  // 顶层成员名（不处理嵌套对象/计算属性，本模块的导出都是简单标识符）
  for (const m of inner.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)) {
    names.push(m[1]);
  }
  if (!names.length) throw new Error('video-detect.js 没有导出任何成员');

  return [
    BEGIN,
    '// 本段由 tools/inline-video-detect.js 从 video-detect.js 自动生成。',
    '// 理由见该脚本注释：<webview> 的 preload 沙箱无法 require 外部模块，',
    '// 不内联会导致整个 preload 加载失败、页内能力全部失效。',
    '// 请修改 video-detect.js 后重新运行 node tools/inline-video-detect.js',
    '//',
    '// 注意：这里刻意**不套 IIFE** —— 内联的函数与 const det 需要对外可见，',
    '// 供下方 webview-preload 的其余代码使用。',
    body.replace(/^'use strict';\s*/m, ''),
    'const det = { ' + names.join(', ') + ' };',
    END,
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const block = buildInlineBlock();

  const target = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  const startIdx = target.indexOf(BEGIN);
  const endIdx = target.indexOf(END);

  if (startIdx < 0 || endIdx < 0) {
    if (checkOnly) {
      console.error('[inline] webview-preload.js 里找不到内联标记块');
      process.exit(1);
    }
    console.log('[inline] 插入内联块...');
    // 插到 require('./video-detect') 那一行的位置（该行将被移除）
    const relRequire = "const det = require('./video-detect');";
    const idx = target.indexOf(relRequire);
    if (idx < 0) {
      console.error("[inline] 找不到 " + relRequire + " —— 请先手动确认 webview-preload.js 的当前形态");
      process.exit(1);
    }
    const next = target.slice(0, idx) + block + target.slice(idx + relRequire.length);
    fs.writeFileSync(TARGET, next, 'utf8');
    console.log('[inline] 已插入内联块');
    return;
  }

  const current = target.slice(startIdx, endIdx + END.length);
  if (current === block) {
    console.log('[inline] 已同步，无需改动');
    return;
  }
  if (checkOnly) {
    console.error('[inline] 内联块与 video-detect.js 不同步 —— 请运行 node tools/inline-video-detect.js');
    process.exit(1);
  }
  console.log('[inline] 更新内联块...');
  const next = target.slice(0, startIdx) + block + target.slice(endIdx + END.length);
  fs.writeFileSync(TARGET, next, 'utf8');
  console.log('[inline] 已更新');
}

main();
