'use strict';

// MiniBrowser 窗口控制命令行工具。
//
// 用法（在 cmd / PowerShell 中执行，无需参数）：
//   node "E:\study_lujiajing\WorkSpace_MiniBrowser\MiniBrowser\show.js"          显示/恢复窗口
//   node "...\show.js" status                                                    查询窗口状态（诊断用）
//
// 原理：连接 MiniBrowser 主进程监听的本地端口，发送指令，主进程执行对应操作。
//
// 【为什么要加 status】
// 「任务栏有图标、点开却看不到界面」这类问题，光看进程活着没用 ——
// 窗口可能是隐藏的、被最小化的、跑到屏幕外、或者尺寸异常。
// 把 visible / minimized / bounds 原样报出来，才能判断是哪一种。
// 例：
//   node show.js status
//   → {"windowCount":1,"windows":[{"visible":false,"minimized":false,...}]}

const net = require('node:net');
const { writeLine } = require('./console-encoding');

// 端口与主进程保持一致：主进程支持 MB_SHOW_PORT 覆盖，这里也读同一个变量，
// 否则诊断脚本用自定义端口时，show.js 连不上。
const PORT = (() => {
  const v = parseInt(process.env.MB_SHOW_PORT || '', 10);
  return v > 0 && v < 65536 ? v : 39321;
})();
const HOST = '127.0.0.1';

const CMD = (process.argv[2] || 'show').toLowerCase();

const sock = net.connect(PORT, HOST, () => {
  sock.write(CMD + '\n');
});

sock.setEncoding('utf8');
let resp = '';

sock.on('data', (chunk) => {
  resp += chunk;
});

sock.on('close', () => {
  const t = resp.trim();
  if (CMD === 'status') {
    if (!t || t === 'err') {
      writeLine('查询失败：MiniBrowser 服务未运行（应用可能未启动或已退出）。');
      return;
    }
    try {
      const data = JSON.parse(t);
      writeLine('窗口数: ' + data.windowCount);
      data.windows.forEach((w, i) => {
        writeLine('  窗口[' + i + '] visible=' + w.visible +
          ' minimized=' + w.minimized +
          ' focused=' + w.focused +
          ' skipTaskbar=' + w.skipTaskbar +
          ' bounds=' + JSON.stringify(w.bounds));
      });
      (data.displays || []).forEach((d, i) => {
        writeLine('  显示器[' + i + '] workArea=' + JSON.stringify(d.workArea) +
          ' scale=' + d.scaleFactor);
      });
    } catch (e) {
      writeLine('查询失败（返回内容无法解析）：' + t);
    }
    return;
  }
  if (t === 'ok') {
    writeLine('已发送显示命令，MiniBrowser 窗口即将恢复。');
    writeLine('（若窗口此前是最小化/隐藏状态，会一并还原并聚焦。）');
  } else {
    writeLine('未能恢复窗口：MiniBrowser 服务未运行（应用可能未启动或已退出）。');
  }
});

sock.on('error', () => {
  writeLine('连接失败：MiniBrowser 服务未运行（端口 ' + PORT + '）。');
  writeLine('');
  writeLine('说明：应用没在跑，或者启动后立刻退出了。');
  writeLine('请确认你运行的是**直接可执行**的那个文件：');
  writeLine('  release\\win-unpacked\\MiniBrowser.exe');
  writeLine('');
  writeLine('注意区分（这三个行为完全不同）：');
  writeLine('  MiniBrowser-1.0.0-x64.exe        ← NSIS 安装包，双击是装程序');
  writeLine('  MiniBrowser-1.0.0-portable.exe   ← 自解压包，会先解压再运行');
  writeLine('  win-unpacked\\MiniBrowser.exe    ← 直接启动应用');
  process.exit(1);
});
