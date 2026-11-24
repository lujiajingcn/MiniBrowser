'use strict';

/**
 * 给打包好的 exe 注入图标与版本信息。
 *
 * 为什么单独做这一步：
 *   package.json 里配了 win.signAndEditExecutable = false，
 *   以便跳过 electron-builder 的「签名 + 资源编辑」阶段 ——
 *   那一步依赖 winCodeSign 包，而该包内含 Unix 符号链接，
 *   在没有「创建符号链接」权限的 Windows 上解压必然失败（退出码 2）。
 *   这些文件是 macOS 用的 openssl 库，Windows 构建根本不需要。
 *
 *   代价是产出的 exe 没有图标与版本信息。本脚本用 electron-builder
 *   缓存里自带的 rcedit-x64.exe 补上（该工具不依赖 winCodeSign 的其余部分）。
 *
 * 用法：node tools/apply-exe-icon.js <exe 路径>
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const CACHE = path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder',
  'Cache',
  'winCodeSign'
);

/** 在缓存里找 rcedit-x64.exe（electron-builder 解压 winCodeSign 时会带出来）。 */
function findRcedit() {
  if (!fs.existsSync(CACHE)) return null;
  for (const d of fs.readdirSync(CACHE)) {
    const p = path.join(CACHE, d, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  const exe = process.argv[2];
  if (!exe) {
    console.error('用法: node tools/apply-exe-icon.js <exe 路径>');
    process.exit(1);
  }
  if (!fs.existsSync(exe)) {
    console.error('找不到 exe: ' + exe);
    process.exit(1);
  }
  if (!fs.existsSync(ICON)) {
    console.error('找不到图标: ' + ICON + '（先跑 build/make-icon.js）');
    process.exit(1);
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.error('找不到 rcedit-x64.exe（缓存 ' + CACHE + ' 里没有）');
    console.error('提示：跑一次 npx electron-builder 会自动下载解压 winCodeSign');
    process.exit(1);
  }

  console.log('[icon] 用 rcedit 写入图标与版本信息...');
  execFileSync(rcedit, [
    exe,
    '--set-icon', ICON,
    '--set-version-string', 'FileDescription', 'MiniBrowser 浏览器',
    '--set-version-string', 'ProductName', 'MiniBrowser',
    '--set-version-string', 'CompanyName', 'MiniBrowser',
    '--set-file-version', '1.0.0.0',
    '--set-product-version', '1.0.0.0',
  ], { stdio: 'inherit' });

  console.log('[icon] 完成: ' + exe);
}

main();
