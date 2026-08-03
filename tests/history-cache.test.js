/**
 * 全量导出历史缓存测试。
 *
 * 验证修订号命中、批量读取、结构压缩和存储故障降级，避免性能优化改变缓存正确性。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryCache } = require('../lib/history-cache.js');

/**
 * 创建兼容 chrome.storage.local 最小读写接口的内存存储。
 *
 * @param {object} initial 初始键值记录。
 * @returns {object} 支持单键或键数组读取并记录调用次数的存储替身。
 */
function createStorage(initial = {}) {
  const values = { ...initial };
  let getCalls = 0;
  return {
    values,
    get getCalls() {
      return getCalls;
    },
    async get(keys) {
      getCalls++;
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requestedKeys
          .filter(key => Object.hasOwn(values, key))
          .map(key => [key, values[key]]),
      );
    },
    async set(items) {
      Object.assign(values, items);
    },
  };
}

test('历史缓存仅在会话更新时间相同时命中', async () => {
  const storage = createStorage();
  const cache = createHistoryCache({ storage });
  const session = { id: 'session-1', updated_at: 123 };
  const history = { messages: [{ message_id: 1 }] };

  assert.equal(await cache.put(session, history), true);
  assert.deepEqual(await cache.get(session), history);
  assert.equal(await cache.get({ ...session, updated_at: 124 }), null);
});

test('批量读取使用一次存储调用并过滤修订号不匹配的记录', async () => {
  const storage = createStorage();
  const cache = createHistoryCache({ storage });
  const currentSession = { id: 'session-current', updated_at: 10 };
  const changedSession = { id: 'session-changed', updated_at: 20 };
  await cache.put(currentSession, { messages: [{ message_id: 1 }] });
  await cache.put(changedSession, { messages: [{ message_id: 2 }] });
  storage.values['deepseekHistoryCache:v1:session-changed'].revision = '19';

  const histories = await cache.getMany([
    currentSession,
    changedSession,
    { id: 'session-without-revision' },
  ]);

  assert.equal(storage.getCalls, 1);
  assert.deepEqual(histories.get(currentSession.id), { messages: [{ message_id: 1 }] });
  assert.equal(histories.has(changedSession.id), false);
  assert.equal(histories.has('session-without-revision'), false);
});

test('历史缓存不保存缺少更新时间的会话', async () => {
  const storage = createStorage();
  const cache = createHistoryCache({ storage });

  assert.equal(await cache.put({ id: 'session-1' }, { messages: [] }), false);
  assert.equal(await cache.get({ id: 'session-1' }), null);
  assert.deepEqual(storage.values, {});
});

test('缓存 chat_messages 时不重复保存 messages 别名', async () => {
  const storage = createStorage();
  const cache = createHistoryCache({ storage });
  const messages = [{ message_id: 1 }];
  const session = { id: 'session-compact', updated_at: 1 };

  await cache.put(session, { chat_messages: messages, messages });

  const [record] = Object.values(storage.values);
  assert.equal(Object.hasOwn(record.history, 'messages'), false);
  const restored = await cache.get(session);
  assert.deepEqual(restored.messages, messages);
  assert.equal(restored.messages, restored.chat_messages);
});

test('存储不可用时缓存静默退化为未命中', async () => {
  const cache = createHistoryCache({
    storage: {
      async get() {
        throw new Error('存储不可用');
      },
      async set() {
        throw new Error('存储不可用');
      },
    },
  });
  const session = { id: 'session-1', updated_at: 1 };

  assert.equal(await cache.get(session), null);
  assert.equal(await cache.put(session, { messages: [] }), false);
});
