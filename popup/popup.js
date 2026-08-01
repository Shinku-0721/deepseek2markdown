/**
 * Popup 交互层：维护全局 Markdown 选项、按钮状态和导出进度。
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

const currentButtons = [byId('btnCurMd'), byId('btnCurJson')];
const allButtons = [byId('btnAllMd'), byId('btnAllJson')];
const shareButtons = [byId('btnShareMd'), byId('btnShareJson')];
let currentAvailable = false;
let allAvailable = false;
let shareAvailable = true;
let exportBusy = false;

function markdownOptions() {
  // 这些选项只描述 Markdown 展示；JSON 在核心 Module 中始终保留完整消息树。
  return {
    includeThinking: includeThinking.checked,
    includeSearch: includeSearch.checked,
    branchMode: branchLatest.checked ? 'latest' : 'all',
  };
}

function applyMarkdownOptions(options) {
  includeThinking.checked = options?.includeThinking !== false;
  includeSearch.checked = options?.includeSearch !== false;
  const branchMode = options?.branchMode === 'all' ? 'all' : 'latest';
  branchLatest.checked = branchMode === 'latest';
  branchAll.checked = branchMode === 'all';
}

async function loadMarkdownOptions() {
  try {
    const stored = await chrome.storage.local.get(OPTIONS_STORAGE_KEY);
    applyMarkdownOptions(stored[OPTIONS_STORAGE_KEY]);
  } catch (_) {
    applyMarkdownOptions(ExportCore.DEFAULT_MARKDOWN_OPTIONS);
  }
}

async function persistMarkdownOptions() {
  try {
    await chrome.storage.local.set({ [OPTIONS_STORAGE_KEY]: markdownOptions() });
  } catch (error) {
    setStatus('error', '保存导出设置失败: ' + error.message);
  }
}

function setButtonsEnabled(buttons, enabled) {
  for (const button of buttons) button.disabled = !enabled;
}

function refreshButtons() {
  setButtonsEnabled(currentButtons, currentAvailable && !exportBusy);
  setButtonsEnabled(allButtons, allAvailable && !exportBusy);
  setButtonsEnabled(shareButtons, shareAvailable && !exportBusy);
}

function setExportBusy(busy) {
  exportBusy = busy;
  refreshButtons();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isDeepSeekTab(tab) {
  return Boolean(tab?.url?.startsWith('https://chat.deepseek.com'));
}

async function sendToContent(message, tab = null) {
  const targetTab = tab || await getActiveTab();
  if (!isDeepSeekTab(targetTab)) throw new Error('请在 DeepSeek 页面使用此扩展');

  const response = await chrome.tabs.sendMessage(targetTab.id, message);
  if (response?.ok === false) throw new Error(response.error || '导出失败');
  return response;
}

function setProgress(percent, text) {
  progressArea.classList.remove('hidden');
  progressBar.style.width = (percent ?? 0) + '%';
  if (text != null) progressText.textContent = text;
}

function hideProgress() {
  progressArea.classList.add('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = '';
}

function setStatus(kind, message) {
  statusDot.className = 'status-dot ' + kind;
  statusMsg.textContent = message;
}

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

function restoreExportState(state) {
  if (!state || state.status === 'idle') return;
  const type = state.status === 'running' ? 'progress' : state.status;
  renderExportMessage({ ...state, type });
}

chrome.runtime.onMessage.addListener(renderExportMessage);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[OPTIONS_STORAGE_KEY]?.newValue) {
    applyMarkdownOptions(changes[OPTIONS_STORAGE_KEY].newValue);
  }
});

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
