/**
 * 内容脚本全量导出测试。
 *
 * 通过 VM 中的最小浏览器环境验证任务互斥、状态恢复、缓存接续、受限并发、预取窗口和
 * 归档顺序。各 test 回调的中文用例名即行为说明，公共测试辅助函数另行记录输入与输出。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

/**
 * 创建隔离的内容脚本运行环境，并暴露请求、缓存、归档和下载观测值。
 *
 * @param {object} options 可替换的会话、缓存、网络、下载和计时器行为。
 * @returns {object} 消息监听器、异步闸门及累计调用统计。
 */
function createHarness({
  cacheRecords = new Map(),
  downloadHandler = null,
  downloadError = null,
  historyError = null,
  historyLoader = null,
  sessions = [{ id: 'session-1', title: '会话 1' }],
  contentSetTimeout = setTimeout,
} = {}) {
  let contentListener = null;
  let tokenListener = null;
  let releaseHistory = null;
  let downloadCalls = 0;
  let historyCalls = 0;
  let cacheReadCalls = 0;
  let cacheBatchReadCalls = 0;
  let cacheWriteCalls = 0;
  let legacyArchiveCalls = 0;
  const archivedSessions = [];
  const runtimeMessages = [];
  const historyGate = new Promise(resolve => {
    releaseHistory = resolve;
  });
  const windowObject = {
    location: {
      pathname: '/a/chat/s/12345678-1234-1234-1234-123456789abc',
      origin: 'https://chat.deepseek.com',
    },
    addEventListener(type, listener) {
      if (type === 'message') tokenListener = listener;
    },
  };
  const artifact = {
    filename: 'all.zip',
    content: new Blob([new Uint8Array([1])], { type: 'application/zip' }),
    mimeType: 'application/zip',
  };
  const context = {
    console,
    setTimeout: contentSetTimeout,
    clearTimeout,
    URL,
    Blob,
    window: windowObject,
    document: {
      title: '测试会话',
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      createElement() {
        return { addEventListener() {}, remove() {}, set src(_) {} };
      },
    },
    chrome: {
      runtime: {
        lastError: null,
        getURL: value => value,
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          callback?.();
        },
        onMessage: {
          addListener(listener) {
            contentListener = listener;
          },
        },
      },
    },
    DeepSeekClient: {
      createDeepSeekClient() {
        return {
          async listAllSessions(onPage) {
            onPage({ page: 1, total: sessions.length });
            return sessions;
          },
          async getHistoryData(sessionId) {
            historyCalls++;
            if (historyLoader) return historyLoader(sessionId);
            const history = await historyGate;
            if (historyError) throw historyError;
            return history;
          },
          async fetchShareContent() {
            throw new Error('unused');
          },
        };
      },
    },
    DeepSeekHistoryCache: {
      createHistoryCache() {
        return {
          async getMany(batchSessions) {
            cacheBatchReadCalls++;
            const histories = new Map();
            for (const session of batchSessions) {
              cacheReadCalls++;
              if (session?.id == null || session?.updated_at == null) continue;
              const history = cacheRecords.get(cacheRecordKey(session));
              if (history) histories.set(String(session.id), history);
            }
            return histories;
          },
          async get(session) {
            cacheReadCalls++;
            if (session?.id == null || session?.updated_at == null) return null;
            return cacheRecords.get(cacheRecordKey(session)) || null;
          },
          async put(session, history) {
            cacheWriteCalls++;
            if (session?.id == null || session?.updated_at == null) return false;
            cacheRecords.set(cacheRecordKey(session), history);
            return true;
          },
        };
      },
    },
    DeepSeekExportCore: {
      parseShareId() {
        return null;
      },
      createShareSession() {
        throw new Error('unused');
      },
    },
    DeepSeekExportDelivery: {
      createArchiveBuilder() {
        return {
          addSession(session) {
            archivedSessions.push(session);
          },
          async finish() {
            return artifact;
          },
          abort() {},
        };
      },
      async createArchiveArtifact() {
        legacyArchiveCalls++;
        return artifact;
      },
      async createSingleArtifact() {
        throw new Error('unused');
      },
    },
    DeepSeekDownloadClient: {
      async download() {
        downloadCalls++;
        await downloadHandler?.();
        if (downloadError) throw downloadError;
        return { sizeBytes: 1 };
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../content.js'), 'utf8'),
    context,
    { filename: 'content.js' },
  );
  tokenListener({
    source: windowObject,
    origin: windowObject.location.origin,
    data: { type: 'DS2MD_TOKEN', token: 'Bearer test' },
  });

  return {
    archivedSessions,
    get downloadCalls() {
      return downloadCalls;
    },
    get historyCalls() {
      return historyCalls;
    },
    get cacheReadCalls() {
      return cacheReadCalls;
    },
    get cacheBatchReadCalls() {
      return cacheBatchReadCalls;
    },
    get cacheWriteCalls() {
      return cacheWriteCalls;
    },
    get legacyArchiveCalls() {
      return legacyArchiveCalls;
    },
    listener: contentListener,
    releaseHistory,
    runtimeMessages,
  };
}

/**
 * 生成与测试缓存修订语义一致的稳定键。
 *
 * @param {object} session 会话元数据。
 * @returns {string} 由会话 ID 和更新时间组成的键。
 */
function cacheRecordKey(session) {
  return JSON.stringify([String(session.id), String(session.updated_at)]);
}

/**
 * 将 Chrome 回调式消息调用转换为 Promise。
 *
 * @param {Function} listener 内容脚本消息监听器。
 * @param {object} message 待发送消息。
 * @returns {Promise<object>} 内容脚本异步响应。
 */
function send(listener, message) {
  return new Promise(resolve => {
    listener(message, {}, resolve);
  });
}

/**
 * 同步读取内容脚本当前状态快照。
 *
 * @param {Function} listener 内容脚本消息监听器。
 * @returns {object} getStatus 响应。
 */
function readStatus(listener) {
  let status = null;
  listener({ action: 'getStatus' }, {}, value => {
    status = value;
  });
  return status;
}

test('全量导出状态可在 popup 重开后查询，并拒绝重复任务', async () => {
  const harness = createHarness();
  const firstExport = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));

  const runningStatus = readStatus(harness.listener);
  const duplicateExport = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  harness.releaseHistory({ messages: [] });

  const [firstResponse, duplicateResponse] = await Promise.all([firstExport, duplicateExport]);
  const completedStatus = readStatus(harness.listener);

  assert.equal(runningStatus.exportState.status, 'running');
  assert.equal(runningStatus.exportState.action, 'exportAll');
  assert.equal(runningStatus.exportState.stage, 'fetch');
  assert.equal(duplicateResponse.ok, false);
  assert.equal(duplicateResponse.error, '已有导出任务正在进行');
  assert.equal(firstResponse.ok, true);
  assert.equal(completedStatus.exportState.status, 'complete');
  assert.equal(completedStatus.exportState.filename, 'all.zip');
  assert.equal(harness.archivedSessions.length, 1);
  assert.equal(harness.legacyArchiveCalls, 0);
  assert.equal(harness.downloadCalls, 1);
});

