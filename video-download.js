'use strict';

/**
 * 视频下载（独立模块，便于生产入口与诊断脚本复用同一份实现）。
 *
 * 设计要点：
 *  - 所有视频统一经 ffmpeg 拉取并封装为 MP4（HLS 用 -c copy 转封装，无损且快；
 *    直链 mp4/webm 等也走 ffmpeg，保证最终产物是 .mp4）。
 *  - ffmpeg 不存在时（未装 ffmpeg-static / 系统无 ffmpeg）给出明确提示，不崩溃。
 *  - 代理：从 session 解析目标地址的代理（用户机器走代理时，ffmpeg 直接拉会失败），
 *    把代理注入 ffmpeg 的环境变量与 -http_proxy 参数。
 *  - 事件复用现有下载面板通道 'mb-download'，并打上 kind:'video' 以便渲染层区分。
 *
 * 【暂停 / 恢复 / 重试的实现方式】
 * ffmpeg 是我们自己 spawn 的子进程：Windows 上没有 SIGSTOP，ffmpeg 拉流时自己管 HTTP 连接，
 * 也无法从外部注入 Range 头。所以「暂停」只能是**杀进程 + 记住所下载到的秒数 + 恢复时用
 * 输入侧 -ss 从该秒数续下**。
 *
 * 【为什么暂停时丢弃当前分段，而不是留作续传】
 * 被 SIGTERM 打断的 ffmpeg **写不出可用的 MP4**：moov box 是 ffmpeg 收尾时才写的，
 * 即使加 `-movflags +frag_keyframe+empty_moov`（分片 MP4，moov 一开始就写）也一样——
 * 实测被打断后仍报 `moov atom not found`，文件只有几十字节。半成品既不能播放也不能拼接，
 * 留着只会在下载目录里变成垃圾。
 *
 * 所以语义是：
 *   暂停 = 记下断点秒数 + 丢弃当前半成品分段
 *   恢复 = 从断点秒数重新下载（该段会重下，但已完成的更早分段不重下）
 *   完成 = concat 全部分段 → 最终 .mp4
 *
 * 代价：暂停点所在的那一段要重下一次。因此**分段粒度**决定重下的代价，
 * 而 ffmpeg 无法在下载中途"干净地结束一段"，所以本实现只在「暂停 / 失败重试」时
 * 才产生多个分段——一次跑到底的下载永远只有一个分段，零额外开销。
 *
 * 任务状态（rec.state）：
 *   progressing 下载中 / paused 已暂停 / completed 完成 / interrupted 失败 / cancelled 已取消
 * 失败时**已完成的分段保留**，用户点「重试」从断点继续，不从头再来。
 */

const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { getSetting } = require('./settings-store');
const { uniquePath } = require('./downloads');
const {
  safeBaseName,
  parseProxyResult,
  withScheme,
  buildFfmpegArgs,
  buildConcatArgs,
  resumePointFrom,
  ffmpegCandidates
} = require('./video-ffmpeg');

/**
 * id -> 任务记录。完成/取消后不立即删除：面板上的「打开 / 打开文件夹」还要用，
 * 且失败态要留着分段供「重试」。进程退出时随 ipcMain 生命周期一起回收。
 */
const active = new Map();

/**
 * 解析 ffmpeg 可执行文件路径，优先级：
 *   ① 设置项 ffmpegPath（userData/settings.json，可由用户自定义）
 *   ② 环境变量 MB_FFMPEG
 *   ③ ffmpeg-static（随 npm 安装，随应用分发）
 *   ④ 常见安装目录（Windows 含 D:\ffmpeg\ffmpeg.exe；类 Unix 含 /usr/local/bin 等）
 *   ⑤ 兜底 'ffmpeg'，交给 PATH 解析
 * 找不到时返回 'ffmpeg'，由 spawn 抛 ENOENT 并在下载面板给出明确提示（不崩溃）。
 */
function findFfmpeg() {
  const isFile = (p) => {
    try {
      return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
    } catch (_) {
      return false;
    }
  };

  const list = [];
  // ① 显式配置（设置项）
  try {
    const configured = getSetting('ffmpegPath');
    if (configured) list.push(configured);
  } catch (_) {
    /* settings 不可用时忽略 */
  }
  // ② 环境变量
  if (process.env && process.env.MB_FFMPEG) list.push(process.env.MB_FFMPEG);
  // ③ 随应用分发的 ffmpeg-static
  try {
    const p = require('ffmpeg-static');
    if (p) list.push(p);
  } catch (_) {
    /* 未安装 ffmpeg-static */
  }
  // ④⑤ 常见安装目录 + PATH 兜底
  ffmpegCandidates(process.platform).forEach((p) => list.push(p));

  for (let i = 0; i < list.length; i++) {
    if (list[i] !== 'ffmpeg' && isFile(list[i])) return list[i];
  }
  return 'ffmpeg';
}

