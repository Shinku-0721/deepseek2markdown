/**
 * Markdown 会话渲染模块。
 *
 * 把一个规范化会话渲染为主 Markdown 文档和关联 Search 文件，支持思考过程、搜索工具
 * 记录、网页打开记录、引用链接和消息分支选择。接口只接收已确定的标题、文件名和展示
 * 选项，不负责 API 请求、ZIP 压缩或浏览器下载。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布 Markdown 渲染接口。 */
(function publishMarkdownExport(root, createMarkdownModule) {
  const markdownExport = createMarkdownModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = markdownExport;
  } else {
    root.DeepSeekMarkdownExport = markdownExport;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 创建无外部状态的 Markdown 渲染接口。
 *
 * @returns {{createMarkdownExport: Function}} 冻结后的渲染接口。
 */
function createMarkdownModule() {
  'use strict';

  // DeepSeek 正文以 references 数组下标表达一个或多个搜索引用，兼容中英文逗号。
  const REFERENCE_PATTERN = /\[reference:\s*(\d+(?:\s*[,，]\s*\d+)*)\s*\]/gi;

  /**
   * 将一个会话渲染为主文档和去重后的 Search 附件集合。
   *
   * @param {object} session 包含 messages 或 chat_messages 的会话。
   * @param {object} settings 已规范化的 title、name、内容开关和分支模式。
   * @returns {{name: string, title: string, files: object[]}} 可交给交付模块的文件集合。
   */
  function createMarkdownExport(session, settings) {
    const { title, name, includeThinking, includeSearch, branchMode } = settings;
    const messages = getSessionMessages(session);
    const visibleMessages = branchMode === 'latest'
      ? selectLatestMessageBranch(messages)
      : messages;
    const turns = groupConversationTurns(visibleMessages);
    const searchFiles = new Map();
    const lines = ['# ' + title, ''];

    for (const turn of turns) {
      // 每轮固定分为 REQUEST 与其余内容两部分，中间的分隔线是导出格式契约。
      // 提问 Callout 本身就是轮次边界，不再增加与正文无关的顺序编号。
      const request = turn.requests
        .map(fragment => cleanExportText(fragment.content, includeSearch))
        .filter(Boolean)
        .join('\n\n') || '_（未找到提问内容）_';
      lines.push(...renderCallout('question', '提问', request), '', '---', '');

      let hasResponse = false;

      for (const entry of turn.entries) {
        const targets = collectSearchTargets(entry);
        const processParts = [];
        const responses = [];
        let thinkingElapsed = 0;
        let hasThinkingElapsed = false;

        // DeepSeek 用 fragment 顺序表达“思考 → 工具调用 → 继续思考 → 最终回答”。
        for (const fragment of entry.fragments) {
          const type = fragmentType(fragment);

          if (type === 'THINK' && includeThinking) {
            const content = transformReferences(
              fragment.content,
              fragment.references,
              targets,
              includeSearch,
            );
            if (content) processParts.push({ kind: 'thinking', content });

            const elapsed = finiteNumber(fragment.elapsed_secs);
            if (elapsed != null) {
              thinkingElapsed += elapsed;
              hasThinkingElapsed = true;
            }
            continue;
          }

          if (isSearchFragment(fragment) && includeSearch) {
            const searchId = targets.get(String(fragment.id));
            if (!searchId) continue;

            const path = `Search/${searchId}.md`;
            if (!searchFiles.has(path)) {
              searchFiles.set(path, {
                path,
                content: renderSearchFile(fragment, searchId, targets),
                mimeType: 'text/markdown;charset=utf-8',
              });
            }
            processParts.push({ kind: 'search', content: renderSearchRow(fragment, searchId) });
            continue;
          }

          if (type === 'RESPONSE') {
            const content = transformReferences(
              fragment.content,
              fragment.references,
              targets,
              includeSearch,
            );
            if (content) responses.push(content);
          }
        }

        const hasThinking = processParts.some(part => part.kind === 'thinking');
        if (hasThinking) {
          const elapsedLabel = hasThinkingElapsed ? ` · ${formatSeconds(thinkingElapsed)}s` : '';
          lines.push('<details>');
          lines.push(`<summary>思考过程${elapsedLabel}</summary>`, '');
          appendProcessParts(lines, processParts);
          lines.push('</details>', '');
        } else {
          appendProcessParts(lines, processParts);
        }

        if (responses.length > 0) {
          lines.push(responses.join('\n\n'), '');
          hasResponse = true;
        }
      }

      if (!hasResponse) lines.push('_（未找到回答内容）_', '');
    }

    if (turns.length === 0) lines.push('_（无消息）_', '');

    return {
      name,
      title,
      files: [{
        path: name + '.md',
        content: normalizeMarkdown(lines.join('\n')),
        mimeType: 'text/markdown;charset=utf-8',
      }, ...searchFiles.values()],
    };
  }

  /**
   * 按 REQUEST fragment 将线性消息序列组织为“提问 + 后续助手记录”的会话轮次。
   *
   * 不包含 REQUEST 的开头消息仍会形成无提问轮次，避免分享旧结构中的内容被丢弃。
   *
   * @param {object[]} messages 当前需要展示的消息序列。
   * @returns {Array<{requests: object[], entries: object[]}>} 保持原顺序的轮次数组。
   */
  function groupConversationTurns(messages) {
    const turns = [];
    let current = null;

    messages.forEach((message, messageIndex) => {
      const fragments = getMessageFragments(message);
      const requests = fragments.filter(fragment => fragmentType(fragment) === 'REQUEST');
      const remaining = fragments.filter(fragment => fragmentType(fragment) !== 'REQUEST');

      if (requests.length > 0) {
        if (current) turns.push(current);
        current = { requests, entries: [] };
      }

      if (!current && remaining.length > 0) current = { requests: [], entries: [] };
      if (current && remaining.length > 0) {
        current.entries.push({ message, messageIndex, fragments: remaining });
      }
    });

    if (current) turns.push(current);
    return turns;
  }

  /**
   * 从不同接口版本的会话对象中读取消息数组。
   *
   * @param {object} session 会话对象。
   * @returns {object[]} 消息数组；字段缺失时返回空数组。
   */
  function getSessionMessages(session) {
    if (Array.isArray(session.messages)) return session.messages;
    if (Array.isArray(session.chat_messages)) return session.chat_messages;
    return [];
  }

  /**
   * 从 parent_id 消息图中选择每个分叉最后生成的子节点，得到当前可见分支。
   *
   * 当任一消息缺少图关系字段时无法安全推断分支，函数会原样返回输入；visitedIds 则防止
   * 异常环形数据造成无限遍历。
   *
   * @param {object[]} messages 完整消息数组。
   * @returns {object[]} 最新可见消息链，或无法建图时的原数组。
   */
  function selectLatestMessageBranch(messages) {
    const hasCompleteGraph = messages.every(message => (
      message
      && message.message_id != null
      && Object.prototype.hasOwnProperty.call(message, 'parent_id')
    ));
    if (!hasCompleteGraph) return messages;

    const childrenByParent = new Map();
    for (const message of messages) {
      const parentKey = messageKey(message.parent_id);
      const children = childrenByParent.get(parentKey) || [];
      children.push(message);
      childrenByParent.set(parentKey, children);
    }

    // API 按版本产生顺序返回消息；每个分叉选择最后一个子节点即可得到当前可见消息链。
    let current = childrenByParent.get(messageKey(null))?.at(-1);
    if (!current) return messages;

    const selected = [];
    const visitedIds = new Set();
    while (current && !visitedIds.has(messageKey(current.message_id))) {
      visitedIds.add(messageKey(current.message_id));
      selected.push(current);
      current = childrenByParent.get(messageKey(current.message_id))?.at(-1);
    }
    return selected;
  }

  /**
   * 为消息 id 或 parent_id 生成包含类型信息的 Map 键。
   *
   * @param {*} value 消息标识；null/undefined 代表根节点。
   * @returns {string} 不会混淆数字 1 与字符串 "1" 的稳定键。
   */
  function messageKey(value) {
    return value == null ? 'root' : `${typeof value}:${String(value)}`;
  }

  /**
   * 读取消息的 fragment 数组，并兼容公开分享接口的旧扁平消息结构。
   *
   * 旧结构只补出渲染所需的最小 THINK、REQUEST 或 RESPONSE fragment，不修改原消息对象。
   *
   * @param {object} message 原始消息。
   * @returns {object[]} 可供统一渲染流程消费的 fragment 数组。
   */
  function getMessageFragments(message) {
    if (Array.isArray(message?.fragments) && message.fragments.length > 0) {
      return message.fragments;
    }

    // 分享接口的旧结构可能没有 fragments，这里只补出最小的 REQUEST/RESPONSE 视图。
    const content = firstText(message?.content, message?.message, message?.text, message?.body);
    if (!content) return [];

    const fragments = [];
    const thinking = firstText(message?.thinking_content, message?.reasoning_content);
    if (thinking) fragments.push({ type: 'THINK', content: thinking });
    fragments.push({
      id: message?.message_id,
      type: message?.role === 'USER' ? 'REQUEST' : 'RESPONSE',
      content,
    });
    return fragments;
  }

  /**
   * 为一条助手消息中的搜索和打开网页 fragment 建立稳定 Search 文件 ID。
   *
   * @param {{message: object, messageIndex: number, fragments: object[]}} entry 轮次消息条目。
   * @returns {Map<string, string>} fragment 原始 id 到“消息 id-fragment id”的映射。
   */
  function collectSearchTargets(entry) {
    const targets = new Map();
    const messageId = sanitizeIdentifier(entry.message?.message_id ?? `m${entry.messageIndex + 1}`);

    // fragment ID 会在每轮助手消息中重新计数，必须加入 message_id 才能保证文件路径唯一。
    for (const fragment of entry.fragments.filter(isSearchFragment)) {
      if (fragment.id == null) continue;
      const fragmentId = sanitizeIdentifier(fragment.id);
      targets.set(String(fragment.id), `${messageId}-${fragmentId}`);
    }
    return targets;
  }

  /**
   * 将正文中的 [reference:N] 标记替换为对应 Search 文件的 Wiki 链接。
   *
   * 关闭搜索导出时直接移除引用；索引无效或目标文件不存在时不生成悬空链接。
   *
   * @param {*} content 原始正文。
   * @param {object[]} references fragment 的引用数组。
   * @param {Map<string, string>} targets 搜索 fragment 到稳定文件 ID 的映射。
   * @param {boolean} includeSearch 是否生成搜索附件。
   * @returns {string} 清理空白后的正文。
   */
  function transformReferences(content, references, targets, includeSearch) {
    const text = String(content ?? '');
    const transformed = text.replace(REFERENCE_PATTERN, (_marker, indexes) => {
      if (!includeSearch) return '';

      // [reference:N] 中的 N 是 references 数组下标，不是目标 fragment ID。
      const links = [];
      for (const rawIndex of indexes.split(/[,，]/)) {
        const index = Number(rawIndex.trim());
        const reference = Array.isArray(references) ? references[index] : null;
        const fragmentId = reference?.id ?? index;
        const searchId = targets.get(String(fragmentId));
        if (searchId) links.push(`[[Search/${searchId}]]`);
      }
      return links.join('');
    });

    return cleanReferenceWhitespace(transformed).trim();
  }

  /**
   * 清理普通导出文本，并在关闭搜索时移除原始引用标记。
   *
   * @param {*} content 原始文本。
   * @param {boolean} includeSearch 是否保留搜索引用。
   * @returns {string} 去除首尾空白后的文本。
   */
  function cleanExportText(content, includeSearch) {
    const text = String(content ?? '');
    if (includeSearch) return text.trim();
    return cleanReferenceWhitespace(text.replace(REFERENCE_PATTERN, '')).trim();
  }

  /**
   * 收紧引用替换或删除后遗留的多余空白，同时保留正常段落边界。
   *
   * @param {*} value 待清理文本。
   * @returns {string} 标点和换行周围空白规范化后的文本。
   */
  function cleanReferenceWhitespace(value) {
    // 搜索文件关闭后目标不再存在，同时收紧引用删除后遗留的标点前空白。
    return String(value)
      .replace(/[ \t]+([，。！？；：,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * 渲染 Obsidian/Markdown callout，并为多行正文逐行添加引用前缀。
   *
   * @param {string} kind callout 类型，例如 question 或 info。
   * @param {string} title callout 标题。
   * @param {*} content 正文。
   * @returns {string[]} 可直接追加到主文档的行数组。
   */
  function renderCallout(kind, title, content) {
    const lines = [`> [!${kind}] ${title}`];
    for (const line of String(content).split('\n')) lines.push(line ? '> ' + line : '>');
    return lines;
  }

  /**
   * 按原始过程顺序追加思考文本和网络搜索记录。
   *
   * 连续搜索会合并为一个“网络搜索”callout；遇到思考文本时先刷新搜索组，确保工具调用
   * 与思考交错顺序不被改变。
   *
   * @param {string[]} lines 主文档行数组，会被原地追加。
   * @param {Array<{kind: string, content: string}>} parts 过程片段。
   */
  function appendProcessParts(lines, parts) {
    let searchRows = [];

    /** 将当前连续搜索行写入一个 callout，并清空临时数组。 */
    const flushSearchRows = () => {
      if (searchRows.length === 0) return;
      lines.push(...renderCallout('info', '网络搜索', searchRows.join('\n')), '');
      searchRows = [];
    };

    for (const part of parts) {
      if (part.kind === 'search') {
        searchRows.push(part.content);
        continue;
      }

      flushSearchRows();
      lines.push(part.content, '');
    }
    flushSearchRows();
  }

  /**
   * 把搜索或打开网页 fragment 渲染为主文档中的一行摘要链接。
   *
   * @param {object} fragment TOOL_SEARCH 或 TOOL_OPEN fragment。
   * @param {string} searchId 对应 Search 文件的稳定 ID。
   * @returns {string} Markdown 列表行。
   */
  function renderSearchRow(fragment, searchId) {
    if (fragmentType(fragment) === 'TOOL_SEARCH') {
      const queries = readQueries(fragment);
      const firstQuery = inlineText(queries[0], '未记录查询词').slice(0, 60);
      const countLabel = queries.length > 1 ? `等 ${queries.length} 项` : '';
      return `- 搜索「${firstQuery}」${countLabel}：[[Search/${searchId}]]`;
    }

    const result = readOpenResult(fragment);
    const title = inlineText(result?.title, '未命名网页');
    return `- 打开「${title}」：[[Search/${searchId}]]`;
  }

  /**
   * 渲染单个 TOOL_SEARCH 或 TOOL_OPEN 对应的 Search Markdown 文件。
   *
   * @param {object} fragment 搜索工具 fragment。
   * @param {string} searchId 当前文件稳定 ID。
   * @param {Map<string, string>} targets 同一消息内其他搜索目标映射。
   * @returns {string} 以换行结尾的完整 Markdown 文本。
   */
  function renderSearchFile(fragment, searchId, targets) {
    // Search 文件名即稳定搜索 ID，主文档和 TOOL_OPEN 来源都依赖这一相对路径。
    if (fragmentType(fragment) === 'TOOL_SEARCH') {
      const lines = [
        `# 搜索 ${searchId}`,
        '',
        '## 查询',
        '',
      ];

      const queries = readQueries(fragment);
      if (queries.length > 0) {
        for (const query of queries) lines.push('- ' + query);
      } else {
        lines.push('_（未记录查询词）_');
      }

      lines.push('', '## 结果', '');
      const results = Array.isArray(fragment.results) ? fragment.results : [];
      if (results.length > 0) {
        results.forEach((result, index) => appendSearchResult(lines, result, index + 1));
      } else {
        lines.push('_（无搜索结果）_', '');
      }
      return normalizeMarkdown(lines.join('\n'));
    }

    const result = readOpenResult(fragment);
    const lines = [`# 打开网页 ${searchId}`, ''];

    const sourceId = fragment.reference?.id;
    const sourceSearchId = sourceId == null ? null : targets.get(String(sourceId));
    if (sourceSearchId) lines.push(`- 来源：[[Search/${sourceSearchId}]]`, '');

    appendSearchResult(lines, result, null);
    return normalizeMarkdown(lines.join('\n'));
  }

  /**
   * 将一个搜索结果或打开网页结果追加到 Search 文档行数组。
   *
   * @param {string[]} lines 目标行数组，会被原地修改。
   * @param {object} result 搜索结果对象。
   * @param {number|null} index 搜索结果序号；null 表示单个打开网页结果。
   */
  function appendSearchResult(lines, result, index) {
    const item = result && typeof result === 'object' ? result : {};
    const title = inlineText(item.title, item.url || '未命名结果');
    const heading = index == null ? '##' : `### ${index}.`;
    if (item.url) lines.push(`${heading} [${escapeLinkText(title)}](${item.url})`, '');
    else lines.push(`${heading} ${title}`, '');

    if (item.snippet) lines.push(...renderFencedPreview(item.snippet), '');
    if (item.site_name) lines.push('- 站点：' + item.site_name);
    lines.push('');
  }

  /**
   * 使用长度足够的 Markdown 代码围栏包裹原始预览，避免内容中的反引号提前闭合围栏。
   *
   * @param {*} content 搜索摘要或网页预览。
   * @returns {string[]} 开围栏、原文和闭围栏三行。
   */
  function renderFencedPreview(content) {
    const text = String(content).replace(/\r\n?/g, '\n');
    const longestBacktickRun = (text.match(/`+/g) || [])
      .reduce((longest, run) => Math.max(longest, run.length), 0);
    // 摘要可能包含代码围栏，外层 fence 必须更长才能保证预览始终按纯文本渲染。
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    return [fence, text, fence];
  }

  /**
   * 从 TOOL_SEARCH fragment 中读取非空查询词。
   *
   * @param {object} fragment 搜索 fragment。
   * @returns {string[]} 保持接口顺序的查询词数组。
   */
  function readQueries(fragment) {
    return (Array.isArray(fragment.queries) ? fragment.queries : [])
      .map(item => firstText(item?.query, item))
      .filter(Boolean);
  }

  /**
   * 从不同 TOOL_OPEN 响应结构中读取第一个网页结果对象。
   *
   * @param {object} fragment 打开网页 fragment。
   * @returns {object} 网页结果；字段缺失时返回空对象。
   */
  function readOpenResult(fragment) {
    if (fragment?.result && typeof fragment.result === 'object') return fragment.result;
    const results = Array.isArray(fragment?.results) ? fragment.results : [];
    return results[0] || {};
  }

  /**
   * 判断 fragment 是否属于需要生成 Search 文件的工具类型。
   *
   * @param {object} fragment 待检查 fragment。
   * @returns {boolean} TOOL_SEARCH 或 TOOL_OPEN 返回 true。
   */
  function isSearchFragment(fragment) {
    const type = fragmentType(fragment);
    return type === 'TOOL_SEARCH' || type === 'TOOL_OPEN';
  }

  /**
   * 读取并大写 fragment 类型，兼容缺失值和不同大小写。
   *
   * @param {object} fragment 待检查 fragment。
   * @returns {string} 规范化类型文本。
   */
  function fragmentType(fragment) {
    return String(fragment?.type || '').toUpperCase();
  }

  /**
   * 把消息或 fragment 标识转换为适合文件名片段的安全文本。
   *
   * @param {*} value 原始标识。
   * @returns {string} 仅包含字母、数字、点、下划线和连字符的标识。
   */
  function sanitizeIdentifier(value) {
    return String(value ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  }

  /**
   * 限制连续空行为最多两个空行，并确保文档以单个换行结尾。
   *
   * @param {*} value Markdown 文本。
   * @returns {string} 规范化文档。
   */
  function normalizeMarkdown(value) {
    return String(value).replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  /**
   * 把标题类值折叠为单行文本，并为空值提供后备文案。
   *
   * @param {*} value 原始值。
   * @param {string} fallback 后备文本。
   * @returns {string} 单行文本。
   */
  function inlineText(value, fallback) {
    return String(value || fallback).replace(/\s+/g, ' ').trim();
  }

  /**
   * 从候选值中选择第一个可展示的字符串、数字或布尔值。
   *
   * @param {...*} values 按优先级排列的候选值。
   * @returns {string} 首个有效文本；全部无效时返回空字符串。
   */
  function firstText(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return '';
  }

  /**
   * 把输入转换为有限数值，拒绝空值、NaN 和无穷值。
   *
   * @param {*} value 原始数值。
   * @returns {number|null} 有限数值或 null。
   */
  function finiteNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * 将秒数四舍五入到最多两位小数，并移除无意义的尾随零。
   *
   * @param {number} value 秒数。
   * @returns {string} 适合摘要标题的数值文本。
   */
  function formatSeconds(value) {
    return String(Number(value.toFixed(2)));
  }

  /**
   * 转义 Markdown 链接标题中的反斜杠和右方括号。
   *
   * @param {*} value 链接显示文本。
   * @returns {string} 可安全放入方括号的文本。
   */
  function escapeLinkText(value) {
    return String(value).replace(/([\\\]])/g, '\\$1');
  }

  return Object.freeze({ createMarkdownExport });
});
