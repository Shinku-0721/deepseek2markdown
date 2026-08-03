/**
 * 扩展 Popup 交互模块。
 *
 * 负责加载和持久化 Markdown 展示选项，检测当前标签页是否支持各类导出，向内容脚本
 * 发送任务消息，并把实时事件或恢复的 exportState 渲染为按钮、状态灯和进度条。
 */
'use strict';

const DeepSeekClientModule = globalThis.DeepSeekClient;
const ExportCore = globalThis.DeepSeekExportCore;
const ExportDelivery = globalThis.DeepSeekExportDelivery;
const DownloadClient = globalThis.DeepSeekDownloadClient;
if (!DeepSeekClientModule || !ExportCore || !ExportDelivery || !DownloadClient) {
  throw new Error('DeepSeek 导出模块加载失败');
}

const publicDeepSeekClient = DeepSeekClientModule.createDeepSeekClient();
const OPTIONS_STORAGE_KEY = 'markdownExportOptions';
/** 按固定 DOM id 获取 Popup 元素，集中减少重复的 document 调用。 */
const byId = id => document.getElementById(id);
const statusDot = byId('statusDot');
const statusMsg = byId('statusMsg');
const currentSessionHint = byId('curSessionHint');
const progressArea = byId('progressArea');
const progressBar = byId('progressBar');
const progressText = byId('progressText');
const shareInput = byId('shareInput');
const includeThinking = byId('includeThinking');
const includeSearch = byId('includeSearch');
const branchLatest = byId('branchLatest');
const branchAll = byId('branchAll');

// 三组按钮分别受当前会话、登录凭证和分享接口可用性控制。
const currentButtons = [byId('btnCurMd'), byId('btnCurJson')];
const allButtons = [byId('btnAllMd'), byId('btnAllJson')];
const shareButtons = [byId('btnShareMd'), byId('btnShareJson')];
// 可用性描述环境条件，exportBusy 则在任一任务运行期间统一禁止重复操作。
let currentAvailable = false;
let allAvailable = false;
let shareAvailable = true;
let exportBusy = false;

/**
 * 从当前表单控件读取 Markdown 展示选项。
 *
 * @returns {{includeThinking: boolean, includeSearch: boolean, branchMode: string}} 规范化选项。
 */
function markdownOptions() {
  // 这些选项只描述 Markdown 展示；JSON 在核心 Module 中始终保留完整消息树。
  return {
    includeThinking: includeThinking.checked,
    includeSearch: includeSearch.checked,
    branchMode: branchLatest.checked ? 'latest' : 'all',
  };
}

/**
 * 把存储中的选项应用到表单，并为缺失或非法字段使用安全默认值。
 *
 * @param {object|undefined} options 已保存的 Markdown 选项。
 */
function applyMarkdownOptions(options) {
  includeThinking.checked = options?.includeThinking !== false;
  includeSearch.checked = options?.includeSearch !== false;
  const branchMode = options?.branchMode === 'all' ? 'all' : 'latest';
  branchLatest.checked = branchMode === 'latest';
  branchAll.checked = branchMode === 'all';
}

/**
 * 从扩展本地存储加载 Markdown 选项；读取失败时恢复模块默认值。
 *
 * @returns {Promise<void>} 表单状态应用完成后结束。
 */
async function loadMarkdownOptions() {
  try {
    const stored = await chrome.storage.local.get(OPTIONS_STORAGE_KEY);
    applyMarkdownOptions(stored[OPTIONS_STORAGE_KEY]);
  } catch (_) {
    applyMarkdownOptions(ExportCore.DEFAULT_MARKDOWN_OPTIONS);
  }
}

/**
 * 保存当前 Markdown 选项，并把存储错误显示在状态区域。
 *
 * @returns {Promise<void>} 写入尝试完成后结束。
 */
async function persistMarkdownOptions() {
  try {
    await chrome.storage.local.set({ [OPTIONS_STORAGE_KEY]: markdownOptions() });
  } catch (error) {
    setStatus('error', '保存导出设置失败: ' + error.message);
  }
}

/**
 * 批量设置同一功能组按钮的启用状态。
 *
 * @param {HTMLButtonElement[]} buttons 需要更新的按钮集合。
 * @param {boolean} enabled true 表示允许点击。
 */
function setButtonsEnabled(buttons, enabled) {
  for (const button of buttons) button.disabled = !enabled;
}

/** 根据环境可用性和任务忙碌状态重新计算三组按钮状态。 */
function refreshButtons() {
  setButtonsEnabled(currentButtons, currentAvailable && !exportBusy);
  setButtonsEnabled(allButtons, allAvailable && !exportBusy);
  setButtonsEnabled(shareButtons, shareAvailable && !exportBusy);
}