test('个别会话失败时继续下载并在完成状态中报告数量', async () => {
  const harness = createHarness({ historyError: new Error('模拟历史请求失败') });
  const exporting = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  harness.releaseHistory({ messages: [] });

  const response = await exporting;
  const status = readStatus(harness.listener);

  assert.equal(response.ok, true);
  assert.equal(status.exportState.status, 'complete');
  assert.equal(status.exportState.failedCount, 1);
  assert.match(status.exportState.message, /1 个会话失败/);
  assert.match(harness.archivedSessions[0].export_error, /模拟历史请求失败/);
  assert.equal(harness.downloadCalls, 1);
});

test('全量导出复用更新时间相同的历史缓存', async () => {
  const session = { id: 'session-cached', title: '缓存会话', updated_at: 42 };
  const cachedHistory = {
    chat_messages: [{ message_id: 1, role: 'USER' }],
    messages: [{ message_id: 1, role: 'USER' }],
  };
  const cacheRecords = new Map([[cacheRecordKey(session), cachedHistory]]);
  const harness = createHarness({
    cacheRecords,
    sessions: [session],
    async historyLoader() {
      assert.fail('缓存命中时不应请求历史接口');
    },
  });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(response.ok, true);
  assert.equal(harness.historyCalls, 0);
  assert.equal(harness.cacheReadCalls, 1);
  assert.equal(harness.cacheWriteCalls, 0);
  assert.equal(status.exportState.cacheHitCount, 1);
  assert.equal(status.exportState.networkCount, 0);
  assert.deepEqual(harness.archivedSessions[0].messages, cachedHistory.messages);
});

