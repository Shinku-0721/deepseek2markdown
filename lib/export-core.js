/**
 * 会话导出核心模块。
 *
 * 负责解析分享标识、规范化分享响应、校验导出格式、生成跨平台安全文件名，并把会话
 * 分派为 Markdown 文件集合或保留完整字段的 JSON 文件。该模块不负责压缩和下载。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布导出核心接口。 */
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
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 绑定 Markdown 渲染依赖并创建核心导出接口。
 *
 * @param {object} markdownExport Markdown 渲染模块。
 * @returns {object} 冻结后的核心导出接口。
 */
function createExportCore(markdownExport) {
  'use strict';

  if (!markdownExport) throw new Error('Markdown 导出模块加载失败');

  // 分享 ID 只允许 DeepSeek 当前链接中使用的 URL 安全字符，并设置最小长度过滤误输入。
  const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,}$/;
  const MAX_ARCHIVE_SEGMENT_LENGTH = 100;
  const SESSION_BASE_NAME_LENGTH = MAX_ARCHIVE_SEGMENT_LENGTH - '.json'.length;
  const WINDOWS_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  const DEFAULT_MARKDOWN_OPTIONS = Object.freeze({
    includeThinking: true,
    includeSearch: true,
    branchMode: 'latest',
  });

  /**
   * 从裸 ID、相对分享路径或完整 DeepSeek 分享 URL 中提取 share ID。
   *
   * @param {*} raw 用户输入。
   * @returns {string|null} 合法 share ID；域名、路径或格式不符合要求时返回 null。
   */
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

  /**
   * 把公开分享接口响应转换为核心导出流程使用的会话对象。
   *
   * 响应中的未知字段原样保留，仅在缺失时补充稳定 id 和标题。
   *
   * @param {object} payload 分享接口完整响应。
   * @param {string} shareId 分享 ID 或可解析的分享地址。
   * @returns {object} 可交给 Markdown/JSON 渲染器的会话。
   */
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

  /**
   * 把单个会话转换为统一文件集合描述。
   *
   * @param {'markdown'|'json'} format 目标格式。
   * @param {object} session 会话数据。
   * @param {object} options Markdown 展示选项。
   * @returns {{name: string, title: string, files: object[]}} 文件集合。
   */
  function createSessionExport(format, session, options = {}) {
    if (!session || typeof session !== 'object') throw new Error('会话数据无效');
    if (format !== 'markdown' && format !== 'json') throw new Error('不支持的导出格式: ' + format);

    const title = normalizeTitle(session.title);
    const name = sanitizeFileName(title, { maxLength: SESSION_BASE_NAME_LENGTH });

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
      attachments: prepareMarkdownAttachments(options.attachments),
    });
  }

  /**
   * 为已下载附件分配安全且不重复的 Files 路径，并保留失败说明。
   *
   * @param {*} attachments 内容脚本提供的附件下载结果。
   * @returns {object[]} 可直接交给 Markdown 渲染器的附件描述。
   */
  function prepareMarkdownAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];

    const prepared = [];
    const usedNames = new Set();
    attachments.forEach((attachment, index) => {
      if (!attachment || typeof attachment !== 'object') return;

      const originalName = inlineText(attachment.fileName, `附件 ${index + 1}`);
      if (attachment.content == null) {
        prepared.push({
          label: originalName,
          error: inlineText(attachment.error, '获取失败'),
        });
        return;
      }

      const fileName = allocateArchiveSegment(originalName, usedNames, {
        fallback: `附件 ${index + 1}`,
        preserveExtension: true,
      });
      prepared.push({
        label: inlineText(attachment.originalFileName, fileName),
        path: 'Files/' + fileName,
        content: attachment.content,
        mimeType: attachment.mimeType || 'application/octet-stream',
      });
    });
    return prepared;
  }

  /**
   * 规范化页面或接口标题，移除 DeepSeek 页面标题后缀并折叠空白。
   *
   * @param {*} rawTitle 原始标题。
   * @returns {string} 非空显示标题。
   */
  function normalizeTitle(rawTitle) {
    return inlineText(rawTitle, '无标题').replace(/\s+-\s+DeepSeek$/i, '') || '无标题';
  }

  /**
   * 生成适用于 Windows 和 ZIP 路径的安全名称。
   *
   * 清理在截断后再次执行，确保边界恰好落在点或空格时不会重新产生非法尾部字符。
   *
   * @param {*} value 原始名称。
   * @param {object} options 长度、后备名称和扩展名保留策略。
   * @returns {string} 满足指定单段长度限制的安全名称。
   */
  function sanitizeFileName(value, options = {}) {
    const maxLength = validSegmentLength(options.maxLength);
    const fallback = cleanArchiveName(options.fallback) || '无标题';
    const name = cleanArchiveName(value) || fallback;
    return fitArchiveName(name, '', maxLength, options.preserveExtension === true, fallback);
  }

  /**
   * 按 Windows 大小写和尾部规范化语义分配不重复名称。
   *
   * 序号会在扩展名前追加，并重新压缩基础名称以保证最终结果仍在单段长度上限内。
   *
   * @param {*} value 原始名称。
   * @param {Set<string>} usedNames 已占用的 Windows 规范化名称集合。
   * @param {object} options 长度、后备名称和扩展名保留策略。
   * @returns {string} 当前集合中唯一且安全的名称。
   */
  function allocateArchiveSegment(value, usedNames, options = {}) {
    const maxLength = validSegmentLength(options.maxLength);
    const preserveExtension = options.preserveExtension === true;
    const fallback = cleanArchiveName(options.fallback) || '无标题';
    const baseName = sanitizeFileName(value, { maxLength, preserveExtension, fallback });
    let candidate = baseName;
    let sequence = 2;

    while (usedNames.has(windowsNameKey(candidate))) {
      candidate = fitArchiveName(
        baseName,
        ` (${sequence})`,
        maxLength,
        preserveExtension,
        fallback,
      );
      sequence++;
    }
    usedNames.add(windowsNameKey(candidate));
    return candidate;
  }

  /** 清理 Windows/ZIP 保留字符、连续空白以及尾部点和空格。 */
  function cleanArchiveName(value) {
    return String(value ?? '')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[ .]+$/g, '');
  }

  /** 在可选扩展名和重名序号之间分配固定长度预算。 */
  function fitArchiveName(value, suffix, maxLength, preserveExtension, fallback) {
    let stem = value;
    let extension = '';
    if (preserveExtension) {
      const dotIndex = value.lastIndexOf('.');
      if (dotIndex > 0 && dotIndex < value.length - 1) {
        stem = value.slice(0, dotIndex);
        extension = value.slice(dotIndex);
      }
    }

    const maximumExtensionLength = Math.max(0, maxLength - suffix.length - 1);
    if (extension.length > maximumExtensionLength) {
      extension = extension.slice(0, maximumExtensionLength);
    }
    let stemLength = Math.max(1, maxLength - suffix.length - extension.length);
    let fittedStem = cleanArchiveName(stem.slice(0, stemLength))
      || cleanArchiveName(fallback).slice(0, stemLength)
      || '_';
    let candidate = fittedStem + suffix + extension;

    if (WINDOWS_DEVICE_NAME_PATTERN.test(candidate)) {
      stemLength = Math.max(1, stemLength - 1);
      fittedStem = cleanArchiveName(stem.slice(0, stemLength))
        || cleanArchiveName(fallback).slice(0, stemLength)
        || '_';
      candidate = '_' + fittedStem + suffix + extension;
    }
    return cleanArchiveName(candidate) || '_';
  }

  /** 只允许正整数长度，调用者缺省时使用模块统一上限。 */
  function validSegmentLength(value) {
    return Number.isInteger(value) && value > 0 ? value : MAX_ARCHIVE_SEGMENT_LENGTH;
  }

  /** Windows 文件系统按大小写不敏感且忽略尾部点和空格的键。 */
  function windowsNameKey(value) {
    return String(value).replace(/[ .]+$/g, '').toLowerCase();
  }

  /**
   * 把任意值压缩为不含换行和连续空白的单行文本。
   *
   * @param {*} value 原始值。
   * @param {string} fallback 空值时使用的后备文本。
   * @returns {string} 单行文本。
   */
  function inlineText(value, fallback) {
    return String(value || fallback).replace(/\s+/g, ' ').trim();
  }

  return Object.freeze({
    DEFAULT_MARKDOWN_OPTIONS,
    allocateArchiveSegment,
    createSessionExport,
    createShareSession,
    parseShareId,
  });
});
