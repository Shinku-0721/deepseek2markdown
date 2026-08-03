/**
 * DeepSeek API 客户端模块。
 *
 * 统一维护网页接口请求头、动态 Bearer Token、响应体读取超时、指数退避重试、会话列表
 * 复合游标和历史响应结构。模块不保存凭证；每次请求开始前都通过注入函数读取最新 Token。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布同一客户端工厂。 */
(function publishDeepSeekClient(root, createClientModule) {
  const clientModule = createClientModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = clientModule;
  } else {
    root.DeepSeekClient = clientModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 创建无外部状态的客户端模块导出对象。
 *
 * @returns {{createDeepSeekClient: Function}} 冻结后的客户端工厂接口。
 */
function createClientModule() {
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
  const MAX_REQUEST_ATTEMPTS = 5;
  const RETRY_BASE_DELAY_MS = 500;
  const SESSION_PAGE_SIZE = 100;
  const SESSION_PAGE_INTERVAL_MS = 300;
  const MAX_SESSION_PAGES = 200;

  /**
   * 创建可注入网络、计时器和凭证来源的 DeepSeek 客户端实例。
   *
   * 环境依赖可在测试中替换；浏览器运行时则自动回退到全局 fetch 和计时器。
   *
   * @param {object} environment 可选依赖，包括 getBearerToken、fetch、wait 和计时器函数。
   * @returns {{fetchShareContent: Function, getHistoryData: Function, listAllSessions: Function}}
   *   冻结后的业务接口集合。
   */
  function createDeepSeekClient(environment = {}) {
    // 以下适配器把浏览器默认实现与测试替身统一为相同调用约定。
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

    /**
     * 执行一个 DeepSeek GET 请求，并对瞬时网络错误、响应体截断和可重试状态退避重试。
     *
     * 超时计时器覆盖 fetch 与 response.json() 两个阶段，防止响应头已到达但正文长期不结束。
     * 401 等永久错误不会重试；408、425、429 和 5xx 最多尝试 MAX_REQUEST_ATTEMPTS 次。
     *
     * @param {string} path 以 / 开头的 API 路径及查询字符串。
     * @returns {Promise<object>} 已解析的 JSON 响应。
     * @throws {Error} 请求超时、网络失败、不可重试 HTTP 状态或重试耗尽。
     */
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

    /**
     * 使用 DeepSeek 的复合游标遍历账号下全部会话元数据。
     *
     * id 去重既防止后端偶发重复页，也为缓存和归档提供稳定会话集合；页面之间保留固定
     * 间隔，避免列表请求在短时间内连续冲击服务端。
     *
     * @param {Function} [onPage] 每成功处理一页后接收 {page, total} 的进度回调。
     * @returns {Promise<object[]>} 按接口顺序排列且 id 唯一的会话列表。
     */
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
        await wait(SESSION_PAGE_INTERVAL_MS);
      }

      return sessions;
    }

    /**
     * 获取单个私有会话的完整历史数据。
     *
     * 原始 biz_data 字段全部保留，同时始终补充 messages 数组，隔离不同接口版本中
     * chat_messages 与 messages 字段命名的差异。
     *
     * @param {string} chatSessionId 会话 ID。
     * @returns {Promise<object>} 历史响应及规范化 messages 视图。
     */
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

    /**
     * 获取公开分享链接的原始响应，并校验 DeepSeek 业务状态码。
     *
     * @param {string} shareId 已规范化的分享 ID。
     * @returns {Promise<object>} 分享接口完整响应。
     * @throws {Error} 接口返回非零业务码时抛出统一错误。
     */
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

  /**
   * 判断 HTTP 状态是否代表适合短暂等待后重试的瞬时失败。
   *
   * @param {number} status HTTP 状态码。
   * @returns {boolean} 可重试返回 true。
   */
  function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  /**
   * 默认异步等待实现。
   *
   * @param {number} milliseconds 等待毫秒数。
   * @returns {Promise<void>} 计时器到期后完成。
   */
  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  /**
   * 将任意异常值转换为稳定文本，避免字符串或其他抛出值丢失信息。
   *
   * @param {*} error 捕获到的异常值。
   * @returns {string} 错误描述。
   */
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  return Object.freeze({ createDeepSeekClient });
});
