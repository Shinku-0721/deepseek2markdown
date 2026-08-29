/**
 * 全量导出 module interface 测试。
 *
 * 测试通过与生产调用者相同的 run interface 覆盖列表、缓存、调度、附件、顺序归档和
 * 失败语义；浏览器消息、状态与下载行为留给内容脚本集成测试。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fflate = require('../lib/vendor/fflate.js');
const { createArchiveBuilder: createRealArchiveBuilder } = require('../lib/export-delivery.js');
const { createAllExport } = require('../lib/all-export.js');

/** 创建按会话修订号命中的内存缓存 adapter。 */
function createMemoryCache(initial = new Map()) {
  const records = new Map(initial);
  const batches = [];
  let writes = 0;

  return {
    batches,
    records,
    get writes() {
      return writes;
    },
    async getMany(sessions) {
      batches.push(sessions.map(session => session.id));
      return new Map(sessions.flatMap(session => {
        const record = records.get(cacheKey(session));
        return record ? [[String(session.id), record]] : [];
      }));
    },
    async put(session, history) {
      writes++;
      records.set(cacheKey(session), history);
      return true;
    },
  };
}

/** 创建记录每次归档输入的轻量 archive adapter。 */
function createArchiveFactory({ artifact = null, finishError = null } = {}) {
  const archives = [];

  function createArchiveBuilder(format, options, filename) {
    const archive = {
      aborted: false,
      filename,
      format,
      options,
      sessions: [],
      sessionOptions: [],
    };
    archives.push(archive);
    return {
      addSession(session, currentOptions) {
        archive.sessions.push(session);
        archive.sessionOptions.push(currentOptions);
      },
      async finish() {
        if (finishError) throw finishError;
        return artifact || {
          filename,
          content: new Blob([new Uint8Array([1])], { type: 'application/zip' }),
          mimeType: 'application/zip',
        };
      },
      abort() {
        archive.aborted = true;
      },
    };
  }

  return { archives, createArchiveBuilder };
}

/** 创建可替换历史请求行为的全量导出测试环境。 */
function createHarness({
  sessions = [{ id: 'session-1', title: '会话 1', updated_at: 1 }],
  historyCache = createMemoryCache(),
  historyLoader = async id => ({ id, messages: [] }),
  uploadedFileLoader = async () => [],
  archiveFactory = createArchiveFactory(),
  now = () => new Date(2026, 0, 2, 3, 4).getTime(),
  wait = async () => {},
} = {}) {
  let historyCalls = 0;
  let uploadedFileCalls = 0;
  const deepSeekClient = {
    async listAllSessions(onPage) {
      onPage?.({ page: 1, total: sessions.length });
      return sessions;
    },
    async getHistoryData(id) {
      historyCalls++;
      return historyLoader(id);
    },
    async fetchUploadedFiles(session) {
      uploadedFileCalls++;
      return uploadedFileLoader(session);
    },
  };
  const allExport = createAllExport({
    deepSeekClient,
    historyCache,
    createArchiveBuilder: archiveFactory.createArchiveBuilder,
    now,
    wait,
  });

  return {
    allExport,
    archiveFactory,
    historyCache,
    get historyCalls() {
      return historyCalls;
    },
    get uploadedFileCalls() {
      return uploadedFileCalls;
    },
  };
}

function cacheKey(session) {
  return JSON.stringify([String(session.id), String(session.updated_at)]);
}

