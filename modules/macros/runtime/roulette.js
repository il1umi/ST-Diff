import { buildWeightAcc, parseWeightedTokens, pickWeighted as pickWeightedBase, splitInlineList } from './utils.js';

const TAG = '[ST-Diff][macros][roulette]';
const lastSelectionCache = new Map();

/**
 * 解析内联参数字符串为条目数组。
 * @param {string} raw
 * @returns {Array<{ value: string, weight: number, enabled: boolean }>}
 */
export function parseInlineArgs(raw) {
  if (typeof raw !== 'string') {
    return [];
  }

  const tokens = splitInlineList(raw);
  if (!tokens.length) {
    return [];
  }

  return parseWeightedTokens(tokens).map((item) => ({
    value: item.value,
    weight: Number.isFinite(item.weight) ? item.weight : 1,
    enabled: true,
  }));
}

/**
 * 根据宏组 ID 从状态树中获取配置。
 * @param {import('../state/manager.js').MacrosState} state
 * @param {string} identifier
 * @returns {import('../state/manager.js').RouletteGroup|null}
 */
export function resolveGroup(state, identifier) {
  if (!state?.roulette || typeof identifier !== 'string') {
    return null;
  }

  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  return state.roulette.groups?.[trimmed] || null;
}

/**
 * 内部辅助：判断条目启用状态。
 * @param {{ enabled?: boolean }} entry
 * @returns {boolean}
 */
function isEntryEnabled(entry) {
  return entry && entry.enabled !== false;
}

/**
 * 内部辅助：从上下文中获取通知函数。
 * @param {any} ctx
 * @returns {(message: string, level?: 'info'|'warn'|'error') => void}
 */
function createNotifier(ctx) {
  if (ctx?.ui?.notify) {
    return (message, level = 'warn') => {
      try {
        ctx.ui.notify(level, message, 'ST-Diff 宏');
      } catch (error) {
        console.warn(`${TAG} 通知失败`, error);
      }
    };
  }
  return (message) => console.warn(`${TAG} ${message}`);
}

/**
 * 执行加权抽取，支持禁重复。
 * @param {Array<{ id?: string, value: string, weight: number, enabled?: boolean }>} entries
 * @param {{ rng?: () => number, preventRepeat?: boolean, cacheKey?: string }} [options]
 * @returns {{ entry: { id?: string, value: string, weight: number } | null, index: number }}
 */
export function pickWeighted(entries, options = {}) {
  const { rng = Math.random, preventRepeat = false, cacheKey } = options;

  if (!Array.isArray(entries) || !entries.length) {
    return { entry: null, index: -1 };
  }

  const pool = entries.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  let stats = buildWeightAcc(pool);
  let effectivePool = pool;

  if (stats.total <= 0) {
    effectivePool = pool.map((item) => ({ ...item, weight: 1 }));
    stats = buildWeightAcc(effectivePool);
  }

  const lastToken = preventRepeat && cacheKey ? lastSelectionCache.get(cacheKey) : null;
  const maxAttempts = preventRepeat && cacheKey && effectivePool.length > 1 ? effectivePool.length : 1;

  let chosen = null;
  let chosenIndex = -1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { item, index } = pickWeightedBase(effectivePool, stats, rng);
    if (!item) {
      break;
    }

    const token = item.id ?? item.value;
    if (!preventRepeat || !cacheKey || !lastToken || token !== lastToken || effectivePool.length === 1) {
      chosen = item;
      chosenIndex = index;
      break;
    }
  }

  if (!chosen && effectivePool.length) {
    chosen = effectivePool[effectivePool.length - 1];
    chosenIndex = effectivePool.length - 1;
  }

  if (cacheKey && chosen) {
    lastSelectionCache.set(cacheKey, chosen.id ?? chosen.value);
  }

  return { entry: chosen, index: chosenIndex };
}

/**
 * 执行 roulette 宏的主流程。
 * @param {{
 *   ctx: any;
 *   state: import('../state/manager.js').MacrosState;
 *   evaluator: { expand: (raw: string, depth?: number, env?: Record<string, unknown>) => Promise<string>; canEvaluate: boolean; maxDepth: number; };
 *   inlineArgs?: string;
 *   groupId?: string;
 *   depth?: number;
 *   environment?: Record<string, unknown>;
 *   fallback?: string;
 *   rng?: () => number;
 * }} payload
 * @returns {Promise<string>}
 */
