/**
 * @file 提供世界书缓存的构建、刷新与事件钩子，便于 runtime 与 UI 获取一致的启用条目信息。
 */
import { WORLD_INFO_POSITION } from '../../state/defaults.js';
import {
  worldbookState,
  debugWorldbookLog,
  warnWorldbookIssue,
  summarizeTextForDiagnostics,
} from './state.js';

let regexHelpersPromise = null;

/**
 * 延迟加载 clewd 原生的正则引擎工具，供世界书内容在prompt中展开使用。
 *
 * @param {object} ctx SillyTavern 扩展上下文
 * @returns {Promise<{ getRegexedString: Function, regex_placement: object }|null>} 可用的正则辅助工具
 */
export async function ensureRegexHelpers(ctx) {
  if (worldbookState.regexHelpers) {
    return worldbookState.regexHelpers;
  }
  if (!regexHelpersPromise) {
    regexHelpersPromise = (async () => {
      try {
        const module = await import('../../../../regex/engine.js');
        if (module?.getRegexedString && module?.regex_placement) {
          return {
            getRegexedString: module.getRegexedString,
            regex_placement: module.regex_placement,
          };
        }
      } catch (error) {
        console.warn('[ST-Diff][noass] regex 引擎加载失败', error);
      }
      return null;
    })();
  }
  const helpers = await regexHelpersPromise;
  regexHelpersPromise = null;
  if (helpers) {
    worldbookState.regexHelpers = helpers;
  }
  return worldbookState.regexHelpers;
}

/**
 * 对世界书原文执行正则展开，得到用于 Prompt 的最终文本。
 *
 * @param {string} rawContent 条目原始内容
 * @param {number|null} depth 当前条目深度
 * @returns {string} 展开后的 Prompt 文本
 */
export function computeWorldbookPromptContent(rawContent, depth) {
  const helpers = worldbookState.regexHelpers;
  if (!helpers?.getRegexedString || typeof rawContent !== 'string') {
    return rawContent ?? '';
  }
  try {
    return helpers.getRegexedString(rawContent, helpers.regex_placement.WORLD_INFO, {
      depth,
      isPrompt: true,
    });
  } catch (error) {
    console.warn('[ST-Diff][noass] regex 展开失败', { depth, error });
    return rawContent;
  }
}

/**
 * 根据最新的启用条目刷新内部缓存，供后续匹配与 UI 使用。
 *
 * @param {Array<object>} entries 世界书启用条目数组
 * @param {{ source?: string }} [options] 调试用的来源标记
 */
export function updateWorldbookCache(entries, { source = 'unknown' } = {}) {
  const list = Array.isArray(entries) ? entries.filter((item) => item && typeof item === 'object') : [];
  const normalized = [];
  const byId = new Map();
  const byDepth = new Map();

  list.forEach((entry, index) => {
    const depth = Number.isFinite(entry.depth) ? Number(entry.depth) : null;
    const order = Number.isFinite(entry.order) ? Number(entry.order) : 0;
    const position = typeof entry.position === 'number' ? entry.position : null;
    const uid = typeof entry.uid !== 'undefined' ? entry.uid : `auto-${index}`;
    const comment =
      typeof entry.comment === 'string' && entry.comment.trim()
        ? entry.comment.trim()
        : Array.isArray(entry.key) && entry.key.length
          ? String(entry.key[0])
          : '';

    const rawContent = typeof entry.content === 'string' ? entry.content : '';
    const promptContent = computeWorldbookPromptContent(rawContent, depth);
    const normalizedEntry = {
      uid,
      id: `${entry.world ?? 'world'}:${uid}`,
      world: entry.world ?? '',
      comment,
      depth,
      order,
      position,
      role: entry.role,
      content: rawContent,
      rawContent,
      promptContent,
      disabled: entry.disable === true,
      source: entry,
    };

    if (rawContent && !promptContent?.trim()) {
      warnWorldbookIssue('worldbook prompt content empty after expansion', {
        uid,
        depth,
        source,
      });
    }

    normalized.push(normalizedEntry);
    byId.set(normalizedEntry.uid, normalizedEntry);

    if (
      normalizedEntry.disabled !== true &&
      position === WORLD_INFO_POSITION.AT_DEPTH &&
      Number.isInteger(depth)
    ) {
      const bucket = byDepth.get(depth) || [];
      bucket.push(normalizedEntry);
      byDepth.set(depth, bucket);
    }
  });

  for (const bucket of byDepth.values()) {
    bucket.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.uid).localeCompare(String(b.uid));
    });
  }

  worldbookState.entries = normalized;
  worldbookState.entriesById = byId;
  worldbookState.entriesByDepth = byDepth;
  worldbookState.lastUpdated = Date.now();

  debugWorldbookLog('cache updated', { source, count: normalized.length, depthBuckets: byDepth.size });
  notifyWorldbookSnapshotSubscribers();
}

/**
 * 清空当前缓存，并可选择通知订阅者或清理订阅。
 *
 * @param {{ notify?: boolean, resetSubscribers?: boolean }} [options] 清理选项
 */
