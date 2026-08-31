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
  const FILE_ORIGIN = 'https://files.deepseeksvc.com';
  const API_HEADERS = Object.freeze({
    accept: 'application/json',
    'x-client-platform': 'web',
    'x-client-version': '2.2.0',
    'x-client-locale': 'zh_CN',
    'x-client-bundle-id': 'com.deepseek.chat',
  });
  const REQUEST_TIMEOUT_MS = 15_000;
  const FILE_REQUEST_TIMEOUT_MS = 60_000;
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
   * @returns {{fetchShareContent: Function, fetchUploadedFiles: Function,
   *   getHistoryData: Function, listAllSessions: Function}}
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
        throwForBusinessError(result);
        const bizData = result?.data?.biz_data;
        if (!bizData || typeof bizData !== 'object' || !Array.isArray(bizData.chat_sessions)) {
          throw new Error('响应结构错误: 会话列表缺少 data.biz_data.chat_sessions 数组');
        }
        const batch = bizData.chat_sessions;
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
      throwForBusinessError(result);
      const bizData = result?.data?.biz_data;
      if (!bizData || typeof bizData !== 'object') {
        throw new Error('响应结构错误: 会话历史缺少 data.biz_data 对象');
      }

      // 保留原始字段供完整 JSON 使用，同时提供稳定的 messages 视图给 Markdown 渲染器。
      const messages = Array.isArray(bizData.chat_messages)
        ? bizData.chat_messages
        : (Array.isArray(bizData.messages) ? bizData.messages : null);
      if (!messages) throw new Error('响应结构错误: 会话历史缺少消息数组');
      return { ...bizData, messages };
    }

    /**
     * 下载会话中记录的历史上传文件，并把单文件错误保留为结果项。
     *
     * 非图片使用原文件模式；图片只提供预览模式，并按响应 MIME 类型修正保存扩展名。
     * 文件签名不会写入返回结果，避免在后续 Markdown 或错误信息中泄露临时凭据。
     *
     * @param {object} session 原始会话数据。
     * @param {object} [selection] 可选的附件 ID 白名单，仅用于刷新后重试受影响文件。
     * @returns {Promise<object[]>} 文件内容或对应的非致命错误结果。
     */
    async function fetchUploadedFiles(session, selection = {}) {
      const results = [];
      const selectedFileIds = Array.isArray(selection.fileIds)
        ? new Set(selection.fileIds.map(id => String(id)))
        : null;

      for (const attachment of collectUploadedFiles(session)) {
        if (selectedFileIds && !selectedFileIds.has(String(attachment.id))) continue;
        const file = {
          id: attachment.id == null ? null : String(attachment.id),
          fileName: String(attachment.fileName).trim(),
          fileSize: finiteFileSize(attachment.fileSize),
        };

        if (attachment.status && String(attachment.status).toUpperCase() !== 'SUCCESS') {
          results.push({ ...file, error: `上传状态为 ${attachment.status}` });
          continue;
        }
        if (typeof attachment.signedPath !== 'string' || !attachment.signedPath.trim()) {
          results.push({ ...file, error: '缺少文件下载地址' });
          continue;
        }

        const controller = new AbortController();
        const timeoutId = scheduleTimeout(() => controller.abort(), FILE_REQUEST_TIMEOUT_MS);
        try {
          const response = await fetchRequest(createUploadedFileUrl(
            attachment.signedPath,
            attachment.isImage,
          ), {
            credentials: 'omit',
            headers: { accept: '*/*' },
            signal: controller.signal,
          });
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
            error.refreshableAttachment = isAttachmentCredentialRejection(response.status);
            throw error;
          }

          const mimeType = response.headers?.get?.('content-type')?.split(';')[0]
            || 'application/octet-stream';
          if (mimeType.toLowerCase() === 'text/html') {
            const error = new Error('文件服务返回了预览页面');
            error.refreshableAttachment = true;
            throw error;
          }

          const downloadedFile = attachment.isImage
            ? {
                ...file,
                fileName: imagePreviewFileName(file.fileName, mimeType),
                originalFileName: file.fileName,
              }
            : file;

          results.push({
            ...downloadedFile,
            content: new Uint8Array(await response.arrayBuffer()),
            mimeType,
          });
        } catch (error) {
          const message = error?.name === 'AbortError'
            ? `下载超时 (${FILE_REQUEST_TIMEOUT_MS / 1000}s)`
            : errorMessage(error);
          results.push({
            ...file,
            error: message,
            ...(error?.refreshableAttachment ? { refreshable: true } : {}),
          });
        } finally {
          cancelTimeout(timeoutId);
        }
      }

      return results;
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
      fetchUploadedFiles,
      getHistoryData,
      listAllSessions,
    });
  }

  /**
   * 从未知层级的会话响应中识别并去重 DeepSeek 文件对象。
   *
   * @param {*} root 原始会话或消息节点。
   * @returns {object[]} 按首次出现顺序排列的附件对象。
   */
  function collectUploadedFiles(root) {
    const files = [];
    const seenObjects = new WeakSet();
    const seenFiles = new Set();

    /** 深度遍历 JSON 结构；历史响应不包含循环引用，WeakSet 仅用于防御测试替身。 */
    function visit(value) {
      if (!value || typeof value !== 'object' || seenObjects.has(value)) return;
      seenObjects.add(value);

      const rawFileName = value.fileName ?? value.file_name;
      const rawFileId = value.id ?? value.fileId ?? value.file_id;
      const rawSignedPath = value.signedPath ?? value.signed_path;
      const fileName = typeof rawFileName === 'string' ? rawFileName.trim() : '';
      const fileId = rawFileId == null ? '' : String(rawFileId);
      const signedPath = typeof rawSignedPath === 'string' ? rawSignedPath : '';
      const hasFileField = Object.prototype.hasOwnProperty.call(value, 'fileId')
        || Object.prototype.hasOwnProperty.call(value, 'file_id');
      if (fileName && (fileId.startsWith('file-') || hasFileField || signedPath)) {
        const key = fileId || signedPath;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          files.push({
            id: rawFileId,
            status: value.status,
            fileName,
            fileSize: value.fileSize ?? value.file_size,
            isImage: value.isImage === true || value.is_image === true,
            signedPath,
          });
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const item of Object.values(value)) visit(item);
    }

    visit(root);
    return files;
  }

  /**
   * 把预览签名路径转换为真实文件服务 URL。
   *
   * @param {string} signedPath DeepSeek 附件对象中的签名路径。
   * @param {boolean} isImage 是否为图片附件。
   * @returns {string} 只包含必要 file_id、state 和读取模式的文件 URL。
   */
  function createUploadedFileUrl(signedPath, isImage) {
    let source;
    try {
      source = new URL(signedPath, API_ORIGIN);
    } catch (_) {
      throw new Error('文件下载地址无效');
    }

    const isPreviewPath = source.origin === API_ORIGIN && source.pathname === '/file';
    const isFilePath = source.origin === FILE_ORIGIN && source.pathname === '/api/file';
    const fileId = source.searchParams.get('file_id');
    const state = source.searchParams.get('state');
    if ((!isPreviewPath && !isFilePath) || !fileId || !state) {
      throw new Error('文件下载地址无效');
    }

    const target = new URL('/api/file', FILE_ORIGIN);
    target.searchParams.set('file_id', fileId);
    target.searchParams.set('state', state);
    target.searchParams.set('ty', isImage ? 'p' : 'r');
    return target.toString();
  }

  /**
   * 让图片预览的保存扩展名与文件服务实际返回格式一致。
   *
   * @param {string} fileName 原始上传文件名。
   * @param {string} mimeType 文件服务响应类型。
   * @returns {string} 与响应格式匹配的文件名。
   */
  function imagePreviewFileName(fileName, mimeType) {
    const normalizedType = String(mimeType).toLowerCase();
    let extension = '';
    if (normalizedType === 'image/webp') extension = '.webp';
    if (normalizedType === 'image/jpeg' && !/\.jpe?g$/i.test(fileName)) extension = '.jpg';
    if (!extension || fileName.toLowerCase().endsWith(extension)) return fileName;

    const dotIndex = fileName.lastIndexOf('.');
    return (dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName) + extension;
  }

  /**
   * 将 HTTP 成功响应中的明确业务失败转换为统一异常。
   *
   * 部分接口版本不返回 code，因此只有字段存在且不等于数值零时才判定失败。
   *
   * @param {*} result 已解析的 DeepSeek JSON 响应。
   */
  function throwForBusinessError(result) {
    const code = result?.code;
    if (code == null || code === 0 || code === '0') return;
    throw new Error(`API 错误: ${result.msg || JSON.stringify(result)}`);
  }

  /** 判断文件服务状态是否可能由过期或被撤销的签名凭据造成。 */
  function isAttachmentCredentialRejection(status) {
    return status === 400 || status === 401 || status === 403 || status === 404 || status === 410;
  }

  /** @param {*} value 文件大小候选值。 */
  function finiteFileSize(value) {
    if (value == null || value === '') return null;
    const size = Number(value);
    return Number.isFinite(size) && size >= 0 ? size : null;
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
