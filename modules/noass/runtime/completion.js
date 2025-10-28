import { handleCompletion, setRefreshStoredDataView } from './mergeBlock.js';

let completionHandler = null;
let completionEventName = null;

/**
 * 注册 `CHAT_COMPLETION_SETTINGS_READY` 事件监听，拦截消息并交由合并流水线处理。
 *
 * @param {object} ctx 酒馆扩展上下文对象，需包含 `eventSource` 与 `eventTypes`
 * @param {object} state 当前 noass 模块配置状态
 * @param {{ refreshStoredDataView?: () => void }} [options] 附加钩子，例如 UI 刷新函数
 */
export function registerCompletion(ctx, state, options = {}) {
  const eventSource = ctx?.eventSource;
  if (!eventSource) return;

  const eventTypes = ctx?.eventTypes || ctx?.event_types || {};
  const eventName =
    eventTypes.CHAT_COMPLETION_SETTINGS_READY ||
    eventTypes.chat_completion_settings_ready ||
    'chat_completion_settings_ready';

  if (!eventName) return;

  if (typeof options.refreshStoredDataView === 'function') {
    setRefreshStoredDataView(options.refreshStoredDataView);
  }

  completionHandler = (completion) => {
    try {
      handleCompletion(ctx, state, completion);
    } catch (error) {
      console.warn('[ST-Diff][noass] 处理 completion 时发生异常', error);
    }
  };

  if (typeof eventSource.on === 'function') {
    eventSource.on(eventName, completionHandler);
  } else if (typeof eventSource.addListener === 'function') {
    eventSource.addListener(eventName, completionHandler);
  } else if (typeof eventSource.addEventListener === 'function') {
    eventSource.addEventListener(eventName, completionHandler);
  } else {
    completionHandler = null;
    return;
  }

  completionEventName = eventName;
}

/**
 * 释放之前注册的 completion 事件监听，防止重复处理与内存泄漏。
 *
 * @param {object} ctx SillyTavern 扩展上下文对象
 */
export function unregisterCompletion(ctx) {
  if (!completionHandler) return;

  const eventSource = ctx?.eventSource;
  if (!eventSource || !completionEventName) {
    completionHandler = null;
    completionEventName = null;
    return;
  }

  const off =
    (typeof eventSource.off === 'function' && ((event, handler) => eventSource.off(event, handler))) ||
    (typeof eventSource.removeListener === 'function' &&
      ((event, handler) => eventSource.removeListener(event, handler))) ||
    (typeof eventSource.removeEventListener === 'function' &&
      ((event, handler) => eventSource.removeEventListener(event, handler))) ||
    null;

  if (off) {
    off(completionEventName, completionHandler);
  }

  completionHandler = null;
  completionEventName = null;
}