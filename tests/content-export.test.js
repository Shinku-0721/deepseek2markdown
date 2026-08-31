/**
 * 内容脚本浏览器 adapter 集成测试。
 *
 * VM 环境只验证 Chrome 消息、任务状态、module 进度转发和产物下载；全量导出的列表、
 * 缓存、调度、顺序、附件与失败继续语义由 all-export module interface 测试覆盖。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

/**
 * 创建隔离的内容脚本环境，并暴露浏览器 adapter 的调用记录。
 *
 * @param {object} options 可替换的 module、当前会话、附件和下载行为。
 * @returns {object} 消息监听器、异步闸门及累计调用统计。
 */
function createHarness({
  blockAllExport = false,
  allExportError = null,
  downloadError = null,
  historyError = null,
  uploadedFiles = [],
  withToken = true,
} = {}) {
  let contentListener = null;
  let tokenListener = null;
  let releaseAllExport = () => {};
  let allExportCalls = 0;
  let downloadCalls = 0;
  let uploadedFileCalls = 0;
  const allExportArguments = [];
  const singleExportOptions = [];
  const runtimeMessages = [];
  const allExportGate = blockAllExport
    ? new Promise(resolve => {
        releaseAllExport = resolve;
      })
    : Promise.resolve();
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
    filename: 'deepseek-all-fixed.zip',
    content: new Blob([new Uint8Array([1])], { type: 'application/zip' }),
    mimeType: 'application/zip',
  };
  const summary = { cacheHitCount: 2, networkCount: 3, failedCount: 1 };
  const context = {
    console,
    setTimeout,
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
          async getHistoryData(id) {
            if (historyError) throw historyError;
            return { id, title: '当前会话', messages: [] };
          },
          async fetchUploadedFiles() {
            uploadedFileCalls++;
            return uploadedFiles;
          },
          async fetchShareContent() {
            throw new Error('unused');
          },
        };
      },
    },
    DeepSeekHistoryCache: {
      createHistoryCache() {
        return { cache: true };
      },
    },
    DeepSeekAllExport: {
      createAllExport() {
        return {
          async run(format, options, onProgress) {
            allExportCalls++;
            allExportArguments.push({ format, options });
            onProgress({
              type: 'progress',
              stage: 'fetch',
              current: 1,
              total: 4,
              ...summary,
              message: '1/4 · 缓存 2 · 请求 3',
            });
            await allExportGate;
            if (allExportError) throw allExportError;
            onProgress({
              type: 'progress',
              stage: 'archive',
              current: 4,
              total: 4,
              ...summary,
              message: '正在完成压缩包...',
            });
            return { artifact, summary };
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
        throw new Error('content adapter 不应直接创建全量归档');
      },
      async createSingleArtifact(_format, _session, options) {
        singleExportOptions.push(options);
        return artifact;
      },
    },
    DeepSeekDownloadClient: {
      async download() {
        downloadCalls++;
        if (downloadError) throw downloadError;
        return { sizeBytes: 1024 };
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../content.js'), 'utf8'),
    context,
    { filename: 'content.js' },
  );

  if (withToken) {
    tokenListener({
      source: windowObject,
      origin: windowObject.location.origin,
      data: { type: 'DS2MD_TOKEN', token: 'Bearer test' },
    });
  }

  return {
    allExportArguments,
    singleExportOptions,
    get allExportCalls() {
      return allExportCalls;
    },
    get downloadCalls() {
      return downloadCalls;
    },
    get uploadedFileCalls() {
      return uploadedFileCalls;
    },
    listener: contentListener,
    releaseAllExport,
    runtimeMessages,
  };
}

/** 将 Chrome 回调式消息调用转换为 Promise。 */
function send(listener, message) {
  return new Promise(resolve => {
    listener(message, {}, resolve);
  });
}

/** 同步读取内容脚本当前状态快照。 */
function readStatus(listener) {
  let status = null;
  listener({ action: 'getStatus' }, {}, value => {
    status = value;
  });
  return status;
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('全量导出状态可恢复、拒绝重复任务并下载 module 产物', async () => {
  const harness = createHarness({ blockAllExport: true });
  const firstExport = send(harness.listener, {
    action: 'exportAll',
    format: 'markdown',
    options: { includeSearch: false },
  });
  await nextTurn();

  const runningStatus = readStatus(harness.listener);
  const duplicateResponse = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  harness.releaseAllExport();
  const firstResponse = await firstExport;
  const completedStatus = readStatus(harness.listener);

  assert.equal(runningStatus.exportState.status, 'running');
  assert.equal(runningStatus.exportState.action, 'exportAll');
  assert.equal(runningStatus.exportState.stage, 'fetch');
  assert.equal(runningStatus.exportState.current, 1);
  assert.equal(duplicateResponse.ok, false);
  assert.equal(duplicateResponse.error, '已有导出任务正在进行');
  assert.equal(firstResponse.ok, true);
  assert.equal(completedStatus.exportState.status, 'complete');
  assert.equal(completedStatus.exportState.filename, 'deepseek-all-fixed.zip');
  assert.equal(completedStatus.exportState.failedCount, 1);
  assert.equal(completedStatus.exportState.cacheHitCount, 2);
  assert.equal(completedStatus.exportState.networkCount, 3);
  assert.match(completedStatus.exportState.message, /1 个会话失败/);
  assert.equal(harness.allExportCalls, 1);
  assert.equal(harness.downloadCalls, 1);
  assert.deepEqual(harness.allExportArguments[0], {
    format: 'markdown',
    options: { includeSearch: false },
  });
  assert.ok(harness.runtimeMessages.some(message => message.stage === 'archive'));
});

test('下载失败后消息响应和状态快照保留原始错误', async () => {
  const harness = createHarness({ downloadError: new Error('模拟下载失败') });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(response.ok, false);
  assert.match(response.error, /模拟下载失败/);
  assert.equal(status.exportState.status, 'error');
  assert.match(status.exportState.message, /模拟下载失败/);
  assert.equal(harness.downloadCalls, 1);
});

test('module 失败时不触发下载并通过消息通道返回错误', async () => {
  const harness = createHarness({ allExportError: new Error('模拟归档中止') });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(response.ok, false);
  assert.match(response.error, /模拟归档中止/);
  assert.equal(status.exportState.status, 'error');
  assert.equal(harness.downloadCalls, 0);
});

test('缺少页面凭证时在调用全量导出 module 前失败', async () => {
  const harness = createHarness({ withToken: false });

  const response = await send(harness.listener, {
    action: 'exportAll',
    format: 'json',
    options: {},
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /未获取到登录凭证/);
  assert.equal(harness.allExportCalls, 0);
  assert.equal(harness.downloadCalls, 0);
});

test('当前会话历史业务错误通过状态通道返回且不触发下载', async () => {
  const harness = createHarness({ historyError: new Error('API 错误: 会话不存在') });

  const response = await send(harness.listener, {
    action: 'exportCurrent',
    format: 'json',
    options: {},
  });
  const status = readStatus(harness.listener);

  assert.equal(response.ok, false);
  assert.match(response.error, /API 错误: 会话不存在/);
  assert.equal(status.exportState.status, 'error');
  assert.match(status.exportState.message, /会话不存在/);
  assert.equal(harness.downloadCalls, 0);
});

test('当前 Markdown 导出仍先获取上传文件再交给单文件交付器', async () => {
  const uploadedFiles = [{
    fileName: '当前附件.pdf',
    content: new Uint8Array([1]),
    mimeType: 'application/pdf',
  }];
  const harness = createHarness({ uploadedFiles });

  const response = await send(harness.listener, {
    action: 'exportCurrent',
    format: 'markdown',
    options: { includeSearch: false },
  });

  assert.equal(response.ok, true);
  assert.equal(harness.uploadedFileCalls, 1);
  assert.equal(harness.singleExportOptions[0].includeSearch, false);
  assert.deepEqual(harness.singleExportOptions[0].attachments, uploadedFiles);
  assert.equal(harness.allExportCalls, 0);
  assert.equal(harness.downloadCalls, 1);
});
