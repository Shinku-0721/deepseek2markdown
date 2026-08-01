'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionExport,
  createShareSession,
  parseShareId,
} = require('../lib/export-core.js');

function createSession(overrides = {}) {
  return {
    id: 'session-123',
    title: 'Vite 与 Vue 的关系',
    custom_session_field: { retained: true },
    messages: [
      {
        message_id: 1,
        parent_id: null,
        role: 'USER',
        custom_message_field: '保留',
        fragments: [
          { id: 1, type: 'REQUEST', content: 'vite 是什么，和 vue 的关系是？' },
        ],
      },
      {
        message_id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        conversation_mode: 'DEEP_SEARCH',
        search_triggered: true,
        fragments: [
          {
            id: 2,
            type: 'THINK',
            content: '先确认 Vite 和 Vue 的职责。',
            elapsed_secs: 1.25,
            references: [],
            stage_id: 1,
          },
          {
            id: 3,
            type: 'TOOL_SEARCH',
            content: null,
            queries: [{ query: 'vite 是什么' }, { query: 'vite vue 关系' }],
            results: [{
              url: 'https://cn.vite.dev/guide/why',
              title: '为什么选 Vite',
              snippet: 'Vite 提供快速的开发服务器。',
              site_icon: 'https://cn.vite.dev/logo.svg',
              site_name: 'Vite',
              query_indexes: [0, 1],
            }],
            stage_id: 1,
          },
          {
            id: 5,
            type: 'TOOL_OPEN',
            content: null,
            result: {
              url: 'https://cn.vuejs.org/guide/scaling-up/tooling.html',
              title: '工具链',
              snippet: 'Vue 官方推荐使用 Vite。',
              site_icon: 'https://cn.vuejs.org/logo.svg',
              site_name: 'Vue.js',
              query_indexes: [1],
            },
            reference: { id: 3, type: 'TOOL_SEARCH' },
            stage_id: 2,
          },
          {
            id: 6,
            type: 'RESPONSE',
            content: 'Vite 是构建工具[reference:0]，Vue 是 UI 框架[reference:1]。',
            references: [
              { id: 3, type: 'TOOL_SEARCH' },
              { id: 5, type: 'TOOL_OPEN' },
            ],
            stage_id: 3,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function fileByPath(bundle, path) {
  return bundle.files.find(file => file.path === path);
}

test('parseShareId 只接受 DeepSeek 分享地址或合法 ID', () => {
  assert.equal(parseShareId('abc_123'), 'abc_123');
  assert.equal(parseShareId('/share/abc-123'), 'abc-123');
  assert.equal(parseShareId('https://chat.deepseek.com/share/abc-123?from=test'), 'abc-123');
  assert.equal(parseShareId('https://example.com/share/abc-123'), null);
  assert.equal(parseShareId('short'), null);
});

test('Markdown 默认包含思考和网络搜索，并将引用转换为复合搜索 ID', () => {
  const bundle = createSessionExport('markdown', createSession());
  const main = fileByPath(bundle, 'Vite 与 Vue 的关系.md');

  assert.equal(bundle.name, 'Vite 与 Vue 的关系');
  assert.ok(main);
  assert.match(main.content, /^# Vite 与 Vue 的关系/m);
  assert.match(main.content, /> \[!question\] 提问/);
  assert.match(main.content, /vite 是什么，和 vue 的关系是？\n\n---\n/);
  assert.match(main.content, /<details>\n<summary>思考过程 · 1\.25s<\/summary>/);
  assert.match(main.content, /> \[!info\] 网络搜索/);
  assert.match(main.content, /\[\[Search\/2-3\]\]/);
  assert.match(main.content, /\[\[Search\/2-5\]\]/);
  assert.match(main.content, /Vite 是构建工具\[\[Search\/2-3\]\]/);
  assert.doesNotMatch(main.content, /## (THINK|RESPONSE)/);

  const searchFile = fileByPath(bundle, 'Search/2-3.md').content;
  assert.match(searchFile, /# 搜索 2-3/);
  assert.match(searchFile, /```\nVite 提供快速的开发服务器。\n```/);
  assert.doesNotMatch(searchFile, /^> Vite 提供快速的开发服务器。$/m);

  const openFile = fileByPath(bundle, 'Search/2-5.md').content;
  assert.match(openFile, /来源：\[\[Search\/2-3\]\]/);
  assert.doesNotMatch(
    searchFile + '\n' + openFile,
    /Fragment ID|^- 阶段：|^- 匹配查询：/m,
  );
});

test('Search 预览含代码围栏时自动加长外层围栏', () => {
  const session = createSession();
  const searchFragment = session.messages[1].fragments
    .find(fragment => fragment.type === 'TOOL_SEARCH');
  searchFragment.results[0].snippet = '**保持原样**\n```markdown\n# 不是标题\n```';

  const bundle = createSessionExport('markdown', session);
  const searchFile = fileByPath(bundle, 'Search/2-3.md').content;

  assert.ok(searchFile.includes(
    '````\n**保持原样**\n```markdown\n# 不是标题\n```\n````',
  ));
  assert.doesNotMatch(searchFile, /^> /m);
});

test('深度搜索过程按 fragment 原顺序导出', () => {
  const session = createSession({
    messages: [
      {
        message_id: 1,
        parent_id: null,
        role: 'USER',
        fragments: [{ id: 1, type: 'REQUEST', content: 'Markdown 支持引用吗？' }],
      },
      {
        message_id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        fragments: [
          { id: 2, type: 'THINK', content: '规划搜索', elapsed_secs: 1 },
          {
            id: 3,
            type: 'TOOL_SEARCH',
            queries: [{ query: 'Markdown 引用语法' }],
            results: [],
          },
          { id: 4, type: 'THINK', content: '分析搜索结果', elapsed_secs: 2 },
          {
            id: 5,
            type: 'TOOL_OPEN',
            result: { title: 'Markdown 区块引用', url: 'https://example.com/blockquote' },
            reference: { id: 3, type: 'TOOL_SEARCH' },
          },
          { id: 6, type: 'THINK', content: '组织最终回答', elapsed_secs: 3 },
          { id: 7, type: 'RESPONSE', content: '回答正文' },
        ],
      },
    ],
  });

  const main = createSessionExport('markdown', session).files[0].content;
  const orderedTokens = [
    '规划搜索',
    '搜索「Markdown 引用语法」',
    '分析搜索结果',
    '打开「Markdown 区块引用」',
    '组织最终回答',
    '</details>',
    '回答正文',
  ];
  let previousIndex = -1;

  for (const token of orderedTokens) {
    const index = main.indexOf(token);
    assert.ok(index > previousIndex, `导出顺序错误：${token}`);
    previousIndex = index;
  }
  assert.match(main, /<summary>思考过程 · 6s<\/summary>/);
});

test('关闭网络搜索后不生成 Search 文件，并清理正文中的引用标记', () => {
  const bundle = createSessionExport('markdown', createSession(), {
    includeThinking: true,
    includeSearch: false,
  });
  const main = bundle.files[0];

  assert.deepEqual(bundle.files.map(file => file.path), ['Vite 与 Vue 的关系.md']);
  assert.doesNotMatch(main.content, /网络搜索|Search\/|\[reference:/i);
  assert.match(main.content, /Vite 是构建工具，Vue 是 UI 框架。/);
  assert.match(main.content, /<summary>思考过程/);
});

test('关闭思考后只隐藏 THINK，网络搜索和回答仍保留', () => {
  const bundle = createSessionExport('markdown', createSession(), {
    includeThinking: false,
    includeSearch: true,
  });
  const main = bundle.files[0];

  assert.doesNotMatch(main.content, /思考过程|先确认 Vite/);
  assert.match(main.content, /网络搜索/);
  assert.match(main.content, /Vite 是构建工具/);
});

test('多轮会话使用 message_id 与 fragment id 组成搜索 ID，避免文件覆盖', () => {
  const first = createSession();
  const secondUser = {
    message_id: 3,
    parent_id: 2,
    role: 'USER',
    fragments: [{ id: 1, type: 'REQUEST', content: '那生产构建呢？' }],
  };
  const secondAssistant = {
    message_id: 4,
    parent_id: 3,
    role: 'ASSISTANT',
    fragments: [
      { id: 3, type: 'TOOL_SEARCH', queries: [{ query: 'vite build' }], results: [], stage_id: 1 },
      {
        id: 4,
        type: 'RESPONSE',
        content: '使用 vite build[reference:0]。',
        references: [{ id: 3, type: 'TOOL_SEARCH' }],
      },
    ],
  };
  first.messages.push(secondUser, secondAssistant);

  const bundle = createSessionExport('markdown', first);
  const paths = bundle.files.map(file => file.path);
  const main = bundle.files[0].content;

  assert.ok(paths.includes('Search/2-3.md'));
  assert.ok(paths.includes('Search/4-3.md'));
  assert.equal((main.match(/> \[!question\] 提问/g) || []).length, 2);
  assert.doesNotMatch(main, /^## 第 \d+ 轮$/m);
  assert.match(main, /\[\[Search\/4-3\]\]/);
});

test('分支展示可在全部记录与最后一条消息链之间切换', () => {
  const session = {
    id: 'branched-session',
    title: '分支会话',
    messages: [
      {
        message_id: 1,
        parent_id: null,
        role: 'USER',
        fragments: [{ id: 1, type: 'REQUEST', content: '初始问题' }],
      },
      {
        message_id: 2,
        parent_id: 1,
        role: 'ASSISTANT',
        fragments: [{ id: 2, type: 'RESPONSE', content: '初始回答' }],
      },
      {
        message_id: 3,
        parent_id: 2,
        role: 'USER',
        fragments: [{ id: 1, type: 'REQUEST', content: '更换构建工具或更换一脸呃' }],
      },
      {
        message_id: 4,
        parent_id: 3,
        role: 'ASSISTANT',
        fragments: [{ id: 2, type: 'THINK', content: '旧分支思考' }],
      },
      {
        message_id: 5,
        parent_id: 2,
        role: 'USER',
        fragments: [{ id: 1, type: 'REQUEST', content: '更换构建工具或更换依赖呢' }],
      },
      {
        message_id: 6,
        parent_id: 5,
        role: 'ASSISTANT',
        fragments: [{ id: 2, type: 'RESPONSE', content: '第一次运行回答' }],
      },
      {
        message_id: 7,
        parent_id: 5,
        role: 'ASSISTANT',
        fragments: [{ id: 2, type: 'RESPONSE', content: '最后一次运行回答' }],
      },
    ],
  };

  const defaultOutput = createSessionExport('markdown', session).files[0].content;
  const partialOptions = createSessionExport('markdown', session, { includeSearch: false }).files[0].content;
  const all = createSessionExport('markdown', session, { branchMode: 'all' }).files[0].content;
  const latest = createSessionExport('markdown', session, { branchMode: 'latest' }).files[0].content;

  assert.equal(defaultOutput, latest);
  assert.doesNotMatch(partialOptions, /更换构建工具或更换一脸呃|第一次运行回答/);
  assert.match(all, /更换构建工具或更换一脸呃/);
  assert.match(all, /第一次运行回答/);
  assert.match(all, /最后一次运行回答/);
  assert.doesNotMatch(latest, /更换构建工具或更换一脸呃|旧分支思考|第一次运行回答/);
  assert.match(latest, /更换构建工具或更换依赖呢/);
  assert.match(latest, /最后一次运行回答/);
});

test('JSON 将完整 session 原样写入标题同名文件', () => {
  const session = createSession();
  const bundle = createSessionExport('json', session, {
    includeThinking: false,
    includeSearch: false,
    branchMode: 'latest',
  });

  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].path, 'Vite 与 Vue 的关系.json');
  assert.deepEqual(JSON.parse(bundle.files[0].content), session);
});

test('createShareSession 保留分享响应中的真实字段结构', () => {
  const payload = {
    data: {
      biz_data: {
        title: '分享会话',
        model: 'deepseek-chat',
        custom_share_field: 42,
        chat_messages: [{ role: 'USER', content: '你好' }],
      },
    },
  };

  assert.deepEqual(createShareSession(payload, 'share_123'), {
    id: 'share_123',
    title: '分享会话',
    model: 'deepseek-chat',
    custom_share_field: 42,
    chat_messages: [{ role: 'USER', content: '你好' }],
  });
});
