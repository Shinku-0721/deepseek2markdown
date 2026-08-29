/**
 * DeepSeek 页面协调模块。
 *
 * 该内容脚本连接页面凭证捕获、导出 module 与浏览器下载，并维护当前对话、全部对话、
 * 分享链接三种任务的统一状态。全量导出的列表、缓存、调度和归档由 deep module 负责；
 * 任务状态属于页面生命周期，Popup 关闭后仍可继续执行。
 */
'use strict';

const DeepSeekClientModule = globalThis.DeepSeekClient;
const HistoryCacheModule = globalThis.DeepSeekHistoryCache;
const AllExportModule = globalThis.DeepSeekAllExport;
const ExportCore = globalThis.DeepSeekExportCore;
const ExportDelivery = globalThis.DeepSeekExportDelivery;
const DownloadClient = globalThis.DeepSeekDownloadClient;
if (
  !DeepSeekClientModule
  || !HistoryCacheModule
  || !AllExportModule
  || !ExportCore
  || !ExportDelivery
  || !DownloadClient
) {
  throw new Error('DeepSeek 导出模块加载失败');
}

// Bearer Token 只保存在当前内容脚本内存中，由页面 MAIN 世界的捕获脚本动态更新。
let bearerToken = null;
// 页面同时只允许一个导出任务，避免重复请求、重复归档和状态相互覆盖。
let activeExport = false;
// Popup 可随时查询该不可变快照，以恢复任务进度或展示最近一次结果。
let exportState = Object.freeze({ status: 'idle' });
const deepSeekClient = DeepSeekClientModule.createDeepSeekClient({
  // Token 可能在页面运行期间更新，客户端必须在每次请求前读取当前值。
  getBearerToken: () => bearerToken,
});
const historyCache = HistoryCacheModule.createHistoryCache();
const allExport = AllExportModule.createAllExport({
  deepSeekClient,
  historyCache,
  createArchiveBuilder: ExportDelivery.createArchiveBuilder,
});

/**
 * 从当前 DeepSeek 对话路由中提取会话 ID。
 *
 * @returns {string|null} 当前 URL 是对话页时返回会话 ID，否则返回 null。
 */
function getCurrentSessionId() {
  const match = window.location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{16,})/i);
  return match ? match[1] : null;
}

/**
 * 将任意抛出值转换为适合展示和写入导出错误字段的文本。
 *
 * @param {*} error 捕获到的异常或其他抛出值。
 * @returns {string} 稳定的错误描述。
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 更新页面内的导出状态快照，并尽力把同一事件通知给 Popup。
 *
 * Popup 不在线不属于任务错误，因此消息发送失败会被忽略；exportState 始终先更新，
 * 确保 Popup 再次打开时能够读取完整状态。
 *
 * @param {object} payload 包含 type、stage、进度计数和展示文本的状态事件。
 */
