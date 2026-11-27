'use strict';

/**
 * 应用身份回归验证：任务栏名称与图标不能退回 Electron 默认值。
 *
 * 背景：任务栏右键菜单显示「Electron」+ Electron 原生图标。两个独立原因：
 *  1) 代码没设 AppUserModelID / app.setName / BrowserWindow.icon；
 *  2) 跑的是开发模式 electron.exe（进程本身就是 Electron）。
 * 本脚本验证代码层面的三项修复，且必须早于 app ready 生效：
 *  - app.getName() === 'MiniBrowser'
 *  - AppUserModelID 已设为 com.minibrowser.app
 *  - 两个 BrowserWindow 创建点都传了 icon，且图标文件真实存在
 *  - 打包配置带 extraResources（resources/icon.ico）
 *
 * 独立 userData / show-server 端口，不碰真实实例。
 */

const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DIAG_UD = path.join(os.tmpdir(), 'minibrowser-diag-identity-' + process.pid);
app.setPath('userData', DIAG_UD);
process.env.MB_USER_DATA_DIR = DIAG_UD;
process.env.MB_SHOW_PORT = String(39500 + (process.pid % 100));

const ROOT = __dirname;
const fails = [];
const log = [];
const exp = (c, m) => { if (!c) fails.push(m); };

// 静态检查：main.js 必须在 require('electron') 之后、whenReady 之前设置身份
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const idxName = mainSrc.indexOf("app.setName('MiniBrowser')");
const idxAumid = mainSrc.indexOf('app.setAppUserModelId(');
const idxReady = mainSrc.indexOf('app.whenReady(');
log.push([' setName 位置', idxName]);
log.push([' setAppUserModelId 位置', idxAumid]);
log.push([' whenReady 位置', idxReady]);
exp(idxName > 0 && idxAumid > 0, 'main.js 必须调用 setName 与 setAppUserModelId');
exp(idxName < idxReady && idxAumid < idxReady,
  '应用身份设置必须早于 app.whenReady()（否则任务栏分组已定型）');

// 两个窗口创建点都要带 icon
const iconLines = mainSrc.split('\n')
  .map((l, i) => ({ l, n: i + 1 }))
  .filter((x) => /^\s*icon:\s*APP_ICON/.test(x.l));
log.push([' icon 赋值行', iconLines.map((x) => x.n).join(',')]);
exp(iconLines.length >= 2, '主窗口与 mb-create-window 都要设置 icon: APP_ICON');

// 打包配置必须把图标放到 resources/ 根（asar 内路径不能给 nativeImage）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const extras = (pkg.build && pkg.build.extraResources) || [];
const iconExtra = extras.some((e) =>
  typeof e === 'object' && /icon\.ico$/i.test(e.from || '') && /icon\.ico$/i.test(e.to || ''));
log.push([' extraResources 带 icon.ico', iconExtra]);
exp(iconExtra, 'package.json build.extraResources 必须包含 build/icon.ico → icon.ico');
exp(fs.existsSync(path.join(ROOT, 'build', 'icon.ico')), 'build/icon.ico 必须存在');

app.whenReady().then(async () => {
  // 本诊断作为独立进程运行，不会加载 main.js，所以 app.getName() 仍是诊断脚本
  // 自己的身份；真正的 setName / setAppUserModelId 由上面的静态检查覆盖。
  // 这里只验证图标文件能被 nativeImage 读取（BrowserWindow.icon 的同一条路径）。
  const icon = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.ico'));
  const iconOk = !icon.isEmpty();
  log.push([' icon.ico 可被 nativeImage 读取', iconOk + ' size=' + JSON.stringify(icon.getSize())]);
  exp(iconOk, 'build/icon.ico 必须能被 nativeImage 读取');

  console.log('\n==== 应用身份诊断 ====');
  log.forEach(([k, v]) => console.log('  ' + k + ': ' + v));
  if (fails.length) {
    console.log('\n失败 ' + fails.length + ' 项:');
    fails.forEach((f) => console.log('  ✗ ' + f));
  } else {
    console.log('\n全部通过');
  }
  app.exit(fails.length ? 1 : 0);
});