function downloadDir() {
  return getSetting('downloadDir') || app.getPath('downloads');
}

function send(win, payload) {
  if (win && win.webContents && !win.isDestroyed()) {
    win.webContents.send('mb-download', payload);
  }
}

/** 分段文件路径：成品名.mp4 → 成品名.mp4.part-1.mp4（与成品同目录，便于原子改名）。 */
function partPathOf(savePath, index) {
  const ext = path.extname(savePath) || '.mp4';
  const base = savePath.slice(0, savePath.length - ext.length);
  return base + '.part-' + index + ext;
}

async function startVideoDownload(event, descriptor) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const url = descriptor && descriptor.url;
  if (!url) return { ok: false, error: '缺少视频地址' };

  const dir = downloadDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const outName = safeBaseName(descriptor.title, 'video') + '.mp4';
  const savePath = uniquePath(dir, outName);

  const id = 'vid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  active.set(id, {
    id,
    win,
    url,
    savePath,
    descriptor,
    proxy: '',
    state: 'progressing',
    // 已完成的分段（按序）。元素为 { path, trimHead }：
    // trimHead = 该段开头与上一段末尾重叠的秒数，拼接时用 inpoint 裁掉。
    parts: [],
    // 当前正在写的分段序号（0 起）
    partIndex: 0,
    // 上一段累计下载到的秒数，作为下一段的 -ss 起点
    downloadedSeconds: 0,
    // 已完成的分段覆盖到源时间轴的末尾秒数。暂停/失败时断点要回退到这里
    // （当前段的半成品已被丢弃，那部分内容并不存在）。
    partsEndSeconds: 0,
    // 当前分段的绝对起始秒数（用于把分段内进度换算成整体进度）
    partStartSeconds: 0,
    // 已探到的总时长（秒），0 = 未知
    duration: 0,
    // 是否已经尝试过「转封装 → 重编码」降级（降级只在第一次失败时做一次）
    triedReencode: false,
    child: null,
    // 合并阶段（concat）也会用到 child，用阶段标记区分
    merging: false
  });

  send(win, {
    type: 'added',
    id,
    filename: path.basename(savePath),
    savePath,
    url,
    totalBytes: 0,
    kind: 'video'
  });

  // 解析代理（用户机器走代理时 ffmpeg 直连会失败）
  let proxy = '';
  try {
    const resolved = await session.defaultSession.resolveProxy(url);
    proxy = parseProxyResult(resolved);
  } catch (_) {
    /* 解析失败则不使用代理 */
  }
  const rec = active.get(id);
  if (rec) rec.proxy = proxy;

  runFfmpeg(id);
  return { ok: true, id };
}

/** 当前是否已有可用的分段（用于判断能否续传）。 */
function hasParts(rec) {
  return !!(rec && rec.parts && rec.parts.length);
}

