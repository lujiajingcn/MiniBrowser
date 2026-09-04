'use strict';

/**
 * 收藏夹导入/导出：Netscape 书签格式（NETSCAPE-Bookmark-file-1）。
 *
 * 既是 CommonJS 模块（主进程 require 用于导出），也可通过 <script> 标签
 * 直接加载到渲染进程（浏览器上下文无 nodeIntegration），挂到 window.BookmarksIO。
 * 解析/生成逻辑只依赖字符串，不触碰 DOM / electron。
 *
 * 数据模型（树）：
 *   - 根节点与文件夹均为 { type:'folder', title, children:[...] }
 *   - 书签叶子为 { type:'bookmark', title, url }
 *   parseNetscapeBookmarks 返回根文件夹节点；buildNetscapeBookmarks 接收根节点。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BookmarksIO = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 解码 HTML 实体：命名实体 + 十进制/十六进制数字实体
  function decodeEntities(s) {
    if (!s) return '';
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (m, p) => {
      switch (p.toLowerCase()) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return ' ';
        default:
          if (p[0] === '#') {
            const hex = p[1] === 'x' || p[1] === 'X';
            const code = parseInt(p.slice(2), hex ? 16 : 10);
            if (!isNaN(code)) return String.fromCodePoint(code);
          }
          return m;
      }
    });
  }

  function stripTags(s) {
    return s.replace(/<[^>]*>/g, '');
  }

  const KEEP_PROTOCOL = /^(https?:|ftps?:\/\/|\/\/)/i;

  // 把任意存储形态规整成「根文件夹节点」。
  // - 旧版 flat 数组 [{title,url}] -> 根文件夹的直接子节点
  // - 已是文件夹节点 -> 原样返回
  // - 其它/null -> 空根文件夹
  function normalizeRoot(data) {
    if (data && data.type === 'folder') return data;
    const root = { type: 'folder', title: '', children: [] };
    if (Array.isArray(data)) {
      data.forEach((b) => {
        if (b && b.url) {
          root.children.push({ type: 'bookmark', title: b.title || b.url, url: b.url });
        }
      });
    }
    return root;
  }

  /**
   * 解析 Netscape 书签 HTML，返回根文件夹节点（保留嵌套文件夹结构）。
   * @param {string} html
   * @returns {{type:'folder', title:string, children:Array}}
   */
  function parseNetscapeBookmarks(html) {
    const root = { type: 'folder', title: '', children: [] };
    if (!html) return root;
    const stack = [root];
    // 同时捕获：<A HREF> 书签 / <H3> 文件夹 / </DL> 闭合 / <DL> 打开
    const re =
      /<A\b[^>]*\bHREF\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/A>|<H3\b([^>]*)>([\s\S]*?)<\/H3>|<\/DL>|<DL\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1] !== undefined) {
        // 书签：group1=url, group2=标题
        const url = decodeEntities(m[1]).trim();
        const title = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
        if (!url || !KEEP_PROTOCOL.test(url)) continue;
        const parent = stack[stack.length - 1];
        if (!parent.children.some((c) => c.type === 'bookmark' && c.url === url)) {
          parent.children.push({ type: 'bookmark', title: title || url, url });
        }
      } else if (m[3] !== undefined) {
        // 文件夹：group3=属性, group4=标题
        const title = decodeEntities(stripTags(m[4])).replace(/\s+/g, ' ').trim() || '未命名文件夹';
        const folder = { type: 'folder', title, children: [] };
        stack[stack.length - 1].children.push(folder);
        stack.push(folder);
      } else if (m[0].toLowerCase() === '</dl>') {
        if (stack.length > 1) stack.pop();
      }
      // <DL> 打开标签：忽略（文件夹已在 <H3> 时入栈）
    }
    return root;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 把根文件夹节点生成可被 Chrome / Edge / Firefox 导入的 Netscape 书签 HTML。
   * @param {{type:'folder', title?, children:Array}} root
   * @param {string} [rootTitle]
   * @returns {string}
   */
  function buildNetscapeBookmarks(root, rootTitle) {
    root = normalizeRoot(root);
    const addDate = Math.floor(Date.now() / 1000);

    function emit(indent, node) {
      const lines = [];
      (node.children || []).forEach((c) => {
        if (c.type === 'bookmark') {
          const url = escapeHtml(c.url || '');
          const title = escapeHtml(c.title || c.url || '');
          lines.push(indent + '<DT><A HREF="' + url + '" ADD_DATE="' + addDate + '">' + title + '</A>');
        } else {
          const title = escapeHtml(c.title || '未命名文件夹');
          lines.push(indent + '<DT><H3 ADD_DATE="' + addDate + '" LAST_MODIFIED="' + addDate + '">' + title + '</H3>');
          lines.push(indent + '    <DL><p>');
          lines.push(emit(indent + '        ', c));
          lines.push(indent + '    </DL><p>');
        }
      });
      return lines.join('\n');
    }

    const lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Bookmarks</TITLE>');
    lines.push('<H1>' + escapeHtml(rootTitle || 'Bookmarks') + '</H1>');
    lines.push('<DL><p>');
    const body = emit('    ', root);
    if (body) lines.push(body);
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
  }

  // ---------- 树操作纯函数（便于复用与单测） ----------

  /** 收集某个节点下的所有书签叶子（深度优先）。 */
  function flattenBookmarks(node) {
    const out = [];
    (node && node.children ? node.children : []).forEach((c) => {
      if (c.type === 'bookmark') out.push(c);
      else out.push.apply(out, flattenBookmarks(c));
    });
    return out;
  }

  /** 在树中查找首个 url 匹配的书签叶节点（未找到返回 null）。 */
  function findBookmarkByUrl(node, url) {
    if (!url) return null;
    const ch = node && node.children ? node.children : [];
    for (const c of ch) {
      if (c.type === 'bookmark') {
        if (c.url === url) return c;
      } else {
        const f = findBookmarkByUrl(c, url);
        if (f) return f;
      }
    }
    return null;
  }

  /** 从树中删除首个 url 匹配的书签叶节点，返回是否删除成功。 */
  function removeBookmarkByUrl(node, url) {
    if (!url) return false;
    const ch = node && node.children ? node.children : [];
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (c.type === 'bookmark' && c.url === url) {
        ch.splice(i, 1);
        return true;
      }
      if (c.type === 'folder' && removeBookmarkByUrl(c, url)) return true;
    }
    return false;
  }

  /** 统计树中的文件夹数量（不含根）。 */
  function countFolders(node) {
    let n = 0;
    (node && node.children ? node.children : []).forEach((c) => {
      if (c.type === 'folder') n += 1 + countFolders(c);
    });
    return n;
  }

  return {
    parseNetscapeBookmarks,
    buildNetscapeBookmarks,
    normalizeRoot,
    flattenBookmarks,
    findBookmarkByUrl,
    removeBookmarkByUrl,
    countFolders,
    decodeEntities,
    escapeHtml
  };
});
