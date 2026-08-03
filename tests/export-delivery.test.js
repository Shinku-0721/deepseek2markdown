/**
 * 导出交付与 ZIP 结构测试。
 *
 * 使用真实 fflate 压缩和解压产物，验证单会话文件选择、搜索附件、重名目录及流式归档。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fflate = require('../lib/vendor/fflate.js');
const {
  createArchiveArtifact,
  createArchiveBuilder,
  createSingleArtifact,
} = require('../lib/export-delivery.js');

/**
 * 创建同时包含普通消息和搜索 fragment 的标准测试会话。
 *
 * @param {string} title 会话标题和默认 ID。
 * @returns {object} 可交给导出核心处理的会话。
 */
function createSession(title = '压缩测试') {
  return {
    id: title,
    title,
    messages: [
      {
        message_id: 1,
        role: 'USER',
        fragments: [{ id: 1, type: 'REQUEST', content: '问题' }],
      },
      {
        message_id: 2,
        role: 'ASSISTANT',
        fragments: [
          { id: 3, type: 'TOOL_SEARCH', queries: [{ query: '测试' }], results: [] },
          {
            id: 4,
            type: 'RESPONSE',
            content: '回答[reference:0]',
            references: [{ id: 3, type: 'TOOL_SEARCH' }],
          },
        ],
      },
    ],
  };
}

/**
 * 解压 ZIP 产物并把每个条目解码为 UTF-8 文本。
 *
 * @param {object} artifact 导出交付模块生成的 ZIP 产物。
 * @returns {Promise<object>} 归档路径到文本内容的映射。
 */
async function unzipText(artifact) {
  const content = artifact.content instanceof Blob
    ? new Uint8Array(await artifact.content.arrayBuffer())
    : artifact.content;
  return Object.fromEntries(
    Object.entries(fflate.unzipSync(content))
      .map(([path, bytes]) => [path, fflate.strFromU8(bytes)]),
  );
}

test('单会话 Markdown 存在 Search 文件时打包为标题同名 ZIP', async () => {
  const artifact = await createSingleArtifact('markdown', createSession());
  const files = await unzipText(artifact);

  assert.equal(artifact.filename, '压缩测试.zip');
  assert.equal(artifact.mimeType, 'application/zip');
  assert.deepEqual(Object.keys(files).sort(), [
    '压缩测试/Search/2-3.md',
    '压缩测试/压缩测试.md',
  ]);
  assert.match(files['压缩测试/压缩测试.md'], /\[\[Search\/2-3\]\]/);
});

test('单会话 Markdown 未导出网络搜索时直接返回 Markdown 文件', async () => {
  const artifact = await createSingleArtifact('markdown', createSession(), {
    includeThinking: true,
    includeSearch: false,
  });

  assert.equal(artifact.filename, '压缩测试.md');
  assert.equal(typeof artifact.content, 'string');
  assert.doesNotMatch(artifact.content, /\[reference:|Search\//);
});

test('单会话 JSON 直接返回完整 JSON 文件', async () => {
  const session = createSession();
  const artifact = await createSingleArtifact('json', session);

  assert.equal(artifact.filename, '压缩测试.json');
  assert.deepEqual(JSON.parse(artifact.content), session);
});

test('全会话始终打包，并为重名会话生成独立目录', async () => {
  const first = createSession('同名会话');
  const second = createSession('同名会话');
  second.id = 'second';

  const artifact = await createArchiveArtifact(
    'json',
    [first, second],
    {},
    'deepseek-all-fixed.zip',
  );
  const files = await unzipText(artifact);

  assert.equal(artifact.filename, 'deepseek-all-fixed.zip');
  assert.deepEqual(Object.keys(files).sort(), [
    '同名会话 (2)/同名会话.json',
    '同名会话/同名会话.json',
  ]);
});

test('流式归档允许逐会话写入并以 Blob 保存压缩分块', async () => {
  const builder = createArchiveBuilder('json', {}, 'streamed.zip');
  builder.addSession(createSession('第一条'));
  builder.addSession(createSession('第二条'));

  const artifact = await builder.finish();
  const files = await unzipText(artifact);

  assert.ok(artifact.content instanceof Blob);
  assert.deepEqual(Object.keys(files).sort(), [
    '第一条/第一条.json',
    '第二条/第二条.json',
  ]);
});

test('大批量流式归档解压后保持会话数量、顺序和内容', async () => {
  const sessions = Array.from({ length: 256 }, (_, index) => {
    const session = createSession(`压力会话 ${String(index + 1).padStart(3, '0')}`);
    session.id = `stress-${index + 1}`;
    return session;
  });
  const builder = createArchiveBuilder('json', {}, 'stress.zip');
  for (const session of sessions) builder.addSession(session);

  const artifact = await builder.finish();
  const files = await unzipText(artifact);
  const archivedIds = Object.values(files).map(content => JSON.parse(content).id);

  assert.equal(Object.keys(files).length, sessions.length);
  assert.deepEqual(archivedIds, sessions.map(session => session.id));
});
