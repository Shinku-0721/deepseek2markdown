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

test('会话列表和历史请求拒绝 HTTP 200 业务错误', async () => {
  const responses = [
    { code: 1200, msg: '登录状态失效' },
    { code: 1404, msg: '会话不存在' },
  ];
  const client = createDeepSeekClient({
    fetch: async () => jsonResponse(responses.shift()),
  });

  await assert.rejects(client.listAllSessions(), /API 错误: 登录状态失效/);
  await assert.rejects(client.getHistoryData('missing-session'), /API 错误: 会话不存在/);
});

test('会话列表和历史请求拒绝缺失必要数据容器的成功响应', async () => {
  const responses = [
    { code: 0, data: { biz_data: {} } },
    { code: 0, data: { biz_data: { title: '缺少消息数组' } } },
  ];
  const client = createDeepSeekClient({
    fetch: async () => jsonResponse(responses.shift()),
  });

  await assert.rejects(client.listAllSessions(), /响应结构错误.*chat_sessions/);
  await assert.rejects(client.getHistoryData('malformed-session'), /响应结构错误.*消息数组/);
});

test('会话列表和历史请求接受合法空数据', async () => {
  const responses = [
    { code: 0, data: { biz_data: { chat_sessions: [], has_more: false } } },
    { code: 0, data: { biz_data: { chat_messages: [] } } },
  ];
  const client = createDeepSeekClient({
    fetch: async () => jsonResponse(responses.shift()),
  });

  assert.deepEqual(await client.listAllSessions(), []);
  assert.deepEqual((await client.getHistoryData('empty-session')).messages, []);
});

test('历史上传文件使用签名参数请求真实文件服务并按 ID 去重', async () => {
  const requests = [];
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const attachment = {
    id: 'file-80026c92-6b18-4ea7-a70a-61b6486f71c9',
    status: 'SUCCESS',
    fileName: '实验报告.pdf',
    fileSize: bytes.length,
    signedPath: '/file?file_id=80026c92-6b18-4ea7-a70a-61b6486f71c9&state=signed-state',
  };
  const client = createDeepSeekClient({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: name => name === 'content-type' ? 'application/pdf' : null },
        arrayBuffer: async () => bytes.buffer,
      };
    },
  });

  const files = await client.fetchUploadedFiles({
    messages: [{ fragments: [{ files: [
      attachment,
      { ...attachment },
      {
        file_id: 'snake-case-id',
        status: 'SUCCESS',
        file_name: '补充材料.pdf',
        file_size: bytes.length,
        signed_path: '/file?file_id=snake-case-id&state=snake-state',
      },
    ] }] }],
  });
  const requestUrl = new URL(requests[0].url);

  assert.equal(files.length, 2);
  assert.equal(files[0].fileName, '实验报告.pdf');
  assert.equal(files[1].fileName, '补充材料.pdf');
  assert.deepEqual(Array.from(files[0].content), Array.from(bytes));
  assert.equal(requestUrl.origin, 'https://files.deepseeksvc.com');
  assert.equal(requestUrl.pathname, '/api/file');
  assert.equal(requestUrl.searchParams.get('file_id'), '80026c92-6b18-4ea7-a70a-61b6486f71c9');
  assert.equal(requestUrl.searchParams.get('state'), 'signed-state');
  assert.equal(requestUrl.searchParams.get('ty'), 'r');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests.length, 2);
});

test('历史图片附件使用图片预览模式并按响应格式保存', async () => {
  const requests = [];
  const bytes = new Uint8Array([82, 73, 70, 70]);
  const client = createDeepSeekClient({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: name => name === 'content-type' ? 'image/webp' : null },
        arrayBuffer: async () => bytes.buffer,
      };
    },
  });

  const files = await client.fetchUploadedFiles({
    attachments: [{
      file_id: 'image-id',
      status: 'SUCCESS',
      file_name: 'PixPin_2026-08-04_22-12-09.png',
      file_size: bytes.length,
      is_image: true,
      signed_path: '/file?file_id=image-id&state=image-state',
    }],
  });
  const requestUrl = new URL(requests[0].url);

  assert.equal(requestUrl.searchParams.get('ty'), 'p');
  assert.equal(files[0].fileName, 'PixPin_2026-08-04_22-12-09.webp');
  assert.equal(files[0].originalFileName, 'PixPin_2026-08-04_22-12-09.png');
  assert.equal(files[0].mimeType, 'image/webp');
  assert.deepEqual(Array.from(files[0].content), Array.from(bytes));
});

test('单个历史附件不可下载时返回错误结果而不中断其他文件', async () => {
  const client = createDeepSeekClient({
    fetch: async () => jsonResponse({}, {
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }),
  });

  const files = await client.fetchUploadedFiles({
    attachments: [
      { id: 'file-missing-path', status: 'SUCCESS', fileName: '无地址.pdf' },
      {
        id: 'file-expired',
        status: 'SUCCESS',
        fileName: '已过期.pdf',
        signedPath: '/file?file_id=expired&state=expired-state',
      },
    ],
  });

  assert.equal(files.length, 2);
  assert.match(files[0].error, /缺少文件下载地址/);
  assert.match(files[1].error, /HTTP 404 Not Found/);
});

test('附件签名被文件服务拒绝时标记可刷新，并支持只请求指定附件', async () => {
  const requests = [];
  const session = {
    attachments: [
      {
        id: 'file-expired',
        status: 'SUCCESS',
        fileName: '过期.pdf',
        signedPath: '/file?file_id=expired&state=old-state',
      },
      {
        id: 'file-valid',
        status: 'SUCCESS',
        fileName: '有效.pdf',
        signedPath: '/file?file_id=valid&state=current-state',
      },
      {
        status: 'SUCCESS',
        fileName: '无 ID.pdf',
        signedPath: '/file?file_id=idless&state=old-state',
      },
    ],
  };
  const client = createDeepSeekClient({
    fetch: async (url) => {
      requests.push(url);
      const fileId = new URL(url).searchParams.get('file_id');
      if (fileId === 'expired' || fileId === 'idless') {
        return jsonResponse({}, { ok: false, status: 403, statusText: 'Forbidden' });
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      };
    },
  });

  const first = await client.fetchUploadedFiles(session);
  assert.equal(first[0].refreshable, true);
  assert.match(first[0].error, /HTTP 403 Forbidden/);
  assert.equal(first[1].refreshable, undefined);
  assert.equal(first[2].id, null);
  assert.equal(first[2].attachmentIndex, 2);
  assert.equal(first[2].refreshable, true);

  requests.length = 0;
  const selected = await client.fetchUploadedFiles(session, { fileIds: ['file-valid'] });
  assert.deepEqual(selected.map(file => file.id), ['file-valid']);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).searchParams.get('file_id'), 'valid');

  requests.length = 0;
  const selectedIdless = await client.fetchUploadedFiles(session, { attachmentIndexes: [2] });
  assert.deepEqual(selectedIdless.map(file => file.attachmentIndex), [2]);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).searchParams.get('file_id'), 'idless');
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
