/**
 * Popup 发布资源测试。
 *
 * 验证首屏不依赖远程字体或样式，且 HTML/CSS 引用的本地资源会随 popup 目录发布。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const popupDirectory = path.join(repositoryRoot, 'popup');

/** 断言相对于指定文件的资源引用存在于仓库中。 */
function assertLocalResourcesExist(sourceFile, references) {
  for (const reference of references) {
    if (
      !reference
      || reference.startsWith('data:')
      || reference.startsWith('#')
      || reference.startsWith('%23')
    ) continue;
    assert.doesNotMatch(reference, /^https?:\/\//i, `存在运行时远程资源: ${reference}`);
    const target = path.resolve(path.dirname(sourceFile), reference.split(/[?#]/)[0]);
    assert.equal(fs.existsSync(target), true, `本地资源不存在: ${reference}`);
  }
}

test('Popup HTML 和 CSS 仅引用随扩展提供的本地资源', () => {
  const htmlFile = path.join(popupDirectory, 'popup.html');
  const cssFile = path.join(popupDirectory, 'popup.css');
  const html = fs.readFileSync(htmlFile, 'utf8');
  const css = fs.readFileSync(cssFile, 'utf8');
  const htmlReferences = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map(match => match[1]);
  const cssReferences = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)]
    .map(match => match[1]);

  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/i);
  assertLocalResourcesExist(htmlFile, htmlReferences);
  assertLocalResourcesExist(cssFile, cssReferences);
});

test('发布工作流递归打包 Popup 目录及其资源', () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );

  assert.match(workflow, /^\s+popup\s*$/m);
  assert.equal(fs.existsSync(path.join(popupDirectory, 'assets', 'logo.png')), true);
  assert.equal(fs.existsSync(path.join(popupDirectory, 'assets', 'bg-blobs.png')), true);
});
