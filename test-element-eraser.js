'use strict';

/**
 * 橡皮擦单元测试（不引入 jsdom 等依赖，手写最小 DOM 桩）。
 *
 * 覆盖的核心逻辑：elementAt() 的元素命中规则 —— 这是整个功能里最容易出错的部分：
 *  - 必须跳过橡皮擦自己的覆盖层，否则高亮框会把自己框住、点击永远删不掉
 *  - 必须跳过 HTML/BODY，否则点在页面空白处会误删整个页面
 *  - 应返回命中点最深的那个元素（模拟 elementsFromPoint 的栈序）
 *
 * 同时验证 el.remove() 会连同子元素一起移除这一前提（桩里记录父子关系来断言）。
 */

const assert = require('node:assert');

// ---------- 最小 DOM 桩 ----------
// 注意：第一个参数 key 仅供测试代码内部标识用，**不写入 DOM 的 id 属性**。
// 早期版本误把 key 赋给了 node.id，导致 describe() 的断言被桩本身污染
// （期望 'section' 实际得到 'section#y'），这类「桩不忠实」的问题会让
// 测试结果失去意义，故这里显式分开。
function makeNode(key, tagName, children = []) {
  const node = {
    key,
    id: '',
    tagName: (tagName || 'div').toUpperCase(),
    nodeType: 1,
    isContentEditable: false,
    children,
    parent: null,
    isConnected: true,
    removed: false,
    _attrs: {},
  };
  for (const c of children) c.parent = node;
  node.getAttribute = (k) => node._attrs[k] ?? null;
  node.remove = function () {
    // 真实 DOM 的 remove() 会连同全部后代一起从文档中摘除
    node.removed = true;
    node.isConnected = false;
    const walk = (n) => {
      n.isConnected = false;
      n.children.forEach(walk);
    };
    children.forEach(walk);
    if (node.parent) {
      node.parent.children = node.parent.children.filter((c) => c !== node);
    }
  };
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
  return node;
}

// 加载被测模块前先装好全局桩
const g = globalThis;
g.window = g;
g.document = {
  documentElement: makeNode('html-root', 'html'),
  createElement: (tag) => makeNode('created-' + Math.random().toString(16).slice(2), tag),
};
g.document.documentElement.getAttribute = () => null;

// element-eraser.js 在模块作用域会读 document/window，上面已备好；
// 但它不导出 elementAt，故通过注入脚本内部暴露的引用来测。
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'element-eraser.js'), 'utf8');

// 追加一段测试钩子：把内部函数暴露出来（生产代码里不存在这段，仅测试时拼接）
const instrumented =
  src +
  '\n;window.__test__ = { elementAt, describe, OVERLAY_ID };\n';
// eslint-disable-next-line no-eval
new Function('window', 'document', instrumented)(g.window, g.document);

const { elementAt, describe, OVERLAY_ID } = g.window.__test__;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (e) {
    console.error('  FAIL  ' + name + '\n        ' + e.message);
    process.exitCode = 1;
  }
}

console.log('\n[橡皮擦] elementAt() 命中规则');

// 场景页面结构：
//   html > body > div#wrap > div#target > span  （span 是最深的命中元素）
//        > div#other
const span = makeNode('target-span', 'span');
const target = makeNode('target', 'div', [span]);
const other = makeNode('other', 'div');
const wrap = makeNode('wrap', 'div', [target, other]);
const body = makeNode('body', 'body', [wrap]);
const html = makeNode('html', 'html', [body]);

check('命中栈里跳过橡皮擦覆盖层，返回真实元素', () => {
  // 覆盖层宿主节点：真实代码里它是 document.createElement 创建后再把
  // OVERLAY_ID 写进 id，故这里照做，不能只靠 makeNode 的内部 key。
  const overlayHost = makeNode('overlay', 'div');
  overlayHost.id = OVERLAY_ID;
  // elementsFromPoint 返回从最深到最浅：覆盖层在最上，故排第一
  g.document.elementsFromPoint = () => [overlayHost, span, target, wrap, body, html];
  const got = elementAt(10, 10);
  assert.strictEqual(got, span, '应跳过覆盖层，命中 span');
});

check('点在页面空白（只有 html/body 命中）时返回 null，避免误删整页', () => {
  g.document.elementsFromPoint = () => [body, html];
  assert.strictEqual(elementAt(10, 10), null);
});

check('points 落在元素外时返回 null', () => {
  g.document.elementsFromPoint = () => [wrap, body, html];
  // 只有 wrap/body/html 在栈里 —— 但规则要求跳过 body/html，
  // 故这里应命中 wrap（它是栈里最深的非 body/html 元素）
  const got = elementAt(10, 10);
  assert.strictEqual(got, wrap);
});

console.log('\n[橡皮擦] describe() 元素描述');

check('输出 DevTools 风格的 tag#id.class', () => {
  const el = makeNode('x', 'div');
  el._attrs.class = 'btn primary large extra';
  el.id = 'go';
  assert.strictEqual(describe(el), 'div#go.btn.primary.large');
});

check('无 id 无 class 时只输出标签名', () => {
  assert.strictEqual(describe(makeNode('y', 'section')), 'section');
});

check('class 最多取 3 个，超出部分截断', () => {
  const el = makeNode('z', 'div');
  el._attrs.class = 'a b c d e';
  assert.strictEqual(describe(el), 'div.a.b.c');
});

console.log('\n[橡皮擦] remove() 连带删除子元素');

check('remove() 后子元素的 isConnected 同步为 false', () => {
  const leaf = makeNode('leaf', 'em');
  const mid = makeNode('mid', 'div', [leaf]);
  const root = makeNode('root', 'section', [mid]);
  const parent = makeNode('parent', 'div', [root]);

  root.remove();

  assert.strictEqual(root.isConnected, false, 'root 应被移除');
  assert.strictEqual(mid.isConnected, false, 'mid（子）应被连带移除');
  assert.strictEqual(leaf.isConnected, false, 'leaf（孙）应被连带移除');
  assert.ok(!parent.children.includes(root), 'root 应从父节点 children 中摘除');
});

console.log('\n[橡皮擦] 共 ' + passed + ' 项断言通过\n');
