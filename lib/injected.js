/**
 * 运行在页面 MAIN 世界，观察 DeepSeek 自身请求中的 Bearer Token。
 * Token 通过 window.postMessage 发送给隔离世界中的内容脚本。
 */
(function installTokenCapture() {
  'use strict';

  if (window.__DS2MD_INJECTED__) return;
  window.__DS2MD_INJECTED__ = true;

  let lastToken = null;

  function isDeepSeekApiUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith('/api/v0/');
    } catch (_) {
      return false;
    }
  }

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

  function publishToken(token) {
    if (token === lastToken) return;
    lastToken = token;
    window.postMessage({ type: 'DS2MD_TOKEN', token }, window.location.origin);
  }

  const originalFetch = window.fetch;
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
    const requestUrls = new WeakMap();

    prototype.open = function rememberRequestUrl(_method, url) {
      requestUrls.set(this, url);
      return originalOpen.apply(this, arguments);
    };

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
