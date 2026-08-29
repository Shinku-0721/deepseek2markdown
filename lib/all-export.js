/**
 * 全量导出 module。
 *
 * run interface 集中会话列表、历史缓存、请求调度、顺序归档、Markdown 上传文件和失败
 * 继续语义，并返回可下载产物与执行摘要。浏览器 adapter 只需转发进度并下载产物；调度
 * 策略及 DeepSeek、缓存、归档、时钟和等待 adapter 均留在 module implementation 内部。
 */
(function publishAllExport(root, createModule) {
  const allExportModule = createModule();

  if (typeof module === 'object' && module.exports) {
    module.exports = allExportModule;
  } else {
    root.DeepSeekAllExport = allExportModule;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
/**
 * 创建全量导出 module interface。
 *
 * @returns {{createAllExport: Function}} 冻结后的全量导出工厂。
 */
function createAllExportModule() {
  'use strict';

  const HISTORY_REQUEST_CONCURRENCY = 2;
  const HISTORY_REQUEST_INTERVAL_MS = 800;
  const HISTORY_PREFETCH_WINDOW = 16;

  /**
   * 绑定全量导出的 internal adapters。
   *
   * @param {object} adapters DeepSeek、缓存、归档、时钟与等待 adapter。
   * @returns {{run: Function}} 只暴露业务输入、进度事件和执行结果的 interface。
   */
  function createAllExport(adapters = {}) {
    const {
      deepSeekClient,
      historyCache,
      createArchiveBuilder,
      now = Date.now,
      wait = sleep,
    } = adapters;

    /**
     * 导出账号下的全部会话。
     *
     * 历史请求可乱序完成，但归档写入严格遵循列表顺序。单会话历史失败会写入
     * export_error 并继续；列表或归档级错误则中止整个执行并原样抛给调用者。
     *
     * @param {'markdown'|'json'} format 目标格式。
     * @param {object} options Markdown 展示选项；JSON 导出会忽略这些选项。
     * @param {Function} [onProgress] 接收列表、获取和归档进度事实。
     * @returns {Promise<{artifact: object, summary: object}>} 下载产物与执行摘要。
     */
    async function run(format, options = {}, onProgress) {
      emit(onProgress, {
        type: 'progress',
        stage: 'list',
        message: '拉取会话列表...',
      });
      const sessions = await deepSeekClient.listAllSessions(({ page, total }) => {
        emit(onProgress, {
          type: 'progress',
          stage: 'list',
          message: `第 ${page} 页 · 已拉取 ${total} 个会话`,
        });
      });

      if (!sessions.length) throw new Error('没有找到任何会话');

      const archive = createArchiveBuilder(
        format,
        options,
        `deepseek-all-${archiveTimestamp(now())}.zip`,
      );
      const counts = {
        cacheHitCount: 0,
        networkCount: 0,
        failedCount: 0,
      };
      let nextHistoryRequestAt = now();

      try {
        emit(onProgress, fetchProgress(0, sessions.length, counts, '开始拉取消息...'));

        let completedCount = 0;
        let nextArchiveIndex = 0;
        const readySessions = new Map();
        let archiveQueue = Promise.resolve();

        /** 将当前连续就绪的会话加入串行归档队列。 */
        const enqueueReadySessions = () => {
          while (readySessions.has(nextArchiveIndex)) {
            const session = readySessions.get(nextArchiveIndex);
            readySessions.delete(nextArchiveIndex);
            nextArchiveIndex++;
            archiveQueue = archiveQueue.then(async () => {
              if (format === 'markdown') {
                const attachments = await deepSeekClient.fetchUploadedFiles(session);
                archive.addSession(session, { attachments });
              } else {
                archive.addSession(session);
              }
            });
            // worker 不等待前序附件和压缩；批次结束时统一观察并传播归档错误。
            void archiveQueue.catch(() => {});
          }
        };

        for (let batchStart = 0; batchStart < sessions.length; batchStart += HISTORY_PREFETCH_WINDOW) {
          const batchEnd = Math.min(batchStart + HISTORY_PREFETCH_WINDOW, sessions.length);
          const cachedHistories = await historyCache.getMany(sessions.slice(batchStart, batchEnd));
          let nextSessionIndex = batchStart;
          const workers = Array.from(
            { length: Math.min(HISTORY_REQUEST_CONCURRENCY, batchEnd - batchStart) },
            async () => {
              while (nextSessionIndex < batchEnd) {
                const sessionIndex = nextSessionIndex++;
                const session = sessions[sessionIndex];
                let exportedSession;
                let cacheHit = false;

                try {
                  let history = cachedHistories.get(String(session.id));
                  if (history) {
                    cacheHit = true;
                    counts.cacheHitCount++;
                  } else {
                    const scheduledAt = Math.max(now(), nextHistoryRequestAt);
                    nextHistoryRequestAt = scheduledAt + HISTORY_REQUEST_INTERVAL_MS;
                    const waitMilliseconds = scheduledAt - now();
                    if (waitMilliseconds > 0) await wait(waitMilliseconds);

                    counts.networkCount++;
                    history = await deepSeekClient.getHistoryData(session.id);
                    await historyCache.put(session, history);
                  }
                  exportedSession = { ...session, ...history, messages: history.messages };
                } catch (error) {
                  counts.failedCount++;
                  exportedSession = {
                    ...session,
                    export_error: errorMessage(error),
                    messages: [],
                  };
                }

                completedCount++;
                readySessions.set(sessionIndex, exportedSession);
                enqueueReadySessions();

                if (!cacheHit || completedCount === sessions.length || completedCount % 25 === 0) {
                  emit(onProgress, fetchProgress(
                    completedCount,
                    sessions.length,
                    counts,
                    `${completedCount}/${sessions.length} · 缓存 ${counts.cacheHitCount} · 请求 ${counts.networkCount}`,
                  ));
                }
              }
            },
          );
          await Promise.all(workers);
          await archiveQueue;
        }

        emit(onProgress, {
          type: 'progress',
          stage: 'archive',
          current: sessions.length,
          total: sessions.length,
          ...counts,
          message: '正在完成压缩包...',
        });
        const artifact = await archive.finish();
        return {
          artifact,
          summary: { ...counts },
        };
      } catch (error) {
        archive.abort();
        throw error;
      }
    }

    return Object.freeze({ run });
  }

  /** 创建包含稳定计数结构的获取阶段进度事件。 */
  function fetchProgress(current, total, counts, message) {
    return {
      type: 'progress',
      stage: 'fetch',
      current,
      total,
      ...counts,
      message,
    };
  }

  /** 进度观察者缺失时保持 run interface 可直接调用。 */
  function emit(onProgress, event) {
    onProgress?.(event);
  }

  /** 将时钟值转换为归档文件名使用的本地时间戳。 */
  function archiveTimestamp(timestamp) {
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
      + '-' + pad(date.getHours()) + pad(date.getMinutes());
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  return Object.freeze({ createAllExport });
});
