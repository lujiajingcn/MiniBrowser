'use strict';

/**
 * 窗口拖动边界约束的单测（纯逻辑，无需 Electron）。
 *
 * 关键行为：窗口比屏幕窄时，**必须完全限制在屏幕内**。
 * 这直接关系到「按住 Alt 拖动时窗口不断变大」——
 * 窗口大部分跑出屏幕后，鼠标与窗口边缘错位，
 * 鼠标会落到 Chromium 为 frame:false 窗口保留的不可见 resize 边框上。
 */

const { computePositionLimits, clampPosition } = require('./window-bounds');

let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) pass++;
  else fails.push(msg);
}

// ---------- 场景 1：窗口比屏幕小（常见情况） ----------
{
  const area = { x: 0, y: 0, width: 2560, height: 1392 };
  const bounds = { width: 1000, height: 820 };
  const L = computePositionLimits(area, bounds);

  ok(L.minX === 0, '1: 窗口比屏幕窄时 minX 应为 0，实际 ' + L.minX);
  ok(L.maxX === 1560, '1: 窗口比屏幕窄时 maxX 应为 2560-1000=1560，实际 ' + L.maxX);
  ok(L.minY === 0, '1: 窗口比屏幕矮时 minY 应为 0，实际 ' + L.minY);
  ok(L.maxY === 572, '1: 窗口比屏幕矮时 maxY 应为 1392-820=572，实际 ' + L.maxY);

  // 关键回归：旧实现下窗口可以移到 x=2480，右边缘超出屏幕 920px
  const far = clampPosition(L, 99999, 99999);
  ok(far.x === 1560, '1: 拖到极右应被夹到 1560，实际 ' + far.x);
  ok(far.x + bounds.width <= area.width,
    '1: 窗口右边缘不应超出屏幕（实际 ' + (far.x + bounds.width) + ' > ' + area.width + '）');
  ok(far.y === 572, '1: 拖到极下应被夹到 572，实际 ' + far.y);
  ok(far.y + bounds.height <= area.height,
    '1: 窗口下边缘不应超出屏幕（实际 ' + (far.y + bounds.height) + ' > ' + area.height + '）');

  const left = clampPosition(L, -99999, -99999);
  ok(left.x === 0, '1: 拖到极左应被夹到 0，实际 ' + left.x);
  ok(left.y === 0, '1: 拖到极上应被夹到 0，实际 ' + left.y);

  // 中间位置不应被改动
  const mid = clampPosition(L, 500, 300);
  ok(mid.x === 500 && mid.y === 300, '1: 中间位置不应被夹动，实际 ' + JSON.stringify(mid));
}

// ---------- 场景 2：非零原点的第二块显示器 ----------
{
  const area = { x: 1920, y: 0, width: 1280, height: 1024 };
  const bounds = { width: 800, height: 600 };
  const L = computePositionLimits(area, bounds);
  ok(L.minX === 1920, '2: 第二屏 minX 应为 1920，实际 ' + L.minX);
  ok(L.maxX === 2400, '2: 第二屏 maxX 应为 1920+1280-800=2400，实际 ' + L.maxX);

  const far = clampPosition(L, 5000, 5000);
  ok(far.x === 2400, '2: 拖到极右应被夹到 2400，实际 ' + far.x);
  ok(far.x + bounds.width <= area.x + area.width,
    '2: 窗口右边缘不应超出第二屏，实际 ' + (far.x + bounds.width));
}

// ---------- 场景 3：窗口比屏幕大（装不下） ----------
{
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const bounds = { width: 2000, height: 1000 };
  const L = computePositionLimits(area, bounds);
  // 装不下时退回「保留 visibleW 可见」
  ok(L.minX === 80 - 2000, '3: 装不下时 minX 应为 area.x+80-width，实际 ' + L.minX);
  ok(L.maxX === 1280 - 80, '3: 装不下时 maxX 应为 area.x+area.width-80，实际 ' + L.maxX);
  ok(L.minY === 40 - 1000, '3: 装不下时 minY 应为 area.y+40-height，实际 ' + L.minY);
  ok(L.maxY === 720 - 40, '3: 装不下时 maxY 应为 area.y+area.height-40，实际 ' + L.maxY);

  const far = clampPosition(L, 99999, 99999);
  ok(far.x === 1200, '3: 装不下时仍应夹到 1200，实际 ' + far.x);
  // 至少还有 80px 在屏幕内
  ok(far.x < area.width, '3: 装不下时窗口左侧仍应有可见部分，实际 x=' + far.x);
}

// ---------- 场景 4：恰好等于屏幕尺寸 ----------
{
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const bounds = { width: 1000, height: 700 };
  const L = computePositionLimits(area, bounds);
  ok(L.minX === 0 && L.maxX === 0, '4: 窗口等于屏幕时 x 应固定为 0，实际 ' + JSON.stringify(L));
  ok(L.minY === 0 && L.maxY === 0, '4: 窗口等于屏幕时 y 应固定为 0，实际 ' + JSON.stringify(L));
}

console.log('\n==== 窗口拖动边界约束 单测 ====');
console.log('  通过 ' + pass + ' 项');
if (fails.length) {
  console.error('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.error('  X ' + f));
  process.exitCode = 1;
} else {
  console.log('\n全部通过：窗口比屏幕小时完全限制在屏幕内，不再有窗口跑出屏幕导致 resize 的风险。');
}
