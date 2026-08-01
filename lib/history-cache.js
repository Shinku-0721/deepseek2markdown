/**
 * 全量导出历史缓存：按会话更新时间复用已成功获取的历史响应。
 */
(function publishHistoryCache(root, createCacheModule) {
  const cacheModule = createCacheModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = cacheModule;
  } else {
    root.DeepSeekHistoryCache = cacheModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCacheModule() {
  'use strict';

  const CACHE_KEY_PREFIX = 'deepseekHistoryCache:v1:';

  function createHistoryCache(environment = {}) {
    const storage = environment.storage || globalThis.chrome?.storage?.local;
    let available = Boolean(storage?.get && storage?.set);

    async function get(session) {
      const descriptor = describeSession(session);
      if (!available || !descriptor) return null;

      try {
        const values = await storage.get(descriptor.key);
        const record = values?.[descriptor.key];
        if (!record || record.revision !== descriptor.revision) return null;
        return restoreHistory(record);
      } catch (_) {
        available = false;
        return null;
      }
    }

    async function put(session, history) {
      const descriptor = describeSession(session);
      if (!available || !descriptor || !isHistory(history)) return false;

      try {
        await storage.set({
          [descriptor.key]: {
            revision: descriptor.revision,
            ...compactHistory(history),
          },
        });
        return true;
      } catch (_) {
        available = false;
        return false;
      }
    }

    return Object.freeze({ get, put });
  }

  function describeSession(session) {
    const id = String(session?.id ?? '').trim();
    if (!id || session?.updated_at == null) return null;
    return {
      key: CACHE_KEY_PREFIX + id,
      revision: String(session.updated_at),
    };
  }

  function compactHistory(history) {
    if (
      Array.isArray(history.chat_messages)
      && history.messages === history.chat_messages
    ) {
      const { messages: _messages, ...storedHistory } = history;
      return { history: storedHistory, messagesSource: 'chat_messages' };
    }
    return { history };
  }

  function restoreHistory(record) {
    if (!record.history || typeof record.history !== 'object') return null;

    const history = record.messagesSource === 'chat_messages'
      ? { ...record.history, messages: record.history.chat_messages }
      : record.history;
    return isHistory(history) ? history : null;
  }

  function isHistory(history) {
    return Boolean(history && typeof history === 'object' && Array.isArray(history.messages));
  }

  return Object.freeze({ createHistoryCache });
});