/** 删除单个分段文件（忽略失败）。 */
function unlinkQuiet(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

/** 删除任务的全部分段（取消 / 彻底失败时用；重试时**不**删）。 */
function clearParts(rec) {
  if (!rec || !rec.parts) return;
  rec.parts.forEach((p) => unlinkQuiet(typeof p === 'string' ? p : p.path));
  rec.parts = [];
}

/**
 * 启动（或继续）一次下载。
 *
 * @param {string} id
 * @param {object} [opts]
 *   attempt：第几次尝试。首次用 -c copy 直接转封装；失败后降级为重编码再试一次
 *     （见 buildFfmpegArgs 的 reencode 选项），保证最终产物仍是 MP4。
 *   startSeconds：本段在源时间轴上的起点，缺省取 rec.partStartSeconds。
 */
function runFfmpeg(id, opts) {
  const rec = active.get(id);
  if (!rec) return; // 已被取消 / 已清理
  const options = opts || {};
  const ffmpeg = findFfmpeg();

  // 续传起点：有已完成分段时，从上一段断点回退 SEEK_OVERLAP 秒接上；
  // 没有分段（首次或重试）则从 0 开始。
  const startSeconds = hasParts(rec) ? resumePointFrom(rec.downloadedSeconds) : 0;
  rec.partStartSeconds = startSeconds;
  // 本段开头与上一段末尾重叠多少秒（拼接时用 inpoint 裁掉重复的头部）
  rec.partTrimHead = hasParts(rec) ? Math.max(0, rec.downloadedSeconds - startSeconds) : 0;

  // 当前分段的目标路径：首次下载直接写成品路径（零额外拷贝）；
  // 一旦发生过中断/续传，各分段写各自的 .part-N.mp4，最后再 concat。
  const outPath = hasParts(rec) ? partPathOf(rec.savePath, rec.partIndex) : rec.savePath;
  rec.currentPath = outPath;

  const reencode = !!options.reencode || rec.triedReencode;
  const args = buildFfmpegArgs(rec.url, outPath, rec.descriptor, rec.proxy, {
    reencode,
    startSeconds
  });

  const env = Object.assign({}, process.env);
  if (rec.proxy) {
    const ph = withScheme(rec.proxy);
    env.HTTP_PROXY = ph;
    env.HTTPS_PROXY = ph;
    env.http_proxy = ph;
    env.https_proxy = ph;
  }

  let child;
  try {
    child = spawn(ffmpeg, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    finishError(id, '无法启动 ffmpeg：' + (e && e.message), false);
    return;
  }
  rec.child = child;
  // 重入保护：一次 runFfmpeg 内 'error' 与 'close' 可能都触发，只结算一次
  rec.settled = false;
  // 本段是否因「暂停」而被主动杀掉——暂停不是失败，分段要保留供下次拼接
  rec.stoppedByUser = false;

  // spawn 返回的进程若可执行文件不存在，会触发 'error' 而非 'close'
  child.on('error', (err) => {
    if (rec.settled) return;
    rec.settled = true;
    const msg =
      /ENOENT/.test((err && err.code) || '') || /ffmpeg/.test(String(err && err.message))
        ? '未找到 ffmpeg（可安装 ffmpeg-static、把 ffmpeg.exe 放到 D:\\ffmpeg、加入 PATH，或用环境变量 MB_FFMPEG 指定完整路径）'
        : '启动 ffmpeg 失败：' + (err && err.message);
    // ENOENT = ffmpeg 不存在，重试也没用 → 连分段一起清
    finishError(id, msg, !(err && err.code === 'ENOENT'));
  });

  let duration = 0;
  child.stderr.on('data', (buf) => {
    const txt = buf.toString();
    const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (dm) {
      duration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
      if (duration > 0) rec.duration = duration;
    }
    const tm = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
    if (tm) {
      const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
      // 分段内的 t 是**相对本段起点**的时间，换算成源时间轴上的绝对秒数
      const absolute = rec.partStartSeconds + t;
      if (absolute > rec.downloadedSeconds) rec.downloadedSeconds = absolute;
      const total = rec.duration || duration;
      if (total > 0) {
        const pct = Math.min(100, Math.round((absolute / total) * 100));
        send(rec.win, {
          type: 'updated',
          id,
          pct,
          state: 'progressing',
          receivedBytes: 0,
          totalBytes: 0,
          kind: 'video'
        });
      }
    }
  });

  child.on('close', (code) => {
    if (rec.settled) return;
    rec.settled = true;
    rec.child = null;
    const cur = active.get(id);
    if (!cur) return; // 用户已取消：cancel 分支已删除记录
    if (cur.stoppedByUser) return; // 暂停：pause 分支已结算

    const exists = (() => {
      try {
        return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
      } catch (_) {
        return false;
      }
    })();

    // 【暂停路径】本段被用户主动中断。
    // 半成品没有 moov（见文件头说明），必须丢弃。关键：**断点要回退到最后一个已完成
    // 分段的末尾**——本段下到的那部分内容已经随着半成品一起删了，若把断点留在
    // downloadedSeconds（半成品的位置），恢复后 ffmpeg 会从那里续下，凭空丢掉中间一段。
    if (cur.pendingPause) {
      cur.pendingPause = false;
      unlinkQuiet(outPath);
      cur.partIndex = cur.parts.length;
      // 断点 = 最后一个已完成分段覆盖到的位置；没有分段则从头开始
      cur.downloadedSeconds = hasParts(cur) ? cur.partsEndSeconds : 0;
      const pct =
        cur.duration > 0 ? Math.min(100, Math.round((cur.downloadedSeconds / cur.duration) * 100)) : 0;
      send(cur.win, { type: 'updated', id, pct, state: 'paused', paused: true, kind: 'video' });
      cur.state = 'paused';
      return;
    }

    if (code === 0 && exists) {
      // 本段完整跑完：登记为分段（连同它开头要裁掉的重叠秒数），随后交给 concat 收尾
      cur.parts.push({ path: outPath, trimHead: cur.partTrimHead || 0 });
      // 本段覆盖到源时间轴的 absolute 秒（用进度条最后报到的位置；取整避免浮点毛刺）
      cur.partsEndSeconds = Math.max(cur.partsEndSeconds || 0, Math.round(cur.downloadedSeconds));
      concatParts(id);
      return;
    }

    // 失败：清掉本段的半成品（已完成的分段保留，供「重试」续传）
    unlinkQuiet(outPath);
    cur.partIndex = cur.parts.length;
    // 同暂停：断点回退到最后已完成分段的末尾（半成品内容已丢弃）
    cur.downloadedSeconds = hasParts(cur) ? cur.partsEndSeconds : 0;

    // 首次失败 → 降级为「重编码」再试一次（应对 webm/VP9+Opus 等无法 -c copy 进 MP4 的源）
    if (!cur.triedReencode) {
      cur.triedReencode = true;
      send(cur.win, {
        type: 'updated',
        id,
        pct: 0,
        state: 'progressing',
        kind: 'video',
        note: '直接转封装失败，正在转码重试'
      });
      runFfmpeg(id, { reencode: true });
      return;
    }

    // 重编码也失败：记为 interrupted，**保留已完成分段**，用户可点「重试」从断点继续
    send(cur.win, {
      type: 'done',
      id,
      state: 'interrupted',
      kind: 'video',
      error: 'ffmpeg 退出码 ' + code + (hasParts(cur) ? '（已下载的分段已保留，可点重试继续）' : '（可能该地址需要登录态/签名，或 ffmpeg 未安装）')
    });
    cur.state = 'interrupted';
  });
}

/**
 * 把已下载的全部分段拼成最终 .mp4，然后清理分段文件。
 * 只有 1 个分段时直接改名（省掉一次无意义的 concat 拷贝）。
 */
function concatParts(id) {
  const rec = active.get(id);
  if (!rec) return;

  if (rec.parts.length === 1) {
    const only = rec.parts[0].path;
    try {
      if (only !== rec.savePath) fs.renameSync(only, rec.savePath);
    } catch (e) {
      // 成品都落不了盘，分段留着也没用（而且会变成下载目录里的垃圾）
      finishError(id, '重命名成品失败：' + (e && e.message), false);
      return;
    }
    completeDownload(id);
    return;
  }

  const ffmpeg = findFfmpeg();
  let built;
  try {
    // 每段登记时已记下自己的 trimHead（与上一段重叠的秒数），拼接时用 inpoint 裁掉，
    // 否则重叠部分会让成品时长一段段虚长（实测 60s 源拼出 63s）。
    built = buildConcatArgs(rec.parts, rec.savePath, { reencode: rec.triedReencode });
  } catch (e) {
    // 成品都落不了盘，分段留着也没用（而且会变成下载目录里的垃圾）
    finishError(id, '拼接参数构造失败：' + (e && e.message), false);
    return;
  }

  send(rec.win, {
    type: 'updated',
    id,
    pct: 99,
    state: 'progressing',
    kind: 'video',
    note: '正在合并分段'
  });

  const env = Object.assign({}, process.env);
  let child;
  try {
    // concat filter：分段作为多个 -i 输入，无需清单文件/stdin
    child = spawn(ffmpeg, built.args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    finishError(id, '无法启动 ffmpeg 合并分段：' + (e && e.message), false);
    return;
  }
  rec.child = child;
  rec.merging = true;

  let settled = false;
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    rec.merging = false;
    finishError(id, '合并分段失败：' + (err && err.message));
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    rec.merging = false;
    rec.child = null;
    const okSize = (() => {
      try {
        return fs.existsSync(rec.savePath) && fs.statSync(rec.savePath).size > 0;
      } catch (_) {
        return false;
      }
    })();
    if (code === 0 && okSize) {
      completeDownload(id);
      return;
    }
    unlinkQuiet(rec.savePath);
    finishError(id, '合并分段失败（ffmpeg 退出码 ' + code + '），已下载的分段仍保留，可点重试');
  });
}

/** 收尾成功：清分段、发 done。 */
function completeDownload(id) {
  const rec = active.get(id);
  if (!rec) return;
  clearParts(rec);
  rec.state = 'completed';
  send(rec.win, { type: 'done', id, state: 'completed', kind: 'video', savePath: rec.savePath });
}

/**
 * 硬失败：标记 interrupted。
 *
 * @param {boolean} [keepParts=true]
 *   是否保留已完成分段。默认保留——用户点「重试」能从断点继续，不必从头再下一遍。
 *   只有「找不到 ffmpeg / 无法启动进程」这类重试也没用的场景才传 false 连分段一起清掉。
 */
function finishError(id, message, keepParts) {
  const rec = active.get(id);
  if (!rec) return;
  const keep = keepParts !== false;
  if (!keep) {
    clearParts(rec);
    unlinkQuiet(rec.currentPath);
    unlinkQuiet(rec.savePath);
  }
  rec.state = 'interrupted';
  send(rec.win, {
    type: 'done',
    id,
    state: 'interrupted',
    kind: 'video',
    error: keep ? message : message + '（重试同样会失败，请先修好 ffmpeg）'
  });
}

function setupVideoDownloads() {
  ipcMain.handle('mb-download-video', (event, descriptor) => startVideoDownload(event, descriptor));

  ipcMain.on('mb-video-action', (event, payload) => {
    const id = payload && payload.id;
    const action = payload && payload.action;
    const rec = active.get(id);
    if (!rec) return;
    try {
      if (action === 'pause') {
        pauseDownload(id);
      } else if (action === 'resume') {
        resumeDownload(id);
      } else if (action === 'retry') {
        retryDownload(id);
      } else if (action === 'cancel') {
        cancelDownload(id);
      } else if (action === 'open') {
        if (rec.savePath) shell.openPath(rec.savePath);
      } else if (action === 'folder') {
        if (rec.savePath) shell.showItemInFolder(rec.savePath);
      }
    } catch (_) {
      /* ignore */
    }
  });
}

/**
 * 暂停：杀掉当前 ffmpeg 分段进程，把已写出的内容留作分段。
 * 合并阶段（merging）不接受暂停——那时已经是本地文件操作，几秒内就结束，点了反而语义混乱。
 */
function pauseDownload(id) {
  const rec = active.get(id);
  if (!rec) return;
  if (rec.merging) {
    send(rec.win, { type: 'updated', id, state: 'progressing', kind: 'video', note: '正在合并分段，请稍候' });
    return;
  }
  if (rec.state !== 'progressing' || !rec.child) return;

  rec.pendingPause = true;
  rec.stoppedByUser = true;
  rec.state = 'paused';
  if (rec.child) rec.child.kill('SIGTERM');
}

/**
 * 恢复 / 重试：从最后一个分段的断点继续（输入侧 -ss），下出新的一段，最后统一 concat。
 *
 * 两个入口共用一段实现，区别只在允许的起始状态：
 *  - resume 来自 paused；
 *  - retry 来自 interrupted（失败），并额外把「已试过重编码」标记复位——
 *    网络抖动导致的失败不该被永久锁死在重编码路径上。
 *
 * 若一个分段都没成功（暂停得太早），等价于从头开始。
 */
function continueDownload(id, fromState) {
  const rec = active.get(id);
  if (!rec) return;
  if (rec.state !== fromState) return;

  if (fromState === 'interrupted' && hasParts(rec)) {
    rec.triedReencode = false;
  }

  rec.pendingPause = false;
  rec.stoppedByUser = false;
  rec.state = 'progressing';
  rec.partIndex = rec.parts.length;

  send(rec.win, {
    type: 'updated',
    id,
    pct: rec.duration > 0 ? Math.min(100, Math.round((rec.downloadedSeconds / rec.duration) * 100)) : 0,
    state: 'progressing',
    paused: false,
    kind: 'video'
  });
  runFfmpeg(id);
}

function resumeDownload(id) {
  continueDownload(id, 'paused');
}

function retryDownload(id) {
  continueDownload(id, 'interrupted');
}

function cancelDownload(id) {
  const rec = active.get(id);
  if (!rec) return;
  clearParts(rec);
  unlinkQuiet(rec.currentPath);
  unlinkQuiet(rec.savePath);
  rec.state = 'cancelled';
  if (rec.child) rec.child.kill('SIGTERM');
  send(rec.win, { type: 'done', id, state: 'cancelled', kind: 'video' });
}

module.exports = { setupVideoDownloads, startVideoDownload };