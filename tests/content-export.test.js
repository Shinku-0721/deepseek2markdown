'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createHarness({
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
    get legacyArchiveCalls() {
      return legacyArchiveCalls;
    },
    listener: contentListener,
    releaseHistory,
    runtimeMessages,
  };
}

function send(listener, message) {
  return new Promise(resolve => {
    listener(message, {}, resolve);
  });
}

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

test('全量导出以最多四个并发请求拉取历史并保持归档顺序', async () => {
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
  assert.equal(maxActiveRequests, 4);
  assert.equal(scheduledWaits.length, sessions.length - 1);
  assert.ok(scheduledWaits.every(milliseconds => milliseconds >= 300));
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
