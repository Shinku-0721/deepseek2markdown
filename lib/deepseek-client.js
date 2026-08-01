/**
 * DeepSeek 请求 Module：集中维护请求头、超时、分页游标和响应结构。
 */
(function publishDeepSeekClient(root, createClientModule) {
  const clientModule = createClientModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = clientModule;
  } else {
    root.DeepSeekClient = clientModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createClientModule() {
  'use strict';

  const API_ORIGIN = 'https://chat.deepseek.com';
  const API_HEADERS = Object.freeze({
    accept: 'application/json',
    'x-client-platform': 'web',
    'x-client-version': '2.2.0',
    'x-client-locale': 'zh_CN',
    'x-client-bundle-id': 'com.deepseek.chat',
  });
  const REQUEST_TIMEOUT_MS = 15_000;
  const MAX_REQUEST_ATTEMPTS = 3;
  const RETRY_BASE_DELAY_MS = 500;
  const SESSION_PAGE_SIZE = 100;
  const MAX_SESSION_PAGES = 200;

  function createDeepSeekClient(environment = {}) {
    const getBearerToken = typeof environment.getBearerToken === 'function'
      ? environment.getBearerToken
      : () => null;
    const fetchRequest = typeof environment.fetch === 'function'
      ? environment.fetch
      : (...args) => globalThis.fetch(...args);
    const wait = typeof environment.wait === 'function' ? environment.wait : sleep;
    const scheduleTimeout = typeof environment.setTimeout === 'function'
      ? environment.setTimeout
      : setTimeout;
    const cancelTimeout = typeof environment.clearTimeout === 'function'
      ? environment.clearTimeout
      : clearTimeout;

    async function request(path) {
      for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
        const headers = { ...API_HEADERS };
        const bearerToken = getBearerToken();
        if (bearerToken) headers.authorization = bearerToken;

        const controller = new AbortController();
        const timeoutId = scheduleTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        let detail = '';
        let requestError = null;

        try {
          response = await fetchRequest(API_ORIGIN + path, {
            credentials: 'include',
            headers,
            signal: controller.signal,
          });
          if (response.ok) return await response.json();

          try {
            detail = await response.text();
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
          }
        } catch (error) {
          requestError = error?.name === 'AbortError'
            ? new Error(`请求超时 (${REQUEST_TIMEOUT_MS / 1000}s): GET ${path}`)
            : new Error(`网络错误: ${errorMessage(error)}`);
        } finally {
          cancelTimeout(timeoutId);
        }

        if (requestError) {
          if (attempt === MAX_REQUEST_ATTEMPTS) throw requestError;
          await wait(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
          continue;
        }

        const suffix = detail ? ' / ' + detail.slice(0, 120) : '';
        const responseError = new Error(
          `HTTP ${response.status} ${response.statusText} ← ${path}${suffix}`,
        );
        if (!isRetryableStatus(response.status) || attempt === MAX_REQUEST_ATTEMPTS) {
          throw responseError;
        }
        await wait(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
      }

      throw new Error('请求重试次数已耗尽: GET ' + path);
    }

    async function listAllSessions(onPage) {
      const sessions = [];
      const seenIds = new Set();
      let cursorSession = null;

      for (let page = 1; page <= MAX_SESSION_PAGES; page++) {
        const params = new URLSearchParams({ page_size: String(SESSION_PAGE_SIZE) });

        // DeepSeek 使用 pinned、updated_at 和 id 共同定位下一页，缺少任一项都可能重复取页。
        if (cursorSession) {
          params.set('lte_cursor.pinned', String(cursorSession.pinned || false));
          if (cursorSession.updated_at != null) {
            params.set('lte_cursor.updated_at', String(cursorSession.updated_at));
          }
          if (cursorSession.id) params.set('lte_cursor.id', cursorSession.id);
        } else {
          params.set('lte_cursor.pinned', 'false');
        }

        const result = await request('/api/v0/chat_session/fetch_page?' + params);
        const bizData = result?.data?.biz_data || {};
        const batch = Array.isArray(bizData.chat_sessions) ? bizData.chat_sessions : [];
        if (batch.length === 0) break;

        let addedCount = 0;
        for (const session of batch) {
          if (!seenIds.has(session.id)) {
            seenIds.add(session.id);
            sessions.push(session);
            addedCount++;
          }
        }

        if (addedCount > 0) cursorSession = batch[batch.length - 1];
        onPage?.({ page, total: sessions.length });

        // 后端偶发重复页时 addedCount 为 0；将其视为终止信号可避免无限请求。
        if (batch.length < SESSION_PAGE_SIZE || bizData.has_more === false || addedCount === 0) break;
      }

      return sessions;
    }

    async function getHistoryData(chatSessionId) {
      const result = await request(
        '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(chatSessionId),
      );
      const bizData = result?.data?.biz_data;
      if (!bizData || typeof bizData !== 'object') return { messages: [] };

      // 保留原始字段供完整 JSON 使用，同时提供稳定的 messages 视图给 Markdown 渲染器。
      const messages = Array.isArray(bizData.chat_messages)
        ? bizData.chat_messages
        : (Array.isArray(bizData.messages) ? bizData.messages : []);
      return { ...bizData, messages };
    }

    async function fetchShareContent(shareId) {
      const result = await request(
        '/api/v0/share/content?share_id=' + encodeURIComponent(shareId),
      );
      if (result.code !== 0) throw new Error(`API 错误: ${result.msg || JSON.stringify(result)}`);
      return result;
    }

    return Object.freeze({
      fetchShareContent,
      getHistoryData,
      listAllSessions,
    });
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  return Object.freeze({ createDeepSeekClient });
});
