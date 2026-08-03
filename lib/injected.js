/**
 * DeepSeek 页面凭证捕获模块。
 *
 * 运行在页面 MAIN 世界，以旁路方式观察 DeepSeek 自身 fetch/XHR 请求中的 Bearer Token，
 * 再通过限定同源的 window.postMessage 发送给隔离世界内容脚本。Hook 不修改请求参数、
 * 响应或异常；任何兼容性问题都必须退回浏览器原始实现。
 */
/** 安装一次性的 fetch/XHR Hook；重复注入时通过页面标记直接返回。 */
(function installTokenCapture() {
  'use strict';

  if (window.__DS2MD_INJECTED__) return;
  window.__DS2MD_INJECTED__ = true;

  // 仅在 Token 变化时发送消息，避免每个 API 请求都触发相同的跨世界事件。
  let lastToken = null;

  /**
   * 判断请求 URL 是否属于当前 DeepSeek origin 下的 v0 API。
   *
   * @param {*} rawUrl fetch 或 XHR 提供的原始 URL。
   * @returns {boolean} 同源 API 请求返回 true；无法解析时返回 false。
   */
  function isDeepSeekApiUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith('/api/v0/');
    } catch (_) {
      return false;
    }
  }

  /**
   * 从 Headers、元组数组或普通对象中读取 Authorization 请求头。
   *
   * @param {Headers|Array|object|null|undefined} headers 多种 fetch 请求头表示。
   * @returns {*} 找到的头值；不存在时返回 null。
   */
  function extractAuthorization(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) {
      return headers.get('authorization') || headers.get('Authorization');
    }
    if (Array.isArray(headers)) {
      const found = headers.find(([name]) => String(name).toLowerCase() === 'authorization');
      return found ? found[1] : null;
    }
    if (typeof headers === 'object') {
      return headers.authorization || headers.Authorization;
    }
    return null;
  }

  /**
   * 将新的 Bearer Token 发布给内容脚本，并抑制连续重复值。
   *
   * @param {string} token 完整 Authorization 头值。
   */
  function publishToken(token) {
    if (token === lastToken) return;
    lastToken = token;
    window.postMessage({ type: 'DS2MD_TOKEN', token }, window.location.origin);
  }

  // 保留原始 fetch 引用，包装函数完成观察后始终以原 this 和 arguments 调用它。
  const originalFetch = window.fetch;
  /**
   * fetch 包装器：从 Request 或 init.headers 中观察 DeepSeek API 的 Bearer Token。
   *
   * @param {Request|string|URL} input fetch 输入。
   * @param {RequestInit} init 可选请求配置。
   * @returns {Promise<Response>} 原始 fetch 的返回值。
   */
  window.fetch = function captureFetchToken(input, init) {
    try {
      const requestUrl = typeof input === 'string' || input instanceof URL
        ? String(input)
        : input?.url;

      if (isDeepSeekApiUrl(requestUrl)) {
        const token = extractAuthorization(init?.headers)
          || (input instanceof Request ? extractAuthorization(input.headers) : null);
        if (typeof token === 'string' && token.startsWith('Bearer ')) publishToken(token);
      }
    } catch (_) {
      // Hook 只能旁路观察，任何兼容性问题都必须交回原始 fetch。
    }
    return originalFetch.apply(this, arguments);
  };

  try {
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSetRequestHeader = prototype.setRequestHeader;
    // XHR 的 open 与 setRequestHeader 分开调用，使用 WeakMap 按实例关联目标 URL 且不阻止回收。
    const requestUrls = new WeakMap();

    /**
     * XHR open 包装器：记录实例即将请求的 URL 后调用原始实现。
     *
     * @param {string} _method HTTP 方法；仅为保持原签名，不参与判断。
     * @param {*} url 请求 URL。
     * @returns {*} 原始 XMLHttpRequest.open 返回值。
     */
    prototype.open = function rememberRequestUrl(_method, url) {
      requestUrls.set(this, url);
      return originalOpen.apply(this, arguments);
    };

    /**
     * XHR 请求头包装器：只观察同源 DeepSeek API 的 Bearer Authorization 头。
     *
     * @param {string} name 请求头名称。
     * @param {string} value 请求头值。
     * @returns {*} 原始 setRequestHeader 返回值。
     */
    prototype.setRequestHeader = function captureXhrToken(name, value) {
      if (
        isDeepSeekApiUrl(requestUrls.get(this))
        && String(name).toLowerCase() === 'authorization'
        && typeof value === 'string'
        && value.startsWith('Bearer ')
      ) {
        publishToken(value);
      }
      return originalSetRequestHeader.call(this, name, value);
    };
  } catch (_) {
    // XHR Hook 仅作 fetch 之外的兜底，失败时不影响页面请求。
  }
})();
