/**
 * DeepSeek API 客户端测试。
 *
 * 验证动态 Token、复合分页游标、响应结构保留、退避重试和正文读取超时。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeepSeekClient } = require('../lib/deepseek-client.js');

/**
 * 创建具备 Fetch Response 最小接口的 JSON 响应替身。
 *
 * @param {*} payload json() 和默认 text() 返回的数据。
 * @param {object} overrides 可覆盖的状态、方法或响应字段。
 * @returns {object} 可交给客户端 fetch 依赖的响应对象。
 */
function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    ...overrides,
  };
}

test('历史请求动态读取 Token，并保留原始 biz_data 字段', async () => {
  const requests = [];
  let token = 'Bearer first';
  const client = createDeepSeekClient({
    getBearerToken: () => token,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        data: {
          biz_data: {
            custom_history_field: 42,
            chat_messages: [{ message_id: 1, role: 'USER' }],
          },
        },
      });
    },
  });

  const first = await client.getHistoryData('session-1');
  token = 'Bearer second';
  await client.getHistoryData('session-2');

  assert.equal(requests[0].options.headers.authorization, 'Bearer first');
  assert.equal(requests[1].options.headers.authorization, 'Bearer second');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(first.custom_history_field, 42);
  assert.deepEqual(first.chat_messages, [{ message_id: 1, role: 'USER' }]);
  assert.deepEqual(first.messages, first.chat_messages);
});

test('会话分页使用 DeepSeek 复合游标并报告累计进度', async () => {
  const urls = [];
  const progress = [];
  const waits = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
    pinned: false,
    updated_at: index + 1,
  }));
  const client = createDeepSeekClient({
    wait: async milliseconds => waits.push(milliseconds),
    fetch: async (url) => {
      urls.push(url);
      return jsonResponse({
        data: {
          biz_data: {
            chat_sessions: urls.length === 1
              ? firstPage
              : [{ id: 'session-101', title: '会话 101' }],
            has_more: urls.length === 1,
          },
        },
      });
    },
  });

  const sessions = await client.listAllSessions(value => progress.push(value));
  const firstRequestUrl = new URL(urls[0]);
  const secondRequestUrl = new URL(urls[1]);

  assert.equal(sessions.length, 101);
  assert.equal(firstRequestUrl.searchParams.get('page_size'), '100');
  assert.equal(firstRequestUrl.searchParams.get('lte_cursor.pinned'), 'false');
  assert.equal(secondRequestUrl.searchParams.get('lte_cursor.pinned'), 'false');
  assert.equal(secondRequestUrl.searchParams.get('lte_cursor.updated_at'), '100');
  assert.equal(secondRequestUrl.searchParams.get('lte_cursor.id'), 'session-100');
  assert.deepEqual(progress, [{ page: 1, total: 100 }, { page: 2, total: 101 }]);
  assert.deepEqual(waits, [300]);
});

test('瞬时 HTTP 错误按退避间隔重试后恢复', async () => {
  const waits = [];
  let requestCount = 0;
  const client = createDeepSeekClient({
    wait: async milliseconds => waits.push(milliseconds),
    fetch: async () => {
      requestCount++;
      if (requestCount === 1) {
        return jsonResponse({}, { ok: false, status: 429, statusText: 'Too Many Requests' });
      }
      if (requestCount === 2) {
        return jsonResponse({}, { ok: false, status: 503, statusText: 'Unavailable' });
      }
      return jsonResponse({ data: { biz_data: { chat_messages: [] } } });
    },
  });

  const history = await client.getHistoryData('session-retry');

  assert.equal(requestCount, 3);
  assert.deepEqual(waits, [500, 1000]);
  assert.deepEqual(history.messages, []);
});

test('成功响应体连续截断三次后继续退避重试', async () => {
  const waits = [];
  let requestCount = 0;
  const client = createDeepSeekClient({
    wait: async milliseconds => waits.push(milliseconds),
    fetch: async () => {
      requestCount++;
      return jsonResponse({}, {
        async json() {
          if (requestCount <= 3) throw new SyntaxError('Unexpected end of JSON input');
          return { data: { biz_data: { chat_messages: [] } } };
        },
      });
    },
  });

  const history = await client.getHistoryData('session-truncated-response');

  assert.equal(requestCount, 4);
  assert.deepEqual(waits, [500, 1000, 2000]);
  assert.deepEqual(history.messages, []);
});

test('鉴权失败不重试', async () => {
  let requestCount = 0;
  const client = createDeepSeekClient({
    wait: async () => assert.fail('鉴权失败不应等待重试'),
    fetch: async () => {
      requestCount++;
      return jsonResponse({}, { ok: false, status: 401, statusText: 'Unauthorized' });
    },
  });

  await assert.rejects(client.getHistoryData('session-auth'), /HTTP 401 Unauthorized/);
  assert.equal(requestCount, 1);
});

test('分享接口业务错误转换为统一异常', async () => {
  const client = createDeepSeekClient({
    fetch: async () => jsonResponse({ code: 1201, msg: '分享不存在' }),
  });

  await assert.rejects(
    client.fetchShareContent('share_123'),
    /API 错误: 分享不存在/,
  );
});

test('请求超时计时器覆盖响应体读取阶段', async () => {
  let timeoutActive = false;
  const client = createDeepSeekClient({
    setTimeout(callback, milliseconds) {
      assert.equal(typeof callback, 'function');
      assert.equal(milliseconds, 15_000);
      timeoutActive = true;
      return 1;
    },
    clearTimeout(timeoutId) {
      assert.equal(timeoutId, 1);
      timeoutActive = false;
    },
    fetch: async () => ({
      ok: true,
      async json() {
        assert.equal(timeoutActive, true);
        return { data: { biz_data: { chat_messages: [] } } };
      },
    }),
  });

  const history = await client.getHistoryData('session-with-slow-body');

  assert.deepEqual(history.messages, []);
  assert.equal(timeoutActive, false);
});
