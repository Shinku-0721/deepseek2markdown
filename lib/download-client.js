/**
 * 浏览器下载客户端模块。
 *
 * 将字符串或二进制导出内容规范化为 Blob，在当前页面创建临时对象 URL，并通过隐藏的
 * `<a download>` 元素触发本地下载。模块刻意不使用 chrome.downloads API，因此不需要
 * downloads 权限，也不会出现缺少 DownloadOptions.url 的调用路径。
 */
/** 在 CommonJS 测试环境或浏览器全局对象上发布下载接口。 */
(function publish(root, factory) {
  const client = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ createDownloadClient: factory }, client);
  } else {
    root.DeepSeekDownloadClient = client;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 绑定浏览器环境依赖并创建下载客户端。
 *
 * @param {object} environment 提供 Blob、URL、document 和 setTimeout 的运行环境。
 * @returns {{download: Function}} 冻结后的下载接口。
 */
function createDownloadClient(environment) {
  'use strict';

  /**
   * 把文件描述中的内容转换为 Blob，同时避免复制已经构造好的 Blob。
   *
   * @param {{content: *, mimeType: string}} file 文件描述。
   * @returns {Blob} 带正确 MIME 类型的二进制对象。
   */
  function toBlob(file) {
    if (file.content instanceof environment.Blob) return file.content;
    const parts = Array.isArray(file.content) ? file.content : [file.content];
    return new environment.Blob(parts, { type: file.mimeType });
  }

  /**
   * 在创建对象 URL 的同一页面上下文中触发浏览器下载。
   *
   * 点击失败时立即清理临时资源并原样抛错；点击成功后延迟释放 URL，确保大文件已经被
   * 浏览器下载管线接管。
   *
   * @param {{filename: string, content: *, mimeType: string}} file 下载文件描述。
   * @returns {Promise<{sizeBytes: number}>} 已触发下载的 Blob 字节数。
   */
  async function download(file) {
    const blob = toBlob(file);
    const blobUrl = environment.URL.createObjectURL(blob);
    const anchor = environment.document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = file.filename;
    anchor.style.display = 'none';
    environment.document.body.appendChild(anchor);

    try {
      anchor.click();
    } catch (error) {
      anchor.remove();
      environment.URL.revokeObjectURL(blobUrl);
      throw error;
    }

    // 大文件下载启动后保留一段时间，避免浏览器尚未接管数据时 URL 被提前释放。
    environment.setTimeout(() => {
      anchor.remove();
      environment.URL.revokeObjectURL(blobUrl);
    }, 60_000);
    return { sizeBytes: blob.size };
  }

  return Object.freeze({ download });
});
