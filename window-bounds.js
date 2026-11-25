'use strict';

/**
 * 窗口拖动的边界约束计算（纯逻辑，不依赖 electron，可直接 Node 单测）。
 *
 * 单独成文件的原因：window-drag.js 顶层 require('electron')，
 * 在纯 Node 环境下拿到的是路径字符串而非模块对象，解构会抛错，
 * 导致约束逻辑无法被单元测试覆盖。
 */

/**
 * 计算窗口在屏幕内允许的位置范围。
 *
 * @param {{x:number,y:number,width:number,height:number}} area 显示器工作区
 * @param {{width:number,height:number}} bounds 当前窗口尺寸
 * @returns {{minX:number,maxX:number,minY:number,maxY:number}} 允许的位置范围
 */
function computePositionLimits(area, bounds) {
  // 至少保留80px宽、40px 高可见
  const visibleW = Math.min(80, bounds.width);
  const visibleH = Math.min(40, bounds.height);

  // 【窗口比屏幕窄/矮时：完全限制在屏幕内】
  // 原实现一律用「保留 visibleW 可见」推导边界，于是
  //   maxX = area.x + area.width - visibleW
  // 在屏幕宽 2560、窗口宽 1000 时，窗口可以移到 x = 2480，
  // 此时窗口右边缘在 3480 —— **超出屏幕 920px**，只剩左边 80px 可见。
  //
  // 窗口大部分在屏幕外时，鼠标与窗口边缘严重错位，
  // 鼠标很容易落到 Chromium 为 frame:false 窗口保留的
  // **不可见 resize 边框**上 —— 拖动于是变成 resize，
  // 表现为「按住 Alt 拖动过程中，窗口不断变大」。
  //
  // 【窗口比屏幕大时：才退回「保留 visibleW 可见」】
  // 这种情况下窗口本来就装不下，只能保证还有一条边能被抓住。
  const fitsHorizontally = bounds.width <= area.width;
  const fitsVertically = bounds.height <= area.height;

  return {
    minX: fitsHorizontally ? area.x : area.x + visibleW - bounds.width,
    maxX: fitsHorizontally ? area.x + area.width - bounds.width
      : area.x + area.width - visibleW,
    minY: fitsVertically ? area.y : area.y + visibleH - bounds.height,
    maxY: fitsVertically ? area.y + area.height - bounds.height
      : area.y + area.height - visibleH,
  };
}

/** 把目标位置夹到允许范围内。 */
function clampPosition(limits, targetX, targetY) {
  return {
    x: Math.round(
      Math.min(Math.max(targetX, limits.minX), Math.max(limits.minX, limits.maxX))
    ),
    y: Math.round(
      Math.min(Math.max(targetY, limits.minY), Math.max(limits.minY, limits.maxY))
    ),
  };
}

module.exports = { computePositionLimits, clampPosition };
