/**
 * DeepSeek 页面协调层：维护页面 Token、导出进度和三种导出工作流。
 */
'use strict';

const DeepSeekClientModule = globalThis.DeepSeekClient;
const ExportCore = globalThis.DeepSeekExportCore;
const ExportDelivery = globalThis.DeepSeekExportDelivery;
const DownloadClient = globalThis.DeepSeekDownloadClient;
if (!DeepSeekClientModule || !ExportCore || !ExportDelivery || !DownloadClient) {
  throw new Error('DeepSeek 导出模块加载失败');
}

let bearerToken = null;
let activeExport = false;
let exportState = Object.freeze({ status: 'idle' });
const deepSeekClient = DeepSeekClientModule.createDeepSeekClient({
  // Token 可能在页面运行期间更新，客户端必须在每次请求前读取当前值。
  getBearerToken: () => bearerToken,
});
const HISTORY_REQUEST_CONCURRENCY = 4;
const HISTORY_REQUEST_INTERVAL_MS = 375;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function getCurrentSessionId() {
  const match = window.location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{16,})/i);
  return match ? match[1] : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

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

(function injectTokenHook() {
  // 内容脚本处于隔离世界，必须注入 MAIN 世界才能观察页面请求头。
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('lib/injected.js');
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener('error', () => script.remove(), { once: true });
  (document.head || document.documentElement).appendChild(script);
})();

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

function archiveTimestamp() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes());
}

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

async function downloadSingleSession(format, session, options) {
  notifyProgress({ type: 'progress', stage: 'format', message: '正在组织文件...' });
  const artifact = await ExportDelivery.createSingleArtifact(format, session, options);
  await downloadArtifact(artifact);
}

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
    let failedCount = 0;
    let nextHistoryRequestAt = Date.now();

    try {
      notifyProgress({
        type: 'progress',
        stage: 'fetch',
        total: sessions.length,
        current: 0,
        failedCount,
        message: '开始拉取消息...',
      });

      let completedCount = 0;
      let nextSessionIndex = 0;
      let nextArchiveIndex = 0;
      const readySessions = new Map();
      const workers = Array.from(
        { length: Math.min(HISTORY_REQUEST_CONCURRENCY, sessions.length) },
        async () => {
          while (nextSessionIndex < sessions.length) {
            const sessionIndex = nextSessionIndex++;
            const session = sessions[sessionIndex];
            const scheduledAt = Math.max(Date.now(), nextHistoryRequestAt);
            nextHistoryRequestAt = scheduledAt + HISTORY_REQUEST_INTERVAL_MS;
            const waitMilliseconds = scheduledAt - Date.now();
            if (waitMilliseconds > 0) await sleep(waitMilliseconds);

            let exportedSession;
            try {
              const history = await deepSeekClient.getHistoryData(session.id);
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

            notifyProgress({
              type: 'progress',
              stage: 'fetch',
              total: sessions.length,
              current: completedCount,
              failedCount,
              message: `${completedCount}/${sessions.length} · ${(session.title || '').slice(0, 30)}`,
            });
          }
        },
      );
      await Promise.all(workers);

      notifyProgress({
        type: 'progress',
        stage: 'archive',
        current: sessions.length,
        total: sessions.length,
        failedCount,
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
