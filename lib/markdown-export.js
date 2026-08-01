/**
 * Markdown 导出 Module：把一个会话渲染为主文档和关联的 Search 文件。
 * Interface 只接收已确定的显示标题、文件名和展示选项。
 */
(function publishMarkdownExport(root, createMarkdownModule) {
  const markdownExport = createMarkdownModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = markdownExport;
  } else {
    root.DeepSeekMarkdownExport = markdownExport;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMarkdownModule() {
  'use strict';

  const REFERENCE_PATTERN = /\[reference:\s*(\d+(?:\s*[,，]\s*\d+)*)\s*\]/gi;

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

  function getSessionMessages(session) {
    if (Array.isArray(session.messages)) return session.messages;
    if (Array.isArray(session.chat_messages)) return session.chat_messages;
    return [];
  }

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

  function messageKey(value) {
    return value == null ? 'root' : `${typeof value}:${String(value)}`;
  }

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

  function cleanExportText(content, includeSearch) {
    const text = String(content ?? '');
    if (includeSearch) return text.trim();
    return cleanReferenceWhitespace(text.replace(REFERENCE_PATTERN, '')).trim();
  }

  function cleanReferenceWhitespace(value) {
    // 搜索文件关闭后目标不再存在，同时收紧引用删除后遗留的标点前空白。
    return String(value)
      .replace(/[ \t]+([，。！？；：,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function renderCallout(kind, title, content) {
    const lines = [`> [!${kind}] ${title}`];
    for (const line of String(content).split('\n')) lines.push(line ? '> ' + line : '>');
    return lines;
  }

  function appendProcessParts(lines, parts) {
    let searchRows = [];

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

  function renderFencedPreview(content) {
    const text = String(content).replace(/\r\n?/g, '\n');
    const longestBacktickRun = (text.match(/`+/g) || [])
      .reduce((longest, run) => Math.max(longest, run.length), 0);
    // 摘要可能包含代码围栏，外层 fence 必须更长才能保证预览始终按纯文本渲染。
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    return [fence, text, fence];
  }

  function readQueries(fragment) {
    return (Array.isArray(fragment.queries) ? fragment.queries : [])
      .map(item => firstText(item?.query, item))
      .filter(Boolean);
  }

  function readOpenResult(fragment) {
    if (fragment?.result && typeof fragment.result === 'object') return fragment.result;
    const results = Array.isArray(fragment?.results) ? fragment.results : [];
    return results[0] || {};
  }

  function isSearchFragment(fragment) {
    const type = fragmentType(fragment);
    return type === 'TOOL_SEARCH' || type === 'TOOL_OPEN';
  }

  function fragmentType(fragment) {
    return String(fragment?.type || '').toUpperCase();
  }

  function sanitizeIdentifier(value) {
    return String(value ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  }

  function normalizeMarkdown(value) {
    return String(value).replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  function inlineText(value, fallback) {
    return String(value || fallback).replace(/\s+/g, ' ').trim();
  }

  function firstText(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return '';
  }

  function finiteNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatSeconds(value) {
    return String(Number(value.toFixed(2)));
  }

  function escapeLinkText(value) {
    return String(value).replace(/([\\\]])/g, '\\$1');
  }

  return Object.freeze({ createMarkdownExport });
});
