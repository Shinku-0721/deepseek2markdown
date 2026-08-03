/**
 * DeepSeek 页面协调模块。
 *
 * 该内容脚本连接页面凭证捕获、DeepSeek API 客户端、增量缓存、文件渲染和浏览器下载，
 * 并维护当前对话、全部对话、分享链接三种导出任务的统一状态。导出任务属于页面生命周期，
 * Popup 关闭后仍可继续执行；页面刷新后则通过持久缓存接续已完成的会话。
 */
'use strict';

const DeepSeekClientModule = globalThis.DeepSeekClient;
const HistoryCacheModule = globalThis.DeepSeekHistoryCache;
const ExportCore = globalThis.DeepSeekExportCore;
const ExportDelivery = globalThis.DeepSeekExportDelivery;
const DownloadClient = globalThis.DeepSeekDownloadClient;
if (!DeepSeekClientModule || !HistoryCacheModule || !ExportCore || !ExportDelivery || !DownloadClient) {
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
// 历史接口采用低并发和全局启动间隔，降低对 DeepSeek 服务端的持续压力。
const HISTORY_REQUEST_CONCURRENCY = 2;
const HISTORY_REQUEST_INTERVAL_MS = 800;
// 每批最多允许 16 个会话乱序完成，防止慢请求前方积压大量未归档对象。
const HISTORY_PREFETCH_WINDOW = 16;
/** 等待指定毫秒数，用于历史请求的全局节奏控制。 */
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
 * 生成适合归档文件名的本地时间戳。
 *
 * @returns {string} 形如 YYYYMMDD-HHmm 的时间戳。
 */
function archiveTimestamp() {
  const date = new Date();
  /** 将日期数字补齐为两位文本。 */
  const pad = value => String(value).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes());
}

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
  notifyProgress({ type: 'progress', stage: 'format', message: '正在组织文件...' });
  const artifact = await ExportDelivery.createSingleArtifact(format, session, options);
  await downloadArtifact(artifact);
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
 * 导出账号下的全部会话，并在请求限速、增量缓存和流式 ZIP 之间协调数据流。
 *
 * 会话列表顺序决定归档顺序；历史请求可以并发和乱序完成，但 readySessions 只会从
 * nextArchiveIndex 开始连续写入。失败会话保留列表元数据和 export_error，使归档仍可交付，
 * 下次执行时则只需重新请求未成功缓存的会话。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @param {object} options Markdown 展示选项。
 * @param {Function} sendResponse Chrome 消息响应函数。
 */
function exportAll(format, options, sendResponse) {
  void runExport(sendResponse, 'exportAll', format, async () => {
    if (!bearerToken) throw new Error('未获取到登录凭证，请在 DeepSeek 页面点击任意对话');

    notifyProgress({ type: 'progress', stage: 'list', message: '拉取会话列表...' });
    const sessions = await deepSeekClient.listAllSessions(({ page, total }) => {
      notifyProgress({
        type: 'progress',
        stage: 'list',
        message: `第 ${page} 页 · 已拉取 ${total} 个会话`,
      });
    });

    if (!sessions.length) throw new Error('没有找到任何会话');

    const archive = ExportDelivery.createArchiveBuilder(
      format,
      options,
      `deepseek-all-${archiveTimestamp()}.zip`,
    );
    // 三个计数分别描述失败、缓存复用和实际历史接口请求，便于验收与进度恢复。
    let failedCount = 0;
    let cacheHitCount = 0;
    let networkCount = 0;
    // 所有 worker 共享下一次允许启动请求的时间，实现跨并发槽的全局节流。
    let nextHistoryRequestAt = Date.now();

    try {
      notifyProgress({
        type: 'progress',
        stage: 'fetch',
        total: sessions.length,
        current: 0,
        failedCount,
        cacheHitCount,
        networkCount,
        message: '开始拉取消息...',
      });

      let completedCount = 0;
      // 归档严格按列表索引前进；Map 暂存已经完成但前序会话尚未就绪的结果。
      let nextArchiveIndex = 0;
      const readySessions = new Map();
      for (let batchStart = 0; batchStart < sessions.length; batchStart += HISTORY_PREFETCH_WINDOW) {
        const batchEnd = Math.min(batchStart + HISTORY_PREFETCH_WINDOW, sessions.length);
        let nextSessionIndex = batchStart;
        // 每个 worker 从当前批次的共享索引领取任务；JavaScript 同步自增保证索引不重复。
        const workers = Array.from(
          { length: Math.min(HISTORY_REQUEST_CONCURRENCY, batchEnd - batchStart) },
          async () => {
            while (nextSessionIndex < batchEnd) {
              const sessionIndex = nextSessionIndex++;
              const session = sessions[sessionIndex];
              let exportedSession;
              let cacheHit = false;
              try {
                let history = await historyCache.get(session);
                if (history) {
                  cacheHit = true;
                  cacheHitCount++;
                } else {
                  const scheduledAt = Math.max(Date.now(), nextHistoryRequestAt);
                  nextHistoryRequestAt = scheduledAt + HISTORY_REQUEST_INTERVAL_MS;
                  const waitMilliseconds = scheduledAt - Date.now();
                  if (waitMilliseconds > 0) await sleep(waitMilliseconds);

                  networkCount++;
                  history = await deepSeekClient.getHistoryData(session.id);
                  await historyCache.put(session, history);
                }
                // 列表和历史接口提供互补字段，合并后完整保留到 JSON 导出。
                exportedSession = { ...session, ...history, messages: history.messages };
              } catch (error) {
                failedCount++;
                exportedSession = {
                  ...session,
                  export_error: errorMessage(error),
                  messages: [],
                };
              }

              completedCount++;
              readySessions.set(sessionIndex, exportedSession);
              while (readySessions.has(nextArchiveIndex)) {
                archive.addSession(readySessions.get(nextArchiveIndex));
                readySessions.delete(nextArchiveIndex);
                nextArchiveIndex++;
              }

              if (!cacheHit || completedCount === sessions.length || completedCount % 25 === 0) {
                notifyProgress({
                  type: 'progress',
                  stage: 'fetch',
                  total: sessions.length,
                  current: completedCount,
                  failedCount,
                  cacheHitCount,
                  networkCount,
                  message: `${completedCount}/${sessions.length} · 缓存 ${cacheHitCount} · 请求 ${networkCount}`,
                });
              }
            }
          },
        );
        await Promise.all(workers);
      }

      notifyProgress({
        type: 'progress',
        stage: 'archive',
        current: sessions.length,
        total: sessions.length,
        failedCount,
        cacheHitCount,
        networkCount,
        message: '正在完成压缩包...',
      });
      const artifact = await archive.finish();
      await downloadArtifact(artifact);
    } catch (error) {
      archive.abort();
      throw error;
    }
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
