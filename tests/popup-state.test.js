/**
 * Popup 状态恢复测试。
 *
 * 在 VM 中构造最小 DOM 和 Chrome API，验证 Popup 重开后恢复全量导出进度并禁用按钮。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

/** 模拟测试所需的 DOMTokenList 子集。 */
class FakeClassList {
  /**
   * @param {...string} values 初始类名。
   */
  constructor(...values) {
    this.values = new Set(values);
  }

  /** @param {...string} values 待添加类名。 */
  add(...values) {
    for (const value of values) this.values.add(value);
  }

  /** @param {...string} values 待移除类名。 */
  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  /**
   * @param {string} value 待查询类名。
   * @returns {boolean} 类名存在时返回 true。
   */
  contains(value) {
    return this.values.has(value);
  }
}

/**
 * 创建 Popup 控件使用的最小 DOM 元素替身。
 *
 * @param {string} id 元素 ID。
 * @returns {object} 包含状态字段和事件注册接口的元素。
 */
function createElement(id) {
  return {
    id,
    checked: false,
    className: '',
    classList: new FakeClassList(id === 'progressArea' ? 'hidden' : ''),
    disabled: false,
    listeners: new Map(),
    style: {},
    textContent: '',
    value: '',
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
  };
}

test('popup 初始化时恢复正在进行的导出状态并禁用重复操作', async () => {
  const elements = new Map();
  /** 按 ID 惰性创建并复用测试元素。 */
  const byId = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    document: { getElementById: byId },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        async query() {
          return [{ id: 9, url: 'https://chat.deepseek.com/a/chat/s/test' }];
        },
        async sendMessage(_tabId, message) {
          assert.equal(message.action, 'getStatus');
          return {
            hasToken: true,
            sessionId: '12345678-1234-1234-1234-123456789abc',
            exportState: {
              status: 'running',
              action: 'exportAll',
              format: 'json',
              stage: 'fetch',
              current: 420,
              total: 1000,
              message: '420/1000 · 测试会话',
            },
          };
        },
      },
    },
    DeepSeekClient: {
      createDeepSeekClient() {
        return { fetchShareContent: async () => ({}) };
      },
    },
    DeepSeekExportCore: {
      DEFAULT_MARKDOWN_OPTIONS: {
        includeThinking: true,
        includeSearch: true,
        branchMode: 'latest',
      },
    },
    DeepSeekExportDelivery: {},
    DeepSeekDownloadClient: {},
  };
  context.globalThis = context;

  vm.runInNewContext(
    fs.readFileSync(require.resolve('../popup/popup.js'), 'utf8'),
    context,
    { filename: 'popup.js' },
  );
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(byId('progressArea').classList.contains('hidden'), false);
  assert.equal(byId('progressBar').style.width, '44%');
  assert.equal(byId('progressText').textContent, '420/1000 · 测试会话');
  for (const id of [
    'btnCurMd',
    'btnCurJson',
    'btnAllMd',
    'btnAllJson',
    'btnShareMd',
    'btnShareJson',
  ]) {
    assert.equal(byId(id).disabled, true, `${id} 应在导出期间禁用`);
  }
});

test('非 DeepSeek 标签页的分享 Markdown 导出也会拉取上传文件', async () => {
  const elements = new Map();
  /** 按 ID 惰性创建并复用测试元素。 */
  const byId = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  byId('includeThinking').checked = true;
  byId('includeSearch').checked = true;
  byId('branchLatest').checked = true;
  byId('shareInput').value = 'share-123';

  const uploadedFiles = [{
    fileName: '附件.pdf',
    content: new Uint8Array([1, 2, 3]),
    mimeType: 'application/pdf',
  }];
  let fetchShareCalls = 0;
  let fetchUploadedFileCalls = 0;
  let artifactOptions = null;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    document: { getElementById: byId },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        async query() {
          return [{ id: 9, url: 'https://example.com/' }];
        },
      },
    },
    DeepSeekClient: {
      createDeepSeekClient() {
        return {
          async fetchShareContent() {
            fetchShareCalls++;
            return { data: { biz_data: { title: '分享会话', messages: [] } } };
          },
          async fetchUploadedFiles() {
            fetchUploadedFileCalls++;
            return uploadedFiles;
          },
        };
      },
    },
    DeepSeekExportCore: {
      DEFAULT_MARKDOWN_OPTIONS: {
        includeThinking: true,
        includeSearch: true,
        branchMode: 'latest',
      },
      parseShareId(raw) {
        return raw;
      },
      createShareSession(payload) {
        return payload.data.biz_data;
      },
    },
    DeepSeekExportDelivery: {
      async createSingleArtifact(_format, _session, options) {
        artifactOptions = options;
        return { filename: 'share.zip' };
      },
    },
    DeepSeekDownloadClient: {
      async download() {
        return { sizeBytes: 1234 };
      },
    },
  };
  context.globalThis = context;

  vm.runInNewContext(
    fs.readFileSync(require.resolve('../popup/popup.js'), 'utf8'),
    context,
    { filename: 'popup.js' },
  );
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  await elements.get('btnShareMd').listeners.get('click')();

  assert.equal(fetchShareCalls, 1);
  assert.equal(fetchUploadedFileCalls, 1);
  assert.deepEqual(artifactOptions.attachments, uploadedFiles);
  assert.match(elements.get('progressText').textContent, /导出完成/);
});
