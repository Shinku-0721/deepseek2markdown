/**
 * 全量导出历史缓存模块。
 *
 * 使用扩展隔离的 chrome.storage.local 持久化成功历史响应，并以会话 id 和 updated_at
 * 共同判断缓存是否仍然有效。缓存属于性能优化：不可用、损坏或版本不匹配时必须静默回退
 * 到网络请求，不能影响导出结果的正确性。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布缓存工厂。 */
(function publishHistoryCache(root, createCacheModule) {
  const cacheModule = createCacheModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = cacheModule;
  } else {
    root.DeepSeekHistoryCache = cacheModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 创建缓存模块的公开接口。
 *
 * @returns {{createHistoryCache: Function}} 冻结后的缓存工厂。
 */
function createCacheModule() {
  'use strict';

  // 前缀包含结构版本；未来缓存结构变化时可自然隔离旧记录，避免错误反序列化。
  const CACHE_KEY_PREFIX = 'deepseekHistoryCache:v1:';

  /**
   * 创建一个面向会话历史的容错缓存实例。
   *
   * @param {object} environment 可选依赖；storage 用于测试或替换 chrome.storage.local。
   * @returns {{get: Function, getMany: Function, put: Function}} 冻结后的读写接口。
   */
  function createHistoryCache(environment = {}) {
    const storage = environment.storage || globalThis.chrome?.storage?.local;
    // 首次存储异常后停用本实例，防止全量导出对同一个故障存储重复发起上千次操作。
    let available = Boolean(storage?.get && storage?.set);

    /**
     * 读取与当前会话修订号完全一致的历史记录。
     *
     * @param {object} session 会话列表元数据，至少应包含 id 和 updated_at。
     * @returns {Promise<object|null>} 有效历史；未命中、记录损坏或存储失败时返回 null。
     */
    async function get(session) {
      const descriptor = describeSession(session);
      if (!descriptor) return null;
      const histories = await getMany([session]);
      return histories.get(descriptor.id) || null;
    }

    /**
     * 在一次存储调用中读取一批会话缓存，并逐条校验修订号和历史结构。
     *
     * 批量大小由全量导出 module 的预取窗口限制，因此既减少 chrome.storage 往返，也不会
     * 一次把全部账号历史载入内存。任意存储异常会停用当前缓存实例并返回空 Map。
     *
     * @param {object[]} sessions 同一预取窗口内的会话元数据。
     * @returns {Promise<Map<string, object>>} 以规范化会话 ID 为键的有效历史映射。
     */
    async function getMany(sessions) {
      const descriptors = Array.isArray(sessions)
        ? sessions.map(describeSession).filter(Boolean)
        : [];
      const histories = new Map();
      if (!available || descriptors.length === 0) return histories;

      try {
        const values = await storage.get(descriptors.map(descriptor => descriptor.key));
        for (const descriptor of descriptors) {
          const record = values?.[descriptor.key];
          if (!record || record.revision !== descriptor.revision) continue;
          const history = restoreHistory(record);
          if (history) histories.set(descriptor.id, history);
        }
      } catch (_) {
        available = false;
      }
      return histories;
    }

    /**
     * 保存一次成功获取且结构有效的历史响应。
     *
     * 缺少 updated_at 的会话无法可靠判断新旧，因此不会进入缓存。写入错误只返回 false，
     * 调用方仍可继续使用当前网络响应完成归档。
     *
     * @param {object} session 会话列表元数据。
     * @param {object} history 规范化后包含 messages 数组的历史响应。
     * @returns {Promise<boolean>} 成功写入返回 true，否则返回 false。
     */
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

    return Object.freeze({ get, getMany, put });
  }

  /**
   * 从会话元数据生成存储键和修订号。
   *
   * @param {object} session 会话列表元数据。
   * @returns {{id: string, key: string, revision: string}|null} 可缓存描述；字段不足时返回 null。
   */
  function describeSession(session) {
    const id = String(session?.id ?? '').trim();
    if (!id || session?.updated_at == null) return null;
    return {
      id,
      key: CACHE_KEY_PREFIX + id,
      revision: String(session.updated_at),
    };
  }

  /**
   * 移除与 chat_messages 指向同一数组的 messages 别名，避免本地存储重复一份消息树。
   *
   * @param {object} history 历史响应。
   * @returns {{history: object, messagesSource?: string}} 可持久化记录片段。
   */
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

  /**
   * 从持久化记录恢复稳定的 messages 视图并校验结构。
   *
   * @param {object} record 存储中的缓存记录。
   * @returns {object|null} 可用历史；结构无效时返回 null。
   */
  function restoreHistory(record) {
    if (!record.history || typeof record.history !== 'object') return null;

    const history = record.messagesSource === 'chat_messages'
      ? { ...record.history, messages: record.history.chat_messages }
      : record.history;
    return isHistory(history) ? history : null;
  }

  /**
   * 判断一个值是否符合导出流程要求的最小历史结构。
   *
   * @param {*} history 待检查值。
   * @returns {boolean} 对象且包含 messages 数组时返回 true。
   */
  function isHistory(history) {
    return Boolean(history && typeof history === 'object' && Array.isArray(history.messages));
  }

  return Object.freeze({ createHistoryCache });
});
