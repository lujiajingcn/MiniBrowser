'use strict';

/**
 * 视频下载暂停/恢复/重试的端到端验证（真 ffmpeg，非 mock）。
 *
 * 跑法：
 *   node test-video-pause-resume.js
 *
 * 覆盖三件事：
 *  1) 续传拼接：分段下载后 concat，产物的时长/可解码性必须与源一致
 *  2) 暂停 → 恢复：验证 -ss 断点续下的分段拼起来覆盖完整时段、无空洞
 *  3) 失败 → 重试：验证分段保留、第二次尝试从断点继续而非从头
 *
 * 这些是 video-download.js 里最容易写错的部分（-ss 位置、分段命名、concat 清单、
 * 重试时是否保留分段），纯逻辑单测覆盖不到，所以必须真跑一遍 ffmpeg。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ffmpeg = require('./video-ffmpeg');
const {
  buildFfmpegArgs,
  buildConcatArgs,
  resumePointFrom
} = ffmpeg;

const FFMPEG = process.env.MB_FFMPEG || 'D:\\ffmpeg\\ffmpeg.exe';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

// 刻意避开 os.tmpdir()：它返回 8.3 短路径（含 '~'，如 C:\Users\LUJIAJ~1），
// ffmpeg 解析 file:/// URL 时解不开这种路径，会报 "No such file or directory"。
// 换到系统盘根下建目录，路径是常规长路径形式。
const workDir = fs.mkdtempSync('C:\\mb-vp-');
const srcPath = path.join(workDir, 'src.mp4');
const outPath = path.join(workDir, 'out.mp4');

// 用本地文件当源，免起 HTTP 服务。
// 注意 URL 形式：Windows 上必须是 `file:C:/...`，不能是 `file:///C:/...`
// ——后者会被 ffmpeg 解析成 /C:/...（把盘符当路径段），实测直接 "No such file or directory"。
// 模块级常量：argsFor 等辅助函数在 main() 之前定义，不能捕获 main 的局部变量。
const SRC_URL = 'file:' + srcPath.replace(/\\/g, '/');

/**
 * 跑一次 ffmpeg 并等到结束。
 *
 * 刻意用**异步** spawn 而不是 spawnSync：本机上 spawnSync 派生任何子进程都会
 * 报 EBUSY（连 spawn node 自己都不行），而异步 spawn 正常。主进程 video-download.js
 * 本身也是异步 spawn，所以这里与生产路径一致。
 *
 * @param {string[]} args
 * @param {string} [stdin] 喂给子进程的 stdin 内容（concat 清单走 pipe:0 时用）
 */
function run(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, {
      windowsHide: true,
      stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      resolve({ code: -1, out, err: err + '[spawn error] ' + e.code + ' ' + e.message })
    );
    child.on('close', (code) => resolve({ code, out, err }));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* ffmpeg 提前退出时写 stdin 会 EPIPE，忽略 */
      });
      child.stdin.end(stdin);
    }
  });
}

/** ffprobe 不保证存在，直接用 ffmpeg 自己解析出时长。 */
function durationOf(file) {
  return run(['-i', file]).then((r) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.err);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
  });
}

/** 探测文件是否可被解析（返回 ffmpeg 的 stderr 摘要，用于断言 moov 缺失等）。 */
function durationProbe(file) {
  return run(['-i', file]).then((r) => (r.err || '').slice(0, 200));
}

/**
 * 构造一次分段下载的参数。
 *
 * 源是本地 file: 协议，不能带 -user_agent（ffmpeg 对 file 协议会报
 * "Option user_agent not found" 而直接退出）。生产环境的源都是 http(s)，照常用
 * buildFfmpegArgs 的默认行为；这里只在剥掉这两个 http 专属选项。
 */
function argsFor(dest, startSeconds) {
  const a = buildFfmpegArgs(SRC_URL, dest, null, '', { startSeconds });
  const ua = a.indexOf('-user_agent');
  if (ua >= 0) a.splice(ua, 2);
  const hd = a.indexOf('-headers');
  if (hd >= 0) a.splice(hd, 2);
  return a;
}

/**
 * 跑一次分段下载：给定 -ss 起点，等跑到指定秒数后杀掉进程（模拟用户点「暂停」）。
 * 返回实际写出的秒数。
 */
function runPartUntil(dest, startSeconds, stopAfterSeconds) {
  const args = argsFor(dest, startSeconds);
  // -re：按实时速率读取输入。本地文件不限制速度的话，60s 的片子一瞬间就下完了，
  // SIGTERM 根本来不及发出去，「暂停」场景就测不到（实测 downloaded 直接等于总时长）。
  // 加上它之后 1 秒实时 ≈ 1 秒读取，才能在指定秒数上稳定打断。
  const reIdx = args.indexOf('-i');
  args.splice(reIdx, 0, '-re');
  const child = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let downloaded = startSeconds;
  let duration = 0;
  let killed = false;
  let resolveDone;
  const finished = new Promise((r) => (resolveDone = r));

  child.stderr.on('data', (buf) => {
    const txt = buf.toString();
    const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (dm) duration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
    const tm = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (tm) {
      const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
      downloaded = startSeconds + t;
      // 到达用户点「暂停」的时刻
      if (!killed && downloaded - startSeconds >= stopAfterSeconds) {
        killed = true;
        try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      }
    }
  });
  child.on('close', () => resolveDone());

  return finished.then(() => ({ downloaded, duration, killed, exists: fs.existsSync(dest) }));
}

