'use strict';

// 恢复 MiniBrowser 窗口的命令行工具。
// 用法（在 cmd / PowerShell 中执行，无需参数）：
//   node "E:\study_lujiajing\WorkSpace_MiniBrowser\MiniBrowser\show.js"
// 原理：连接 MiniBrowser 主进程监听的本地端口，发送 show 指令，主进程把隐藏的窗口重新显示。
// 注意：此命令是“重新显示窗口”的唯一途径（隐藏后界面不会出现在任务栏，只能靠它恢复）。

const net = require('node:net');

const PORT = 39321;
const HOST = '127.0.0.1';

const sock = net.connect(PORT, HOST, () => {
  sock.write('show\n');
});

sock.setEncoding('utf8');
let resp = '';

sock.on('data', (chunk) => {
  resp += chunk;
});

sock.on('close', () => {
  if (resp.trim() === 'ok') {
    console.log('已发送显示命令，MiniBrowser 窗口即将恢复。');
  } else {
    console.log('未能恢复窗口：MiniBrowser 服务未运行（应用可能未启动或已退出）。');
  }
});

sock.on('error', () => {
  console.log('连接失败：MiniBrowser 服务未运行或端口被占用（请确认应用正在运行）。');
  process.exit(1);
});
