/**
 * 将会话文件集合转换为单文件或 ZIP 下载产物。
 */
(function publishExportDelivery(root, createDelivery) {
  const isCommonJs = typeof module === 'object' && module.exports;
  const exportCore = isCommonJs ? require('./export-core.js') : root.DeepSeekExportCore;
  const compression = isCommonJs ? require('./vendor/fflate.js') : root.fflate;
  const delivery = createDelivery(exportCore, compression);

  if (isCommonJs) {
    module.exports = delivery;
  } else {
    root.DeepSeekExportDelivery = delivery;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDelivery(exportCore, compression) {
  'use strict';

  if (!exportCore || !compression) throw new Error('导出交付依赖加载失败');

  async function createSingleArtifact(format, session, options = {}) {
    const bundle = exportCore.createSessionExport(format, session, options);

    // 单文件直接下载；存在 Search 附件时必须压缩，才能维持 Wiki 相对链接的目录结构。
    if (bundle.files.length === 1) {
      const [file] = bundle.files;
      return { ...file, filename: file.path };
    }

    const entries = bundle.files.map(file => ({
      ...file,
      path: bundle.name + '/' + file.path,
    }));
    return createZipArtifact(bundle.name + '.zip', entries);
  }

  async function createArchiveArtifact(format, sessions, options = {}, archiveName = 'deepseek-all.zip') {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error('没有可导出的会话');
    }

    const builder = createArchiveBuilder(format, options, archiveName);
    try {
      for (const session of sessions) builder.addSession(session);
      return await builder.finish();
    } catch (error) {
      builder.abort();
      throw error;
    }
  }

  function createArchiveBuilder(format, options = {}, archiveName = 'deepseek-all.zip') {
    const output = createZipOutput(ensureZipExtension(archiveName));
    const usedNames = new Set();
    let sessionCount = 0;
    let closed = false;
    let finishPromise = null;

    function addSession(session) {
      if (closed) throw new Error('ZIP 归档已经结束');

      const bundle = exportCore.createSessionExport(format, session, options);
      const directory = uniqueDirectoryName(bundle.name, usedNames);
      for (const file of bundle.files) {
        output.addFile({ ...file, path: directory + '/' + file.path });
      }
      sessionCount++;
    }

    function finish() {
      if (finishPromise) return finishPromise;
      if (sessionCount === 0) {
        abort();
        return Promise.reject(new Error('没有可导出的会话'));
      }

      closed = true;
      finishPromise = output.finish();
      return finishPromise;
    }

    function abort() {
      if (closed) return;
      closed = true;
      output.abort();
    }

    return Object.freeze({ addSession, finish, abort });
  }

  async function createZipArtifact(filename, files) {
    const output = createZipOutput(filename);
    try {
      for (const file of files) output.addFile(file);
      return await output.finish();
    } catch (error) {
      output.abort();
      throw error;
    }
  }

  function createZipOutput(filename) {
    const chunks = [];
    const usedPaths = new Set();
    let closed = false;
    let settled = false;
    let resolveOutput;
    let rejectOutput;

    const completion = new Promise((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // addFile 期间也可能同步报告压缩错误，提前挂载处理器避免未处理拒绝。
    void completion.catch(() => {});

    const zip = new compression.Zip((error, data, final) => {
      if (settled) return;
      if (error) {
        settled = true;
        rejectOutput(error);
        return;
      }
      if (data?.length) chunks.push(data);
      if (final) {
        settled = true;
        resolveOutput({
          filename,
          content: new Blob(chunks, { type: 'application/zip' }),
          mimeType: 'application/zip',
        });
      }
    });

    function addFile(file) {
      if (closed) throw new Error('ZIP 归档已经结束');

      const path = normalizeArchivePath(file.path);
      if (usedPaths.has(path)) throw new Error('ZIP 内存在重复路径: ' + path);
      usedPaths.add(path);

      const entry = new compression.ZipDeflate(path, { level: 6 });
      zip.add(entry);
      entry.push(toArchiveBytes(file.content), true);
    }

    function finish() {
      if (!closed) {
        closed = true;
        zip.end();
      }
      return completion;
    }

    function abort() {
      if (closed) return;
      closed = true;
      zip.terminate();
    }

    return Object.freeze({ addFile, finish, abort });
  }

  function toArchiveBytes(content) {
    if (typeof content === 'string') return compression.strToU8(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) {
      return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    throw new Error('ZIP 文件内容无效');
  }

  function uniqueDirectoryName(baseName, usedNames) {
    let candidate = baseName;
    let sequence = 2;

    while (usedNames.has(candidate.toLocaleLowerCase())) {
      candidate = `${baseName} (${sequence})`;
      sequence++;
    }
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
  }

  function normalizeArchivePath(value) {
    // ZIP 路径只能是相对路径，拒绝空段和目录回退以避免解压路径穿越。
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('ZIP 路径无效: ' + value);
    }
    return path;
  }

  function ensureZipExtension(value) {
    const name = String(value || 'deepseek-all.zip')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .trim() || 'deepseek-all.zip';
    return name.toLowerCase().endsWith('.zip') ? name : name + '.zip';
  }

  return Object.freeze({
    createArchiveArtifact,
    createArchiveBuilder,
    createSingleArtifact,
  });
});