function notifyProgress(payload) {
  const { type, ...details } = payload;
  const status = type === 'complete' ? 'complete' : type === 'error' ? 'error' : 'running';
  exportState = Object.freeze({
    ...exportState,
    ...details,
    status,
    error: status === 'error' ? details.message : null,
    updatedAt: Date.now(),
  });

  try {
    // Popup 可能在任务期间关闭；读取 lastError 可避免产生无意义的运行时告警。
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch (_) {
    // Popup 关闭不应中断仍在页面中执行的导出任务。
  }
}

/**
 * 原子地占用导出任务槽并初始化统一状态字段。
 *
 * @param {string} action 导出动作名称，例如 exportAll。
 * @param {'markdown'|'json'} format 目标导出格式。
 * @returns {boolean} 成功开始返回 true；已有任务运行时返回 false。
 */
function beginExport(action, format) {
  if (activeExport) return false;

  activeExport = true;
  const now = Date.now();
  exportState = Object.freeze({
    status: 'running',
    action,
    format,
    stage: 'prepare',
    current: 0,
    total: 0,
    message: '正在准备导出...',
    error: null,
    filename: null,
    sizeBytes: null,
    failedCount: 0,
    cacheHitCount: 0,
    networkCount: 0,
    startedAt: now,
    updatedAt: now,
  });
  notifyProgress({
    type: 'progress',
    stage: 'prepare',
    current: 0,
    total: 0,
    message: exportState.message,
  });
  return true;
}

/**
 * 把凭证捕获脚本注入页面 MAIN 世界。
 *
 * 内容脚本处于隔离世界，无法直接覆盖页面使用的 fetch/XHR；注入完成后立即移除 script
 * 元素，实际 Hook 仍由已执行的 injected.js 保留在页面环境中。
 */
(function injectTokenHook() {
  // 内容脚本处于隔离世界，必须注入 MAIN 世界才能观察页面请求头。
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('lib/injected.js');
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener('error', () => script.remove(), { once: true });
  (document.head || document.documentElement).appendChild(script);
})();

// 只接受当前窗口、当前源且类型明确的凭证消息，避免其他消息污染内存中的 Token。
window.addEventListener('message', (event) => {
  if (
    event.source !== window
    || event.origin !== window.location.origin
    || event.data?.type !== 'DS2MD_TOKEN'
  ) return;

  if (typeof event.data.token === 'string' && event.data.token.startsWith('Bearer ')) {
    bearerToken = event.data.token;
  }
});

/**
 * 触发浏览器下载，并把最终文件信息写回完成状态。
 *
 * @param {{filename: string, content: *, mimeType: string}} artifact 可下载文件产物。
 * @returns {Promise<void>} 浏览器已接受下载触发后完成。
 */
async function downloadArtifact(artifact) {
  notifyProgress({ type: 'progress', stage: 'download', message: '正在下载...' });
  const { sizeBytes } = await DownloadClient.download(artifact);
  const sizeKB = Math.round(sizeBytes / 1024);
  const failedCount = exportState.failedCount || 0;
  const failureNote = failedCount ? ` · ${failedCount} 个会话失败` : '';

  notifyProgress({
    type: 'complete',
    filename: artifact.filename,
    size: sizeKB,
    sizeBytes,
    failedCount,
    message: `导出完成 · ${artifact.filename} · ${sizeKB} KB${failureNote}`,
  });
}

/**
 * 把单个会话渲染为目标格式并立即下载。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} session 已合并列表元数据和历史消息的会话。
 * @param {object} options Markdown 展示选项；JSON 导出会忽略这些选项。
 * @returns {Promise<void>} 文件组织和下载触发完成后结束。
 */
async function downloadSingleSession(format, session, options) {
  let exportOptions = options;
  if (format === 'markdown') {
    notifyProgress({ type: 'progress', stage: 'files', message: '正在获取上传文件...' });
    exportOptions = await prepareSessionOptions(format, session, options);
  }

  notifyProgress({ type: 'progress', stage: 'format', message: '正在组织文件...' });
  const artifact = await ExportDelivery.createSingleArtifact(format, session, exportOptions);
  await downloadArtifact(artifact);
}

/**
 * 为 Markdown 会话获取上传文件；JSON 始终保持原始数据导出，不额外发起文件请求。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} session 当前会话。
 * @param {object} options 原始导出选项。
 * @returns {Promise<object>} 可传给渲染和交付模块的选项。
 */
async function prepareSessionOptions(format, session, options) {
  if (format !== 'markdown') return options || {};
  const attachments = await deepSeekClient.fetchUploadedFiles(session);
  return { ...(options || {}), attachments };
}

/**
 * 执行一种导出工作流，并统一处理互斥、错误状态和消息响应。
 *
 * @param {Function} sendResponse Chrome 消息通道的响应函数。
 * @param {string} action 当前导出动作名称。
 * @param {'markdown'|'json'} format 目标格式。
 * @param {Function} operation 实际导出步骤，失败时应抛出异常。
 * @returns {Promise<void>} 工作流及响应发送完成后结束。
 */
async function runExport(sendResponse, action, format, operation) {
  if (!beginExport(action, format)) {
    sendResponse({ ok: false, error: '已有导出任务正在进行' });
    return;
  }

  let response;
  try {
    await operation();
    response = { ok: true };
  } catch (error) {
    const message = errorMessage(error);
    notifyProgress({ type: 'error', message });
    response = { ok: false, error: message };
  } finally {
    activeExport = false;
  }

  try {
    sendResponse(response);
  } catch (_) {
    // Popup 已关闭时，任务结果仍保留在 exportState 中供下次查询。
  }
}

/**
 * 导出当前 URL 对应的单个私有会话。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} options Markdown 展示选项。
 * @param {Function} sendResponse Chrome 消息响应函数。
 */
function exportCurrent(format, options, sendResponse) {
  void runExport(sendResponse, 'exportCurrent', format, async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) throw new Error('当前页面不是对话页（URL 应为 /a/chat/s/...）');

    notifyProgress({ type: 'progress', stage: 'init', message: '获取当前会话...' });
    const history = await deepSeekClient.getHistoryData(sessionId);
    const session = {
      ...history,
      id: history.id || sessionId,
      title: history.title || document.title || '当前对话',
      messages: history.messages,
    };

    await downloadSingleSession(format, session, options);
  });
}

/**
 * 通过全量导出 module 生成产物，并由浏览器 adapter 触发下载。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} options Markdown 展示选项。
 * @param {Function} sendResponse Chrome 消息响应函数。
 */
function exportAll(format, options, sendResponse) {
  void runExport(sendResponse, 'exportAll', format, async () => {
    if (!bearerToken) throw new Error('未获取到登录凭证，请在 DeepSeek 页面点击任意对话');

    const { artifact } = await allExport.run(format, options, notifyProgress);
    await downloadArtifact(artifact);
  });
}

/**
 * 获取并导出公开分享链接对应的会话。
 *
 * @param {string} raw 完整分享 URL、相对路径或 share ID。
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} options Markdown 展示选项。
 * @param {Function} sendResponse Chrome 消息响应函数。
 */
function exportShare(raw, format, options, sendResponse) {
  void runExport(sendResponse, 'exportShare', format, async () => {
    const shareId = ExportCore.parseShareId(raw);
    if (!shareId) throw new Error('无法解析分享链接，请输入完整的分享 URL 或 share ID');

    notifyProgress({ type: 'progress', stage: 'init', message: '获取分享内容...' });
    const response = await deepSeekClient.fetchShareContent(shareId);
    const session = ExportCore.createShareSession(response, shareId);
    await downloadSingleSession(format, session, options);
  });
}

// 内容脚本的唯一消息入口：同步状态查询立即响应，导出动作保持消息通道到异步任务结束。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.action) {
    case 'getStatus':
      sendResponse({
        hasToken: Boolean(bearerToken),
        sessionId: getCurrentSessionId(),
        exportState: { ...exportState },
      });
      return false;
    case 'exportCurrent':
      exportCurrent(message.format, message.options, sendResponse);
      return true;
    case 'exportAll':
      exportAll(message.format, message.options, sendResponse);
      return true;
    case 'exportShare':
      exportShare(message.url, message.format, message.options, sendResponse);
      return true;
    default:
      return false;
  }
});
