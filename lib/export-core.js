/**
 * 导出入口 Module：校验格式、统一会话命名，并分派 Markdown 或完整 JSON。
 */
(function publishExportCore(root, createExportCore) {
  const isCommonJs = typeof module === 'object' && module.exports;
  const markdownExport = isCommonJs
    ? require('./markdown-export.js')
    : root.DeepSeekMarkdownExport;
  const core = createExportCore(markdownExport);

  if (isCommonJs) {
    module.exports = core;
  } else {
    root.DeepSeekExportCore = core;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createExportCore(markdownExport) {
  'use strict';

  if (!markdownExport) throw new Error('Markdown 导出模块加载失败');

  const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,}$/;
  const DEFAULT_MARKDOWN_OPTIONS = Object.freeze({
    includeThinking: true,
    includeSearch: true,
    branchMode: 'latest',
  });

  function parseShareId(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (SHARE_ID_PATTERN.test(value)) return value;

    let url;
    try {
      if (value.startsWith('/')) {
        url = new URL(value, 'https://chat.deepseek.com');
      } else if (/^chat\.deepseek\.com\//i.test(value)) {
        url = new URL('https://' + value);
      } else {
        url = new URL(value);
      }
    } catch (_) {
      return null;
    }

    if (url.hostname.toLowerCase() !== 'chat.deepseek.com') return null;
    const match = url.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/);
    return match && SHARE_ID_PATTERN.test(match[1]) ? match[1] : null;
  }

  function createShareSession(payload, shareId) {
    const normalizedShareId = parseShareId(shareId);
    if (!normalizedShareId) throw new Error('分享 ID 无效');

    const bizData = payload?.data?.biz_data;
    if (!bizData || typeof bizData !== 'object') {
      throw new Error('分享响应缺少 data.biz_data');
    }

    // 分享响应字段直接进入 session；只补充导出所必需但响应可能缺失的标识和标题。
    const session = { ...bizData };
    if (!session.id) session.id = normalizedShareId;
    if (!session.title) session.title = '分享的对话';
    return session;
  }

  function createSessionExport(format, session, options = {}) {
    if (!session || typeof session !== 'object') throw new Error('会话数据无效');
    if (format !== 'markdown' && format !== 'json') throw new Error('不支持的导出格式: ' + format);

    const title = normalizeTitle(session.title);
    const name = sanitizeFileName(title);

    if (format === 'json') {
      // JSON 是原始数据备份，不受 Markdown 的思考和网络搜索选项影响。
      return {
        name,
        title,
        files: [{
          path: name + '.json',
          content: JSON.stringify(session, null, 2),
          mimeType: 'application/json;charset=utf-8',
        }],
      };
    }

    return markdownExport.createMarkdownExport(session, {
      title,
      name,
      includeThinking: options.includeThinking !== false,
      includeSearch: options.includeSearch !== false,
      branchMode: options.branchMode === 'all' ? 'all' : 'latest',
    });
  }

  function normalizeTitle(rawTitle) {
    return inlineText(rawTitle, '无标题').replace(/\s+-\s+DeepSeek$/i, '') || '无标题';
  }

  function sanitizeFileName(value) {
    let name = String(value || '无标题')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[ .]+$/g, '')
      .trim()
      .slice(0, 100) || '无标题';

    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }

  function inlineText(value, fallback) {
    return String(value || fallback).replace(/\s+/g, ' ').trim();
  }

  return Object.freeze({
    DEFAULT_MARKDOWN_OPTIONS,
    createSessionExport,
    createShareSession,
    parseShareId,
  });
});
