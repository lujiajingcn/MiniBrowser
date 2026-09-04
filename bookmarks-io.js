'use strict';

/**
 * 收藏夹导入/导出：Netscape 书签格式（NETSCAPE-Bookmark-file-1）。
 *
 * 既是 CommonJS 模块（主进程 require 用于导出），也可通过 <script> 标签
 * 直接加载到渲染进程（浏览器上下文无 nodeIntegration），挂到 window.BookmarksIO。
 * 解析/生成逻辑只依赖字符串，不触碰 DOM / electron。
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

  /**
   * 解析 Netscape 书签 HTML，提取所有 <A HREF="...">title</A> 链接。
   * @param {string} html 书签文件文本
   * @returns {Array<{title:string, url:string}>} 扁平收藏夹列表（按 url 去重）
   */
  function parseNetscapeBookmarks(html) {
    if (!html) return [];
    const out = [];
    const seen = new Set();
    const re = /<A\b[^>]*\bHREF\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/A>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = decodeEntities(m[1]).trim();
      const title = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
      if (!url || !KEEP_PROTOCOL.test(url)) continue; // 跳过 place:/javascript:/data: 等
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: title || url, url });
    }
    return out;
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
   * 把扁平收藏夹列表生成可被 Chrome / Edge / Firefox 导入的 Netscape 书签 HTML。
   * @param {Array<{title:string, url:string}>} bookmarks
   * @param {string} [rootTitle]
   * @returns {string}
   */
  function buildNetscapeBookmarks(bookmarks, rootTitle) {
    const addDate = Math.floor(Date.now() / 1000);
    const lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Bookmarks</TITLE>');
    lines.push('<H1>' + escapeHtml(rootTitle || 'Bookmarks') + '</H1>');
    lines.push('<DL><p>');
    (bookmarks || []).forEach((bm) => {
      const url = escapeHtml(bm.url || '');
      const title = escapeHtml(bm.title || bm.url || '');
      lines.push('    <DT><A HREF="' + url + '" ADD_DATE="' + addDate + '">' + title + '</A>');
    });
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
  }

  return { parseNetscapeBookmarks, buildNetscapeBookmarks, decodeEntities, escapeHtml };
});