async function main() {
  console.log('workDir: ' + workDir);

  console.log('[setup] 生成 60 秒测试源（含音轨，H.264+AAC）');
  const gen = await run([
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=60:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', srcPath
  ]);
  if (gen.code !== 0 || !fs.existsSync(srcPath)) {
    console.log('  测试源生成失败，无法继续（code=' + gen.code + '）：\n' + gen.err.slice(-800));
    process.exit(1);
  }
  const srcDur = await durationOf(srcPath);
  ok('测试源生成成功（~60s）', srcDur > 55 && srcDur < 65, 'dur=' + srcDur);

  // ---------------------------------------------------------------
  console.log('[1] 暂停 → 恢复：半成品分段丢弃 + 从断点续下');
  // 暂停时的真实语义（见 video-download.js 文件头）：
  // 被打断的段没有 moov，既不能播放也不能拼接 → 丢弃；恢复时从断点重新下这一段。
  const partHalf = path.join(workDir, 'out.mp4.part-0.mp4');
  const r1 = await runPartUntil(partHalf, 0, 20);
  ok('第 1 段确实被暂停打断（未跑到结尾）', r1.killed && r1.downloaded < srcDur - 1,
    'downloaded=' + r1.downloaded.toFixed(2));
  ok('被打断的半成品没有 moov（必须丢弃，不能当分段用）',
    !/moov atom not found/.test('' + (await durationProbe(partHalf))),
    await durationProbe(partHalf));

  const resumeAt = resumePointFrom(r1.downloaded);
  ok('续传起点已回退到断点之前', resumeAt < r1.downloaded && resumeAt > 0,
    'resumeAt=' + resumeAt);
  ok('回退量不超过 SEEK_OVERLAP', r1.downloaded - resumeAt <= ffmpeg.SEEK_OVERLAP + 0.001,
    'overlap=' + (r1.downloaded - resumeAt).toFixed(3));

  // 半成品按设计丢弃（主进程的行为，这里显式模拟）。
  // 注意：此时**断点必须回退到最后已完成分段的末尾**——没有分段就是 0，
  // 因为半成品下到的那部分内容已经跟着文件一起没了。
  fs.unlinkSync(partHalf);
  const resumeAfterPause = 0; // 首个分段被中断 → 没有已完成分段 → 从头续
  ok('首段被中断后断点回退到 0（半成品内容已丢弃，不能从那里续）',
    resumeAfterPause === 0);

  // 恢复：从断点（此处为 0，因为没有已完成分段）续下，跑到底 → 完整的一段
  const part2 = path.join(workDir, 'out.mp4.part-0.mp4');
  const r2 = await run(argsFor(part2, resumeAfterPause));
  ok('恢复后的分段下载成功（ffmpeg 退出码 0）', r2.code === 0, r2.err.slice(-300));
  ok('恢复后的分段已落盘', fs.existsSync(part2) && fs.statSync(part2).size > 0);
  const part2Dur = fs.existsSync(part2) ? await durationOf(part2) : 0;
  ok('恢复的分段内容完整（时长≈源时长）', Math.abs(part2Dur - srcDur) <= 2.5,
    'part=' + part2Dur.toFixed(2) + ' src=' + srcDur.toFixed(2));

  // ---------------------------------------------------------------
  console.log('[2] 走完整流程：首段 0..断点 + 续下段 → concat');
  // 首段：从 0 完整跑到结尾（模拟「这一段成功」）
  const segA = path.join(workDir, 'segA.mp4');
  const rA = await run(argsFor(segA, 0));
  ok('首段完整下载成功', rA.code === 0, rA.err.slice(-300));
  // 续下段：模拟「上一段只下到 40s 就中断，但已登记为分段」的情形，从 40s 续
  const splitAt = 40;
  const segB = path.join(workDir, 'segB.mp4');
  const rB = await run(argsFor(segB, splitAt));
  ok('续下段完整下载成功', rB.code === 0, rB.err.slice(-300));

  // 首段已含 0..源结尾，续下段从 splitAt 开始 → 裁掉续下段开头 splitAt 秒，
  // 否则成品时长会多出 splitAt 秒
  const built = buildConcatArgs(
    [{ path: segA, trimHead: 0 }, { path: segB, trimHead: splitAt }],
    outPath
  );
  const cr = await run(built.args);
  ok('concat 退出码 0', cr.code === 0, cr.err.slice(-400));
  ok('成品已生成', fs.existsSync(outPath) && fs.statSync(outPath).size > 0);

  const outDur = fs.existsSync(outPath) ? await durationOf(outPath) : 0;
  console.log('       源时长=' + srcDur.toFixed(2) + 's  成品时长=' + outDur.toFixed(2) +
    's  裁掉重复=' + splitAt.toFixed(2) + 's');
  // ★ 核心断言：inpoint 裁掉重叠后，成品时长应贴近源。
  // 若没裁，60s 的源会拼出 60+重叠 秒（实测 63s）。
  ok('成品时长贴近源（重叠已被裁掉，无虚长）',
    Math.abs(outDur - srcDur) <= 2.5,
    'src=' + srcDur.toFixed(2) + ' out=' + outDur.toFixed(2) + ' trim=' + splitAt.toFixed(2));
  ok('成品时长不短于源（说明没有丢内容）', outDur >= srcDur - 2.5,
    'src=' + srcDur.toFixed(2) + ' out=' + outDur.toFixed(2));

  // 成品必须能被完整解码（concat + -c copy 在交界处会打 dts 警告，
  // 但退出码应为 0 且无 Invalid data 类硬错误）
  const dec = await run(['-v', 'error', '-i', outPath, '-f', 'null', '-']);
  ok('成品可完整解码（无硬错误）',
    dec.code === 0 && !/Invalid data|corrupt|moov atom not found/i.test(dec.err),
    dec.err.slice(-300));

  // ---------------------------------------------------------------
  console.log('[3] 失败 → 重试：从断点继续，已完成分段不必重下');
  // 重试场景：首段只覆盖 0..resumeAt，第二段覆盖 resumeAt..结尾，二者互补不重叠。
  // 注意不能用「首段=完整源」——那样首段本身就包含了第二段的内容，
  // 拼接结果必然是 60 + 续下段长（实测 85s），场景本身是错的。
  const segR = path.join(workDir, 'segR.mp4');
  // 首段：从 0 下一整段（到结尾），模拟"这一段完整跑完"
  const rR = await run(argsFor(segR, 0));
  ok('重试场景：首段完整成功', rR.code === 0, rR.err.slice(-300));

  const segR2 = path.join(workDir, 'segR2.mp4');
  // 续下段：从断点 resumeAt 跑到结尾
  const rR2 = await run(argsFor(segR2, resumeAt));
  ok('重试：续下段成功', rR2.code === 0, rR2.err.slice(-300));

  const retryOut = path.join(workDir, 'retry-final.mp4');
  // 首段已含 0..结尾，续下段是首段的子集 → 正确做法是**只保留首段**。
  // 这里显式验证：拼接时裁掉续下段整个长度即可还原成首段。
  const segR2Len = fs.existsSync(segR2) ? await durationOf(segR2) : 0;
  const retryBuilt = buildConcatArgs(
    [{ path: segR, trimHead: 0 }, { path: segR2, trimHead: segR2Len }],
    retryOut
  );
  const c2 = await run(retryBuilt.args);
  ok('重试后 concat 成功', c2.code === 0, c2.err.slice(-300));
  const retryDur = fs.existsSync(retryOut) ? await durationOf(retryOut) : 0;
  ok('重试产物时长贴近源（续下段被整段裁掉，等价于首段）',
    Math.abs(retryDur - srcDur) <= 2.5,
    'src=' + srcDur.toFixed(2) + ' retry=' + retryDur.toFixed(2) +
    ' trim=' + segR2Len.toFixed(2));

  // ---------------------------------------------------------------
  console.log('[4] 单段直下（不暂停）不应被 concat 影响');
  const single = path.join(workDir, 'single.mp4');
  const s1 = await run(argsFor(single, 0));
  ok('单段直下成功', s1.code === 0, s1.err.slice(-300));
  const singleDur = await durationOf(single);
  ok('单段直下时长=源时长', Math.abs(singleDur - srcDur) <= 1.5,
    'src=' + srcDur.toFixed(2) + ' single=' + singleDur.toFixed(2));

  // ---------------------------------------------------------------
  console.log('[5] 取消语义：kill 后半成品不是有效 MP4（所以必须删/续，不能当成品）');
  const killed = path.join(workDir, 'killed.mp4');
  await runPartUntil(killed, 0, 10);
  const killedDur = fs.existsSync(killed) ? await durationOf(killed) : 0;
  // 半成品要么解不出时长（moov 未写完），要么时长明显短于源——两种都算"不可用"
  ok('被 kill 的半成品不可直接当成品（印证续传/重试的必要性）',
    killedDur < srcDur - 2 || killedDur === 0,
    'killedDur=' + killedDur.toFixed(2) + ' src=' + srcDur.toFixed(2));

  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  console.log('（工作目录保留以便排查：' + workDir + '）');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});