export async function execute(payload) {
  const {
    ctx,
    state,
    evaluator,
    inlineArgs,
    groupId,
    depth = 0,
    environment = {},
    fallback = '',
    rng = Math.random,
  } = payload;

  const notify = createNotifier(ctx);

  let entries = [];
  let preventRepeat = false;
  let cacheKey = null;

  if (typeof inlineArgs === 'string' && inlineArgs.trim()) {
    entries = parseInlineArgs(inlineArgs);
  } else if (typeof groupId === 'string' && groupId.trim()) {
    const group = resolveGroup(state, groupId);
    if (!group) {
      notify(`未找到名为 ${groupId} 的 roulette 宏组，已返回原文。`);
      return fallback;
    }
    entries = Array.isArray(group.entries) ? group.entries : [];
    cacheKey = group.id;
    const globalPreventRepeat = state?.roulette?.preventRepeat === true;
    preventRepeat = group.preventRepeat === true || (group.preventRepeat !== false && globalPreventRepeat);
  } else {
    notify('缺少合法的 roulette 参数，已返回原文。');
    return fallback;
  }

  const enabledEntries = entries.filter((entry) => isEntryEnabled(entry));
  if (!enabledEntries.length) {
    notify('可用的 roulette 条目为空，已返回原文。');
    return fallback;
  }

  const { entry } = pickWeighted(enabledEntries, { rng, preventRepeat, cacheKey });
  if (!entry || typeof entry.value !== 'string') {
    notify('roulette 选取失败，已返回原文。');
    return fallback;
  }

  if (!evaluator || evaluator.canEvaluate !== true) {
    return entry.value;
  }

  try {
    return await evaluator.expand(entry.value, depth + 1, environment);
  } catch (error) {
    notify('宏展开失败，已返回原文。');
    console.warn(`${TAG} 展开异常`, error);
    return entry.value;
  }
}

/**
 * 同步评估：用于键式宏注册（registerMacro）同步返回最终文本。
 * 仅支持通过 groupId 抽取（即 {{roulette_<groupId>}} 的场景），并在本地调用 ctx.substituteParams 做一次宏展开。
 * @param {{
 *   ctx: any;
 *   state: import('../state/manager.js').MacrosState;
 *   groupId: string;
 *   fallback?: string;
 *   rng?: () => number;
 * }} payload
 * @returns {string}
 */
export function evaluateSync(payload) {
  const {
    ctx,
    state,
    groupId,
    fallback = '',
    rng = Math.random,
  } = payload || {};

  const notify = createNotifier(ctx);

  if (typeof groupId !== 'string' || !groupId.trim()) {
    notify('缺少合法的 roulette 组 ID，已返回原文。');
    return fallback;
  }

  const group = resolveGroup(state, groupId);
  if (!group) {
    notify(`未找到名为 ${groupId} 的 roulette 宏组，已返回原文。`);
    return fallback;
  }

  const enabledEntries = (Array.isArray(group.entries) ? group.entries : []).filter(isEntryEnabled);
  if (!enabledEntries.length) {
    notify('可用的 roulette 条目为空，已返回原文。');
    return fallback;
  }

  const globalPreventRepeat = state?.roulette?.preventRepeat === true;
  const preventRepeat = group.preventRepeat === true || (group.preventRepeat !== false && globalPreventRepeat);
  const { entry } = pickWeighted(enabledEntries, { rng, preventRepeat, cacheKey: group.id });

  if (!entry || typeof entry.value !== 'string') {
    notify('roulette 选取失败，已返回原文。');
    return fallback;
  }

  // 多轮同步展开：最多 4 轮，直至内容稳定
  const MAX_SYNC_PASSES = 4;
  const expandOnce = (text) => {
    try {
      if (typeof ctx?.substituteParams === 'function') {
        return ctx.substituteParams(text);
      }
    } catch (error) {
      console.warn(`${TAG} substituteParams 展开异常`, error);
    }
    return text;
  };

  let current = String(entry.value ?? '');
  for (let i = 0; i < MAX_SYNC_PASSES; i += 1) {
    const next = expandOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * 清空运行期缓存（用于调试）。
 */
export function resetRouletteCache() {
  lastSelectionCache.clear();
}