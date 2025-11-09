import { MAX_MACRO_DEPTH } from '../constants.js';

const TAG = '[ST-Diff][macros]';

/**
 * 解析酒馆提供的宏求值函数。
 * @param {any} ctx
 * @returns {(input: string, env?: Record<string, unknown>, depth?: number) => unknown | Promise<unknown> | null}
 */
function resolveHostEvaluator(ctx) {
  if (ctx?.macros?.evaluate) {
    return ctx.macros.evaluate.bind(ctx.macros);
  }
  if (typeof ctx?.evaluateMacro === 'function') {
    return ctx.evaluateMacro.bind(ctx);
  }
  return null;
}

/**
 * 解析通知逻辑，优先使用 酒馆UI 的通知能力，无法获取时退化为控制台日志。
 * @param {any} ctx
 * @param {(message: string, level?: 'info' | 'warn' | 'error') => void} [custom]
 * @returns {(message: string, level?: 'info' | 'warn' | 'error') => void}
 */
function resolveNotifier(ctx, custom) {
  if (typeof custom === 'function') {
    return custom;
  }
  if (ctx?.ui?.notify) {
    return (message, level = 'warn') => {
      try {
        ctx.ui.notify(level, message, 'ST-Diff 宏');
      } catch (error) {
        console.warn(`${TAG} 通知调用失败`, error);
      }
    };
  }
  return (message) => console.warn(`${TAG} ${message}`);
}

/**
 * 将任意值转换为可展示的字符串。
 * @param {unknown} value
 * @returns {string}
 */
function toStringSafe(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (error) {
      console.warn(`${TAG} 结果序列化失败`, error);
      return '[object Object]';
    }
  }
  return String(value);
}

/**
 * 创建宏运行时使用的求值辅助器。
 *
 * @param {any} ctx
 * @param {{ maxDepth?: number, notify?: (message: string, level?: 'info' | 'warn' | 'error') => void }} [options]
 * @returns {{ expand: (raw: string, depth?: number, environment?: Record<string, unknown>) => Promise<string>, canEvaluate: boolean, readonly maxDepth: number }}
 */
export function createEvaluator(ctx, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : MAX_MACRO_DEPTH;
  const notify = resolveNotifier(ctx, options.notify);
  const hostEvaluator = resolveHostEvaluator(ctx);

  /**
   * 带深度控制地递归展开宏文本。
   *
   * @param {string} raw
   * @param {number} depth
   * @param {Record<string, unknown>} [environment]
   * @returns {Promise<string>}
   */
  async function expand(raw, depth = 0, environment) {
    if (typeof raw !== 'string' || !raw.length) {
      return typeof raw === 'string' ? raw : toStringSafe(raw);
    }

    if (!hostEvaluator) {
      return raw;
    }

    if (depth >= maxDepth) {
      notify(`宏递归深度超过 ${maxDepth}，已返回原文。`);
      return raw;
    }

    try {
      const result = hostEvaluator(raw, environment ?? {}, depth);
      const awaited = await Promise.resolve(result);
      return toStringSafe(awaited);
    } catch (error) {
      notify('宏求值失败，已返回原文。');
      console.warn(`${TAG} 宏求值异常`, error);
      return raw;
    }
  }

  return {
    expand,
    canEvaluate: Boolean(hostEvaluator),
    get maxDepth() {
      return maxDepth;
    },
  };
}