async function unzip(artifact) {
  const bytes = new Uint8Array(await artifact.content.arrayBuffer());
  return fflate.unzipSync(bytes);
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('interface 从会话列表生成含上传文件的 Markdown 归档与执行摘要', async () => {
  const sessions = [
    { id: 'first', title: '第一条', updated_at: 1 },
    { id: 'second', title: '第二条', updated_at: 2 },
  ];
  const progress = [];
  const cache = createMemoryCache();
  const attachment = new Uint8Array([37, 80, 68, 70]);
  const harness = createHarness({
    sessions,
    historyCache: cache,
    archiveFactory: { createArchiveBuilder: createRealArchiveBuilder },
    historyLoader: async id => ({
      id,
      messages: [{ role: 'USER', content: `来自 ${id}` }],
    }),
    uploadedFileLoader: async session => session.id === 'first'
      ? [{ fileName: '报告.pdf', content: attachment, mimeType: 'application/pdf' }]
      : [],
  });

  const result = await harness.allExport.run('markdown', { includeSearch: false }, event => {
    progress.push(event);
  });
  const files = await unzip(result.artifact);

  assert.equal(result.artifact.filename, 'deepseek-all-20260102-0304.zip');
  assert.deepEqual(Object.keys(files).sort(), [
    '第一条/Files/报告.pdf',
    '第一条/第一条.md',
    '第二条/第二条.md',
  ]);
  assert.deepEqual(Array.from(files['第一条/Files/报告.pdf']), Array.from(attachment));
  assert.deepEqual(result.summary, { cacheHitCount: 0, networkCount: 2, failedCount: 0 });
  assert.equal(cache.writes, 2);
  assert.equal(harness.uploadedFileCalls, 2);
  assert.deepEqual(progress.at(-1), {
    type: 'progress',
    stage: 'archive',
    current: 2,
    total: 2,
    cacheHitCount: 0,
    networkCount: 2,
    failedCount: 0,
    message: '正在完成压缩包...',
  });
});

test('缓存未命中写入成功历史，并在连续第二次执行时全部命中', async () => {
  const sessions = [
    { id: 'cached', title: '已缓存', updated_at: 1 },
    { id: 'network', title: '待请求', updated_at: 2 },
  ];
  const cache = createMemoryCache(new Map([
    [cacheKey(sessions[0]), { id: 'cached', messages: [] }],
  ]));
  const archiveFactory = createArchiveFactory();
  const harness = createHarness({ sessions, historyCache: cache, archiveFactory });

  const first = await harness.allExport.run('json');
  const secondProgress = [];
  const second = await harness.allExport.run('json', {}, event => secondProgress.push(event));

  assert.deepEqual(first.summary, { cacheHitCount: 1, networkCount: 1, failedCount: 0 });
  assert.deepEqual(second.summary, { cacheHitCount: 2, networkCount: 0, failedCount: 0 });
  assert.deepEqual(secondProgress.at(-1), {
    type: 'progress',
    stage: 'archive',
    current: 2,
    total: 2,
    cacheHitCount: 2,
    networkCount: 0,
    failedCount: 0,
    message: '正在完成压缩包...',
  });
  assert.equal(harness.historyCalls, 1);
  assert.equal(cache.writes, 1);
  assert.deepEqual(
    archiveFactory.archives[1].sessions.map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('固定窗口限制缓存预取，慢请求结束前不会读取下一窗口', async () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
    updated_at: index + 1,
  }));
  const cache = createMemoryCache(new Map(
    sessions.slice(1).map(session => [cacheKey(session), { messages: [] }]),
  ));
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const harness = createHarness({
    sessions,
    historyCache: cache,
    historyLoader: async id => {
      if (id === 'session-1') await firstGate;
      return { id, messages: [] };
    },
  });

  const exporting = harness.allExport.run('json');
  await nextTurn();

  assert.deepEqual(cache.batches.map(batch => batch.length), [16]);
  releaseFirst();
  await exporting;
  assert.deepEqual(cache.batches.map(batch => batch.length), [16, 4]);
});

