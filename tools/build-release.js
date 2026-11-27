'use strict';

/**
 * 一键构建分发包。
 *
 * 流程：
 *  1. 生成应用图标（build/icon.svg → build/icon.ico + icon.png）
 *  2. electron-builder --dir 生成 win-unpacked（目录形态）
 *  3. 用 rcedit 给 win-unpacked 里的 exe 补上图标与版本信息
 *  4. electron-builder --prepackaged 用**改过的**目录生成 NSIS 安装包 + 便携版
 *  5. 收集产物到 release/（目录形态覆盖复制后清理多余文件，避免旧文件残留）
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
 * 【第 4 步为什么必须用 --prepackaged，不能一次性打包】
 * electron-builder 一次性生成全部目标时，会在包好自己的 exe 之后
 * 才做资源编辑；我们把 rcedit 放在它之后执行，只能改到 win-unpacked 里的 exe，
 * NSIS 安装包与便携版里装的仍是 Electron 默认图标/版本信息的旧 exe。
 * 因此必须先 --dir 产出目录 → rcedit → 再用 --prepackaged 指向该目录打包，
 * 让 NSIS/便携版直接把改好的 exe 装进去。
 *
 * 用法：node tools/build-release.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const TEMP_OUT = path.join(
  process.env.LOCALAPPDATA || '',
  'Temp',
  'minibrowser-build'
);
// 目录形态与安装包分开输出：第 4 步读的是 APP_OUT/win-unpacked，
// 若与 PKG_OUT 混用，旧的安装包产物会干扰判断。
const APP_OUT = path.join(TEMP_OUT, 'app');
const PKG_OUT = path.join(TEMP_OUT, 'pkg');

/** 子进程统一清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，避免注入到构建工具。 */
function buildEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    NODE_OPTIONS: '',
  };
}

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

/** 清理输出目录，避免上一次构建的产物（尤其已改过图标的 exe）混入本次结果。 */
function cleanDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 把 src 同步到 dst：先覆盖复制所有新文件，再删除 dst 里 src 已不存在的旧项。
 *
 * 不做「先整个删掉 dst」：app.asar 常被 Windows Defender / 搜索索引持有一个
 * 只允许写入、不允许删除的句柄，rmSync 整个目录会 EBUSY，导致构建在最后一步失败。
 * 覆盖写入不受影响；清理旧项时个别文件删不掉只告警，不阻断产物交付。
 */
function syncDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, force: true });
  const stale = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (fs.existsSync(path.join(src, r))) {
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
      } else {
        stale.push(path.join(dir, e.name));
      }
    }
  };
  walk(dst, '');
  for (const p of stale) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      console.warn('  ! 旧文件无法清理（可手动删除）: ' + p + ' — ' + ((e && e.message) || e));
    }
  }
  if (stale.length) console.log('  · 清理旧文件 ' + stale.length + ' 项');
}

function main() {
  const total = 5;
  fs.mkdirSync(RELEASE, { recursive: true });
  cleanDir(APP_OUT);
  cleanDir(PKG_OUT);

  // 1. 图标
  step(1, total, '生成应用图标');
  if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
    run(electronBin(), [path.join(ROOT, 'build', 'make-icon.js')], {
      env: buildEnv(),
    });
  } else {
    console.log('build/icon.ico 已存在，跳过（删除该文件可强制重建）');
  }

  // 2. 只生成 win-unpacked，不生成安装包
  step(2, total, 'electron-builder --dir（仅生成 win-unpacked）');
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
    '--win', '--x64', '--dir',
    '--config.directories.output=' + APP_OUT,
  ], { env: buildEnv() });

  const appDir = path.join(APP_OUT, 'win-unpacked');
  const exe = path.join(appDir, 'MiniBrowser.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('未生成 ' + exe + '（--dir 步骤可能失败）');
  }

  // 3. 给 exe 注入图标（必须在第 2 步之后、第 4 步之前）
  step(3, total, '为 exe 注入图标与版本信息');
  run(process.execPath, [path.join(ROOT, 'tools', 'apply-exe-icon.js'), exe]);

  // 4. 用改好的 win-unpacked 生成 NSIS 安装包 + 便携版
  step(4, total, 'electron-builder --prepackaged（安装包 + 便携版）');
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
    '--win', '--x64',
    '--prepackaged=' + appDir,
    '--config.directories.output=' + PKG_OUT,
  ], { env: buildEnv() });

  // 5. 收集产物
  step(5, total, '收集产物到 release/');
  const pkgs = fs.readdirSync(PKG_OUT).filter((f) => f.endsWith('.exe'));
  if (!pkgs.length) {
    throw new Error('第 4 步没有生成任何 .exe 安装包产物');
  }
  const artifacts = pkgs.concat(['win-unpacked']);
  for (const a of artifacts) {
    const src = a === 'win-unpacked' ? appDir : path.join(PKG_OUT, a);
    const dst = path.join(RELEASE, a);
    if (a === 'win-unpacked') {
      syncDir(src, dst);
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
