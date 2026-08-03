/**
 * 浏览器下载客户端测试。
 *
 * 验证 Blob URL、隐藏下载链接、延迟释放以及同步点击失败时的立即清理。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDownloadClient } = require('../lib/download-client.js');

/**
 * 创建可观测 DOM、URL 和计时器副作用的下载环境。
 *
 * @param {object} options 可选点击异常。
 * @returns {object} 下载客户端、链接替身及清理状态读取器。
 */
function createHarness({ clickError = null } = {}) {
  let appended = null;
  let cleanup = null;
  let removed = false;
  let revokedUrl = null;
  const anchor = {
    style: {},
    click() {
      if (clickError) throw clickError;
    },
    remove() {
      removed = true;
    },
  };
  const client = createDownloadClient({
    Blob,
    URL: {
      createObjectURL(blob) {
        assert.equal(blob.size, 4);
        return 'blob:https://chat.deepseek.com/test-id';
      },
      revokeObjectURL(url) {
        revokedUrl = url;
      },
    },
    document: {
      body: {
        appendChild(element) {
          appended = element;
        },
      },
      createElement(tagName) {
        assert.equal(tagName, 'a');
        return anchor;
      },
    },
    setTimeout(callback, milliseconds) {
      cleanup = { callback, milliseconds };
      return 1;
    },
  });

  return {
    anchor,
    client,
    get appended() {
      return appended;
    },
    get cleanup() {
      return cleanup;
    },
    get removed() {
      return removed;
    },
    get revokedUrl() {
      return revokedUrl;
    },
  };
}

test('下载客户端在 Blob URL 的创建页面内触发下载并延迟释放 URL', async () => {
  const harness = createHarness();
  const result = await harness.client.download({
    filename: 'large.zip',
    content: new Uint8Array([1, 2, 3, 4]),
    mimeType: 'application/zip',
  });

  assert.equal(harness.appended, harness.anchor);
  assert.equal(harness.anchor.href, 'blob:https://chat.deepseek.com/test-id');
  assert.equal(harness.anchor.download, 'large.zip');
  assert.equal(harness.anchor.style.display, 'none');
  assert.equal(harness.cleanup.milliseconds, 60_000);
  assert.equal(harness.removed, false);
  assert.equal(harness.revokedUrl, null);
  assert.deepEqual(result, { sizeBytes: 4 });

  harness.cleanup.callback();
  assert.equal(harness.removed, true);
  assert.equal(harness.revokedUrl, harness.anchor.href);
});

test('页面拒绝触发下载时立即清理 Blob URL 并返回原始错误', async () => {
  const harness = createHarness({ clickError: new Error('模拟点击失败') });

  await assert.rejects(
    harness.client.download({
      filename: 'failed.zip',
      content: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'application/zip',
    }),
    /模拟点击失败/,
  );

  assert.equal(harness.cleanup, null);
  assert.equal(harness.removed, true);
  assert.equal(harness.revokedUrl, 'blob:https://chat.deepseek.com/test-id');
});