test('最多两个历史请求并发，全局启动间隔为 800ms 且慢请求不闲置可用槽', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
  }));
  const started = [];
  const waits = [];
  let clock = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const harness = createHarness({
    sessions,
    now: () => clock,
    wait: async milliseconds => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    historyLoader: async id => {
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      if (id === 'session-1') await firstGate;
      active--;
      return { id, messages: [] };
    },
  });

  const exporting = harness.allExport.run('json');
  await nextTurn();
  const startedBeforeRelease = [...started];
  releaseFirst();
  await exporting;

  assert.equal(maxActive, 2);
  assert.deepEqual(startedBeforeRelease, sessions.map(session => session.id));
  assert.deepEqual(waits, [800, 800, 800, 800]);
});

test('历史请求乱序完成时仍严格按列表顺序归档', async () => {
  const sessions = Array.from({ length: 3 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `会话 ${index + 1}`,
  }));
  const releases = new Map();
  const archiveFactory = createArchiveFactory();
  const harness = createHarness({
    sessions,
    archiveFactory,
    historyLoader: id => new Promise(resolve => {
      releases.set(id, () => resolve({ id, messages: [] }));
    }),
  });

  const exporting = harness.allExport.run('json');
  await nextTurn();
  releases.get('session-2')();
  await nextTurn();
  releases.get('session-3')();
  await nextTurn();
  assert.deepEqual(archiveFactory.archives[0].sessions, []);
  releases.get('session-1')();
  await exporting;

  assert.deepEqual(
    archiveFactory.archives[0].sessions.map(session => session.id),
    sessions.map(session => session.id),
  );
});

test('单会话失败继续归档，并在进度事实和摘要中保留失败数', async () => {
  const sessions = [
    { id: 'failed', title: '失败会话' },
    { id: 'success', title: '成功会话' },
  ];
  const progress = [];
  const archiveFactory = createArchiveFactory();
  const harness = createHarness({
    sessions,
    archiveFactory,
    historyLoader: async id => {
      if (id === 'failed') throw new Error('模拟历史失败');
      return { id, messages: [] };
    },
  });

  const result = await harness.allExport.run('json', {}, event => progress.push(event));
  const failedSession = archiveFactory.archives[0].sessions[0];

  assert.match(failedSession.export_error, /模拟历史失败/);
  assert.deepEqual(failedSession.messages, []);
  assert.equal(archiveFactory.archives[0].sessions[1].id, 'success');
  assert.deepEqual(result.summary, { cacheHitCount: 0, networkCount: 2, failedCount: 1 });
  assert.deepEqual(progress.slice(0, 3), [
    { type: 'progress', stage: 'list', message: '拉取会话列表...' },
    { type: 'progress', stage: 'list', message: '第 1 页 · 已拉取 2 个会话' },
    {
      type: 'progress',
      stage: 'fetch',
      current: 0,
      total: 2,
      cacheHitCount: 0,
      networkCount: 0,
      failedCount: 0,
      message: '开始拉取消息...',
    },
  ]);
  assert.equal(progress.at(-1).failedCount, 1);
});

test('归档结束失败时中止归档并向调用者抛出原始错误', async () => {
  const finishError = new Error('模拟归档失败');
  const archiveFactory = createArchiveFactory({ finishError });
  const harness = createHarness({ archiveFactory });

  await assert.rejects(harness.allExport.run('json'), finishError);
  assert.equal(archiveFactory.archives[0].aborted, true);
});

test('JSON 全量导出保留原始字段且不请求上传文件', async () => {
  const harness = createHarness({
    archiveFactory: { createArchiveBuilder: createRealArchiveBuilder },
    historyLoader: async id => ({ id, raw_field: 42, messages: [] }),
    uploadedFileLoader: async () => {
      assert.fail('JSON 不应请求上传文件');
    },
  });

  const result = await harness.allExport.run('json');
  const files = await unzip(result.artifact);
  const session = JSON.parse(fflate.strFromU8(files['会话 1/会话 1.json']));

  assert.equal(harness.uploadedFileCalls, 0);
  assert.equal(session.raw_field, 42);
  assert.deepEqual(result.summary, { cacheHitCount: 0, networkCount: 1, failedCount: 0 });
});