export function resetWorldbookCache({ notify = false, resetSubscribers = false } = {}) {
  worldbookState.entries = [];
  worldbookState.entriesById = new Map();
  worldbookState.entriesByDepth = new Map();
  worldbookState.lastUpdated = 0;
  worldbookState.initialized = false;

  if (resetSubscribers) {
    worldbookState.uiSubscribers.clear();
  }

  if (notify) {
    notifyWorldbookSnapshotSubscribers();
  }
}

/**
 * 注册世界书激活事件，保持缓存与 SillyTavern 宿主同步。
 *
 * @param {object} ctx SillyTavern 扩展上下文
 * @returns {Promise<void>}
 */
export async function initializeWorldbookIntegration(ctx) {
  if (!ctx?.eventSource) {
    return;
  }

  await ensureRegexHelpers(ctx);

  const eventSource = ctx.eventSource;
  const eventTypes = ctx.eventTypes || ctx.event_types || {};
  const activatedEvent = eventTypes.WORLD_INFO_ACTIVATED || 'world_info_activated';

  if (!worldbookState.listeners.some((listener) => listener.event === activatedEvent)) {
    const activatedHandler = async (entries) => {
      await ensureRegexHelpers(ctx);
      updateWorldbookCache(entries, { source: 'WORLD_INFO_ACTIVATED' });
    };

    if (typeof eventSource.on === 'function') {
      eventSource.on(activatedEvent, activatedHandler);
    } else if (typeof eventSource.addListener === 'function') {
      eventSource.addListener(activatedEvent, activatedHandler);
    } else if (typeof eventSource.addEventListener === 'function') {
      eventSource.addEventListener(activatedEvent, activatedHandler);
    }

    worldbookState.listeners.push({ event: activatedEvent, handler: activatedHandler });
    debugWorldbookLog('listener attached', activatedEvent);
  }

  if (Array.isArray(ctx?.worldInfo?.lastActivatedEntries)) {
    updateWorldbookCache(ctx.worldInfo.lastActivatedEntries, { source: 'context.lastActivatedEntries' });
  }

  worldbookState.initialized = true;
}

/**
 * 解除世界书事件监听并还原缓存状态。
 *
 * @param {object} ctx SillyTavern 扩展上下文
 */
export function teardownWorldbookIntegration(ctx) {
  if (!ctx?.eventSource || !worldbookState.listeners.length) {
    worldbookState.listeners = [];
    worldbookState.initialized = false;
    return;
  }

  const eventSource = ctx.eventSource;
  const off =
    (typeof eventSource.off === 'function' && ((event, handler) => eventSource.off(event, handler))) ||
    (typeof eventSource.removeListener === 'function' &&
      ((event, handler) => eventSource.removeListener(event, handler))) ||
    (typeof eventSource.removeEventListener === 'function' &&
      ((event, handler) => eventSource.removeEventListener(event, handler))) ||
    null;

  for (const { event, handler } of worldbookState.listeners) {
    if (off) {
      off(event, handler);
    }
  }

  worldbookState.listeners = [];
  worldbookState.initialized = false;
  resetWorldbookCache({ notify: true, resetSubscribers: true });
  debugWorldbookLog('listeners detached');
}

/**
 * 导出只读快照，包含所有条目与按深度分组的数据。
 *
 * @returns {{ entries: Array<object>, entriesByDepth: Record<number, Array<object>>, lastUpdated: number, initialized: boolean }}
 */
export function exportWorldbookSnapshot() {
  const entries = worldbookState.entries.map((entry) => ({ ...entry }));
  const entriesByDepth = {};

  worldbookState.entriesByDepth.forEach((list, depth) => {
    entriesByDepth[depth] = list.map((entry) => ({ ...entry }));
  });

  return {
    entries,
    entriesByDepth,
    lastUpdated: worldbookState.lastUpdated,
    initialized: worldbookState.initialized,
  };
}

/**
 * 订阅世界书快照的变更通知。
 *
 * @param {(snapshot: ReturnType<typeof exportWorldbookSnapshot>) => void} callback 回调函数
 */
export function subscribeWorldbookSnapshot(callback) {
  if (typeof callback === 'function') {
    worldbookState.uiSubscribers.add(callback);
  }
}

/**
 * 取消订阅世界书快照通知。
 *
 * @param {(snapshot: ReturnType<typeof exportWorldbookSnapshot>) => void} callback 之前注册的回调
 */
export function unsubscribeWorldbookSnapshot(callback) {
  if (typeof callback === 'function') {
    worldbookState.uiSubscribers.delete(callback);
  }
}

/**
 * 主动通知所有订阅者，常在缓存刷新后调用。
 */
export function notifyWorldbookSnapshotSubscribers() {
  if (!worldbookState.uiSubscribers.size) return;
  const snapshot = exportWorldbookSnapshot();
  for (const callback of Array.from(worldbookState.uiSubscribers)) {
    try {
      callback(snapshot);
    } catch (error) {
      console.warn('[ST-Diff][noass] 世界书快照通知失败', error);
    }
  }
}

export { summarizeTextForDiagnostics };