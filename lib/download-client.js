(function publish(root, factory) {
  const client = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ createDownloadClient: factory }, client);
  } else {
    root.DeepSeekDownloadClient = client;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDownloadClient(environment) {
  'use strict';

  function toBlob(file) {
    if (file.content instanceof environment.Blob) return file.content;
    const parts = Array.isArray(file.content) ? file.content : [file.content];
    return new environment.Blob(parts, { type: file.mimeType });
  }

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
