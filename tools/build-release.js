'use strict';

/**
 * 一键构建分发包。
 *
 * 流程：
 *  1. 生成应用图标（build/icon.svg → build/icon.ico + icon.png）
 *  2. electron-builder 打包出 win-unpacked（目录形态）
 *  3. 用 rcedit 给 win-unpacked 里的 exe 补上图标与版本信息
 *  4. electron-builder 再打包出 NSIS 安装包 + 便携版
 *  5. 复制到 release/
 *
 * 【为什么要分两步、为什么要单独跑 rcedit】
 * package.json 里配了 win.signAndEditExecutable = false，
 * 以便跳过 electron-builder 的「签名 + 资源编辑」阶段 ——
 * 那一步依赖 winCodeSign 包，而该包内含 Unix 符号链接
 * （darwin/10.12/lib/libcrypto.dylib、libssl.dylib），
 * 在没有「创建符号链接」权限的 Windows 上解压必然失败（7za 退出码 2）。
 * 那两个文件是 macOS 用的 openssl 库，Windows 构建用不到。
 *
 * 代价是 win-unpacked 里产出的 exe 没有图标与版本信息，
 * 故在第 3 步用 electron-builder 缓存里自带的 rcedit-x64.exe 补上。
 * 注意 rcedit **只能用于未压缩的普通 exe** ——
 * 对 NSIS 安装包/便携版（自解压压缩包）使用会破坏其结构。
 *
 * 用法：node tools/build-release.js
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const TEMP_OUT = path.join(
  process.env.LOCALAPPDATA || '',
  'Temp',
  'minibrowser-build'
);

function run(cmd, args, opts) {
  console.log('$ ' + path.basename(cmd) + ' ' + args.join(' '));
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    ...(opts || {}),
  });
  if (r.status !== 0) {
    throw new Error('命令失败: ' + cmd + ' ' + args.join(' '));
  }
}

/** 找到本地 electron.exe（不经 .bin/.cmd，避免带出控制台窗口）。 */
function electronBin() {
  return require(path.join(ROOT, 'node_modules', 'electron'));
}

function step(n, total, title) {
  console.log('\n[' + n + '/' + total + '] ' + title);
}

function main() {
  const total = 5;
  fs.mkdirSync(RELEASE, { recursive: true });

  // 1. 图标
  step(1, total, '生成应用图标');
  if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
    run(electronBin(), [path.join(ROOT, 'build', 'make-icon.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
  } else {
    console.log('build/icon.ico 已存在，跳过（删除该文件可强制重建）');
  }

  // 2. 生成安装包与便携版（electron-builder 会重建 win-unpacked）
  step(2, total, 'electron-builder 打包（安装包 + 便携版 + 目录形态）');
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
    '--win', '--x64',
    '--config.directories.output=' + TEMP_OUT,
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });

  // 3. 给 exe 注入图标
  //    顺序很关键：必须在 electron-builder **之后**。
  //    electron-builder 在打包时会重新生成 win-unpacked/MiniBrowser.exe，
  //    把之前注入的图标与版本信息覆盖成 Electron 默认值。
  step(3, total, '为 exe 注入图标与版本信息');
  const exe = path.join(TEMP_OUT, 'win-unpacked', 'MiniBrowser.exe');
  run(process.execPath, [path.join(ROOT, 'tools', 'apply-exe-icon.js'), exe]);

  // 5. 收集产物
  step(5, total, '收集产物到 release/');  const artifacts = fs
    .readdirSync(TEMP_OUT)
    .filter((f) => f.endsWith('.exe'))
    .concat(fs.existsSync(path.join(TEMP_OUT, 'win-unpacked'))
      ? ['win-unpacked']
      : []);
  for (const a of artifacts) {
    const src = path.join(TEMP_OUT, a);
    const dst = path.join(RELEASE, a);
    if (fs.statSync(src).isDirectory()) {
      // 目录形态：跨盘符不能 rename（EXDEV），且沙箱 safe-delete 会拦 rmSync，
      // 所以策略是：**就地增量复制**（fs.cpSync 的 recursive 覆盖已有文件），
      // 不删除任何东西。旧的残留文件会保留，不影响使用。
      fs.cpSync(src, dst, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    const size = (fs.statSync(dst).size / 1048576).toFixed(1);
    console.log('  → release/' + a + '  (' + size + ' MB)');
  }

  console.log('\n完成。产物位于: ' + RELEASE);
}

try {
  main();
} catch (e) {
  console.error('\n构建失败: ' + (e && e.message));
  process.exit(1);
}