/**
 * 更新全局任务忙碌标记并立即刷新按钮。
 *
 * @param {boolean} busy 是否有导出任务正在等待响应。
 */
function setExportBusy(busy) {
  exportBusy = busy;
  refreshButtons();
}

/**
 * 查询当前窗口中处于激活状态的标签页。
 *
 * @returns {Promise<chrome.tabs.Tab|undefined>} 当前激活标签页。
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 判断标签页是否属于允许访问的 DeepSeek 站点。
 *
 * @param {chrome.tabs.Tab|undefined} tab 待检查标签页。
 * @returns {boolean} URL 以 DeepSeek HTTPS origin 开头时返回 true。
 */
function isDeepSeekTab(tab) {
  return Boolean(tab?.url?.startsWith('https://chat.deepseek.com'));
}

/**
 * 向 DeepSeek 标签页的内容脚本发送消息，并把业务失败转换为异常。
 *
 * @param {object} message 导出动作或状态查询消息。
 * @param {chrome.tabs.Tab|null} tab 可选目标；省略时使用当前激活标签页。
 * @returns {Promise<object>} 内容脚本响应。
 */
async function sendToContent(message, tab = null) {
  const targetTab = tab || await getActiveTab();
  if (!isDeepSeekTab(targetTab)) throw new Error('请在 DeepSeek 页面使用此扩展');

  const response = await chrome.tabs.sendMessage(targetTab.id, message);
  if (response?.ok === false) throw new Error(response.error || '导出失败');
  return response;
}

/**
 * 显示进度区域并更新进度条宽度与说明文字。
 *
 * @param {number|null|undefined} percent 0 到 100 的展示百分比。
 * @param {string|null|undefined} text 可选进度说明。
 */
function setProgress(percent, text) {
  progressArea.classList.remove('hidden');
  progressBar.style.width = (percent ?? 0) + '%';
  if (text != null) progressText.textContent = text;
}

/** 隐藏进度区域并清空上一次任务的视觉状态。 */
function hideProgress() {
  progressArea.classList.add('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = '';
}

/**
 * 更新登录或环境状态灯及其说明文字。
 *
 * @param {string} kind 状态样式名称，例如 ok、error 或 unknown。
 * @param {string} message 面向用户的状态说明。
 */
function setStatus(kind, message) {
  statusDot.className = 'status-dot ' + kind;
  statusMsg.textContent = message;
}

/**
 * 把离散导出阶段和会话计数映射为连续进度条百分比。
 *
 * @param {object} message 内容脚本发送的进度事件。
 * @returns {number} 0 到 100 的展示百分比。
 */
function progressPercentage(message) {
  switch (message.stage) {
    case 'prepare': return 0;
    case 'init': return 2;
    case 'list': return 8;
    case 'fetch':
      return message.total ? Math.round(10 + (message.current / message.total) * 82) : 10;
    case 'format': return 94;
    case 'archive': return 96;
    case 'download': return 98;
    default: return 50;
  }
}

/**
 * 把 progress、complete 或 error 事件渲染到 Popup 控件。
 *
 * @param {object} message 导出状态事件。
 */
function renderExportMessage(message) {
  switch (message.type) {
    case 'progress':
      setExportBusy(true);
      setProgress(progressPercentage(message), message.message);
      break;
    case 'complete':
      setExportBusy(false);
      setProgress(100, message.message);
      statusDot.className = 'status-dot ok';
      break;
    case 'error':
      setExportBusy(false);
      setProgress(0, '错误：' + message.message);
      statusDot.className = 'status-dot error';
      break;
  }
}

/**
 * 把内容脚本保存的状态快照转换为普通实时事件并复用统一渲染逻辑。
 *
 * @param {object|undefined} state getStatus 返回的 exportState。
 */
function restoreExportState(state) {
  if (!state || state.status === 'idle') return;
  const type = state.status === 'running' ? 'progress' : state.status;
  renderExportMessage({ ...state, type });
}

chrome.runtime.onMessage.addListener(renderExportMessage);

// 其他 Popup 实例修改选项时，同步刷新当前实例的控件而不覆盖任务状态。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[OPTIONS_STORAGE_KEY]?.newValue) {
    applyMarkdownOptions(changes[OPTIONS_STORAGE_KEY].newValue);
  }
});

/**
 * 初始化 Popup：加载选项、检测当前标签页、读取登录与会话状态并恢复导出进度。
 *
 * 分享链接导出始终可用；当前会话和全量导出只有在内容脚本提供相应条件后才启用。
 *
 * @returns {Promise<void>} 初始界面完成渲染后结束。
 */
