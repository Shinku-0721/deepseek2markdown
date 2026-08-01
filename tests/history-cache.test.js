'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryCache } = require('../lib/history-cache.js');

function createStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
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
