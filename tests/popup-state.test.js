'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class FakeClassList {
  constructor(...values) {
    this.values = new Set(values);
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

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