async function init() {
  await loadMarkdownOptions();

  let tab = null;
  try {
    tab = await getActiveTab();
  } catch (_) {
    // 查询标签页失败时仍允许使用公开的分享链接导出。
  }

  currentAvailable = false;
  allAvailable = false;
  shareAvailable = true;
  refreshButtons();

  if (!isDeepSeekTab(tab)) {
    setStatus('unknown', '打开 chat.deepseek.com 后可导出自己的对话；分享链接导出不受此限制');
    return;
  }

  setStatus('unknown', '检测中...');
  try {
    const response = await sendToContent({ action: 'getStatus' }, tab);
    if (response.hasToken) {
      setStatus('ok', '已登录');
      allAvailable = true;
      refreshButtons();
    } else {
      setStatus('unknown', '等待登录凭证（请在页面点击对话）');
    }

    if (response.sessionId) {
      currentSessionHint.textContent = '会话: ' + response.sessionId.slice(0, 12) + '...';
      currentAvailable = true;
      refreshButtons();
    } else {
      currentSessionHint.textContent = 'URL 不是对话页（/a/chat/s/...）';
    }

    restoreExportState(response.exportState);
  } catch (error) {
    setStatus('error', error.message);
  }
}

/**
 * 处理当前会话或全部会话导出按钮，并统一维护忙碌和错误状态。
 *
 * @param {'exportCurrent'|'exportAll'} action 内容脚本动作。
 * @param {'markdown'|'json'} format 目标格式。
 * @returns {Promise<void>} 内容脚本响应后结束；实际全量任务可在 Popup 关闭后继续。
 */
async function handleExport(action, format) {
  hideProgress();
  setProgress(0, '开始...');
  setExportBusy(true);

  try {
    await sendToContent({ action, format, options: markdownOptions() });
  } catch (error) {
    setProgress(0, '错误：' + error.message);
  } finally {
    setExportBusy(false);
  }
}

/**
 * 校验分享输入，并根据当前标签页环境选择内容脚本或 Popup 直连导出。
 *
 * @param {'markdown'|'json'} format 目标格式。
 * @returns {Promise<void>} 分享文件下载触发或错误展示完成后结束。
 */
async function handleShareExport(format) {
  const raw = shareInput.value.trim();
  if (!raw) {
    setProgress(0, '错误：请输入分享链接或 share ID');
    return;
  }

  hideProgress();
  setProgress(0, '获取分享内容...');
  setExportBusy(true);

  try {
    const tab = await getActiveTab();
    if (isDeepSeekTab(tab)) {
      await sendToContent({
        action: 'exportShare',
        url: raw,
        format,
        options: markdownOptions(),
      }, tab);
    } else {
      await exportShareDirect(raw, format);
    }
  } catch (error) {
    setProgress(0, '错误：' + error.message);
  } finally {
    setExportBusy(false);
  }
}

/**
 * 在非 DeepSeek 标签页中直接调用公开分享接口并完成本地下载。
 *
 * @param {string} raw 完整分享 URL、相对路径或 share ID。
 * @param {'markdown'|'json'} format 目标格式。
 * @returns {Promise<void>} 下载触发完成后结束。
 */
async function exportShareDirect(raw, format) {
  const shareId = ExportCore.parseShareId(raw);
  if (!shareId) throw new Error('无法解析分享链接');

  // 分享接口公开，非 DeepSeek 标签页也可从 Popup 的扩展 origin 请求。
  setProgress(5, '请求 API...');
  const payload = await publicDeepSeekClient.fetchShareContent(shareId);

  setProgress(90, '组织文件...');
  const session = ExportCore.createShareSession(payload, shareId);
  const artifact = await ExportDelivery.createSingleArtifact(format, session, markdownOptions());
  const { sizeBytes } = await DownloadClient.download(artifact);
  setProgress(100, `导出完成 · ${artifact.filename} · ${Math.round(sizeBytes / 1024)} KB`);
}

// 选项变更立即持久化；六个导出按钮只负责把固定动作和格式交给统一处理函数。
includeThinking.addEventListener('change', () => void persistMarkdownOptions());
includeSearch.addEventListener('change', () => void persistMarkdownOptions());
branchLatest.addEventListener('change', () => void persistMarkdownOptions());
branchAll.addEventListener('change', () => void persistMarkdownOptions());
byId('btnCurMd').addEventListener('click', () => handleExport('exportCurrent', 'markdown'));
byId('btnCurJson').addEventListener('click', () => handleExport('exportCurrent', 'json'));
byId('btnAllMd').addEventListener('click', () => handleExport('exportAll', 'markdown'));
byId('btnAllJson').addEventListener('click', () => handleExport('exportAll', 'json'));
byId('btnShareMd').addEventListener('click', () => handleShareExport('markdown'));
byId('btnShareJson').addEventListener('click', () => handleShareExport('json'));

void init();
