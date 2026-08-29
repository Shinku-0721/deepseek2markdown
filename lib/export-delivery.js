/**
 * 导出交付模块。
 *
 * 将核心模块产生的文件集合转换为可下载单文件或 ZIP Blob。全量导出使用增量构建器，
 * 会话一旦就绪即可写入压缩流，无需把所有格式化文本同时保留在普通 JavaScript 对象中。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布交付接口。 */
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
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 绑定核心渲染器和 fflate 压缩实现并创建交付接口。
 *
 * @param {object} exportCore 会话文件渲染模块。
 * @param {object} compression fflate 压缩接口。
 * @returns {object} 冻结后的交付接口。
 */
function createDelivery(exportCore, compression) {
  'use strict';

  if (!exportCore || !compression) throw new Error('导出交付依赖加载失败');

  /**
   * 创建单会话下载产物。
   *
   * 只有一个文件时直接返回该文件；Markdown 包含 Search 或 Files 资源时生成 ZIP。
   *
   * @param {'markdown'|'json'} format 目标格式。
   * @param {object} session 会话数据。
   * @param {object} options Markdown 展示选项。
   * @returns {Promise<object>} 包含 filename、content 和 mimeType 的下载产物。
   */
  async function createSingleArtifact(format, session, options = {}) {
    const bundle = exportCore.createSessionExport(format, session, options);

    // 单文件直接下载；存在关联资源时必须压缩，才能维持 Markdown 相对链接的目录结构。
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

  /**
   * 一次性把会话数组写入 ZIP，主要供小规模调用和测试使用。
   *
   * @param {'markdown'|'json'} format 目标格式。
   * @param {object[]} sessions 非空会话数组。
   * @param {object} options Markdown 展示选项。
   * @param {string} archiveName 归档文件名。
   * @returns {Promise<object>} 完成的 ZIP 下载产物。
   */
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

  /**
   * 创建可逐会话写入的全量归档构建器。
   *
   * 构建器只能结束或中止一次；finish 可重复调用并返回同一 Promise，防止重复结束压缩流。
   *
   * @param {'markdown'|'json'} format 目标格式。
   * @param {object} options Markdown 展示选项。
   * @param {string} archiveName 归档文件名。
   * @returns {{addSession: Function, finish: Function, abort: Function}} 冻结后的构建器。
   */
  function createArchiveBuilder(format, options = {}, archiveName = 'deepseek-all.zip') {
    const output = createZipOutput(ensureZipExtension(archiveName));
    const usedNames = new Set();
    let sessionCount = 0;
    // closed 同时保护正常结束和异常中止，确保底层 ZIP 流不会被二次操作。
    let closed = false;
    let finishPromise = null;

    /**
     * 渲染并写入一个会话，为重名标题分配唯一目录。
     *
     * @param {object} session 会话数据。
     * @param {object} sessionOptions 当前会话独有的附件等导出选项。
     */
    function addSession(session, sessionOptions = {}) {
      if (closed) throw new Error('ZIP 归档已经结束');

      const bundle = exportCore.createSessionExport(format, session, {
        ...options,
        ...sessionOptions,
      });
      const directory = uniqueDirectoryName(bundle.name, usedNames);
      for (const file of bundle.files) {
        output.addFile({ ...file, path: directory + '/' + file.path });
      }
      sessionCount++;
    }

    /**
     * 结束 ZIP 输入流并等待 Blob 产物。
     *
     * @returns {Promise<object>} ZIP 下载产物；尚未写入会话时返回拒绝 Promise。
     */
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

    /** 中止尚未结束的归档并释放压缩器资源；重复调用不会产生副作用。 */
    function abort() {
      if (closed) return;
      closed = true;
      output.abort();
    }

    return Object.freeze({ addSession, finish, abort });
  }

  /**
   * 将已经准备好的文件数组写入单个 ZIP。
   *
   * @param {string} filename ZIP 文件名。
   * @param {object[]} files 文件描述数组。
   * @returns {Promise<object>} ZIP 下载产物。
   */
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

  /**
   * 创建底层流式 ZIP 输出器。
   *
   * fflate 通过回调分块输出压缩数据；这里保留压缩分块，直到 final 信号到达后才组合 Blob。
   * 每个路径只允许写入一次，并在写入前执行路径穿越校验。
   *
   * @param {string} filename 最终下载文件名。
   * @returns {{addFile: Function, finish: Function, abort: Function}} 流式输出接口。
   */
  function createZipOutput(filename) {
    // chunks 保存已经压缩的 Uint8Array 分块，而不是未压缩的全部会话文本。
    const chunks = [];
    const usedPaths = new Set();
    let closed = false;
    let settled = false;
    let resolveOutput;
    let rejectOutput;

    // completion 把 fflate 的回调生命周期转换为便于上层等待的 Promise。
    const completion = new Promise((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // addFile 期间也可能同步报告压缩错误，提前挂载处理器避免未处理拒绝。
    void completion.catch(() => {});

    // fflate 可能多次回调数据分块，只有 final=true 才代表中央目录已经写完。
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

    /**
     * 校验路径并把一个文件完整写入独立 Deflate 条目。
     *
     * @param {{path: string, content: *}} file 文件描述。
     */
    function addFile(file) {
      if (closed) throw new Error('ZIP 归档已经结束');

      const path = normalizeArchivePath(file.path);
      if (usedPaths.has(path)) throw new Error('ZIP 内存在重复路径: ' + path);
      usedPaths.add(path);

      const entry = new compression.ZipDeflate(path, { level: 6 });
      zip.add(entry);
      entry.push(toArchiveBytes(file.content), true);
    }

    /**
     * 结束 ZIP 流并返回共享完成 Promise。
     *
     * @returns {Promise<object>} ZIP 下载产物。
     */
    function finish() {
      if (!closed) {
        closed = true;
        zip.end();
      }
      return completion;
    }

    /** 终止尚未结束的 fflate ZIP 流；已结束时不执行任何操作。 */
    function abort() {
      if (closed) return;
      closed = true;
      zip.terminate();
    }

    return Object.freeze({ addFile, finish, abort });
  }

  /**
   * 把支持的文本或二进制内容统一转换为 Uint8Array。
   *
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} content 文件内容。
   * @returns {Uint8Array} 可写入压缩条目的字节视图。
   */
  function toArchiveBytes(content) {
    if (typeof content === 'string') return compression.strToU8(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) {
      return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    throw new Error('ZIP 文件内容无效');
  }

  /**
   * 在大小写不敏感语义下为会话目录生成唯一名称。
   *
   * @param {string} baseName 标题生成的基础目录名。
   * @param {Set<string>} usedNames 已占用的小写目录名集合。
   * @returns {string} 未使用的目录名，重名时追加递增序号。
   */
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

  /**
   * 规范化并验证 ZIP 内部相对路径，阻止空段、当前目录和父目录回退。
   *
   * @param {*} value 原始归档路径。
   * @returns {string} 使用正斜杠的安全相对路径。
   */
  function normalizeArchivePath(value) {
    // ZIP 路径只能是相对路径，拒绝空段和目录回退以避免解压路径穿越。
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('ZIP 路径无效: ' + value);
    }
    return path;
  }

  /**
   * 清理归档文件名中的平台保留字符，并确保以 .zip 结尾。
   *
   * @param {*} value 原始文件名。
   * @returns {string} 可下载 ZIP 文件名。
   */
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