test('全量导出按固定预取窗口批量读取本地缓存', async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `缓存会话 ${index + 1}`,
    updated_at: index + 1,
  }));
  const cacheRecords = new Map(
    sessions.map(session => [cacheRecordKey(session), { messages: [] }]),
  );
  const harness = createHarness({ cacheRecords, sessions });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });

  assert.equal(response.ok, true);
  assert.equal(harness.cacheBatchReadCalls, 3);
  assert.equal(harness.cacheReadCalls, sessions.length);
  assert.equal(harness.historyCalls, 0);
  assert.deepEqual(
    harness.archivedSessions.map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('下载阶段中断后再次导出从已缓存的历史接续', async () => {
  const session = { id: 'session-resume', title: '接续会话', updated_at: 7 };
  const cacheRecords = new Map();
  let downloadAttempts = 0;
  const harness = createHarness({
    cacheRecords,
    sessions: [session],
    async downloadHandler() {
      downloadAttempts++;
      if (downloadAttempts === 1) throw new Error('模拟下载中断');
    },
    async historyLoader(sessionId) {
      return { id: sessionId, messages: [] };
    },
  });

  const first = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const second = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(harness.historyCalls, 1);
  assert.equal(harness.cacheWriteCalls, 1);
  assert.equal(status.exportState.cacheHitCount, 1);
  assert.equal(status.exportState.networkCount, 0);
});

test('大批量下载中断后再次导出仅从窗口缓存重建归档', async () => {
  const sessions = Array.from({ length: 128 }, (_, index) => ({
    id: `resume-${index + 1}`,
    title: `接续会话 ${index + 1}`,
    updated_at: index + 1,
  }));
  const cacheRecords = new Map();
  let downloadAttempts = 0;
  const harness = createHarness({
    cacheRecords,
    sessions,
    contentSetTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    async downloadHandler() {
      downloadAttempts++;
      if (downloadAttempts === 1) throw new Error('模拟大批量下载中断');
    },
    async historyLoader(sessionId) {
      return { id: sessionId, messages: [] };
    },
  });

  const first = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const second = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(harness.historyCalls, sessions.length);
  assert.equal(harness.cacheWriteCalls, sessions.length);
  assert.equal(harness.cacheBatchReadCalls, 16);
  assert.equal(status.exportState.cacheHitCount, sessions.length);
  assert.equal(status.exportState.networkCount, 0);
  assert.deepEqual(
    harness.archivedSessions.slice(-sessions.length).map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('popup 关闭期间发生的导出错误保留在查询状态中', async () => {
  const harness = createHarness({ downloadError: new Error('模拟下载失败') });
  const exporting = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  harness.releaseHistory({ messages: [] });

  const response = await exporting;
  const status = readStatus(harness.listener);

  assert.equal(response.ok, false);
  assert.match(response.error, /模拟下载失败/);
  assert.equal(status.exportState.status, 'error');
  assert.match(status.exportState.message, /模拟下载失败/);
});

test('全量导出以最多两个并发请求拉取历史并保持归档顺序', async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
  }));
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const scheduledWaits = [];
  const harness = createHarness({
    sessions,
    contentSetTimeout(callback, milliseconds) {
      scheduledWaits.push(milliseconds);
      queueMicrotask(callback);
      return 1;
    },
    async historyLoader(sessionId) {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeRequests--;
      return { id: sessionId, messages: [] };
    },
  });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });

  assert.equal(response.ok, true);
  assert.equal(maxActiveRequests, 2);
  assert.equal(scheduledWaits.length, sessions.length - 1);
  assert.ok(scheduledWaits.every(milliseconds => milliseconds >= 700));
  assert.deepEqual(
    harness.archivedSessions.map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('慢请求未结束时继续使用空闲并发槽拉取后续会话', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
  }));
  const startedSessions = [];
  let releaseFirstHistory;
  const firstHistoryGate = new Promise(resolve => {
    releaseFirstHistory = resolve;
  });
  const harness = createHarness({
    sessions,
    contentSetTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    async historyLoader(sessionId) {
      startedSessions.push(sessionId);
      if (sessionId === 'session-1') await firstHistoryGate;
      return { id: sessionId, messages: [] };
    },
  });

  const exporting = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const startedBeforeRelease = [...startedSessions];
  releaseFirstHistory();

  const response = await exporting;

  assert.equal(response.ok, true);
  assert.deepEqual(startedBeforeRelease, sessions.map(session => session.id));
  assert.deepEqual(
    harness.archivedSessions.map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('慢请求前的缓存预取保持在固定窗口内', async () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
    updated_at: index + 1,
  }));
  const cacheRecords = new Map(
    sessions.slice(1).map(session => [cacheRecordKey(session), { messages: [] }]),
  );
  let releaseFirstHistory;
  const firstHistoryGate = new Promise(resolve => {
    releaseFirstHistory = resolve;
  });
  const harness = createHarness({
    cacheRecords,
    sessions,
    async historyLoader(sessionId) {
      if (sessionId === 'session-1') await firstHistoryGate;
      return { id: sessionId, messages: [] };
    },
  });

  const exporting = send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.cacheReadCalls, 16);
  releaseFirstHistory();
  const response = await exporting;

  assert.equal(response.ok, true);
  assert.equal(harness.cacheReadCalls, sessions.length);
});
