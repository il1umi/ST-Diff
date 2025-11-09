import {
  parseRange as parseRangeToken,
  parseWeightedTokens,
  randomIntInRange,
  sortStrings,
  splitInlineList,
} from './utils.js';
import { pickWeighted, parseInlineArgs as parseRouletteInline } from './roulette.js';
import { CASCADE_DEFAULTS } from '../constants.js';

const TAG = '[ST-Diff][macros][cascade]';

/**
 * @typedef {import('../state/manager.js').MacrosState} MacrosState
 * @typedef {import('../state/manager.js').CascadeGroup} CascadeGroup
 */

/**
 * 解析内联 cascade 参数。
 * 语法：`{{cascade:min-max::value|weight::value}}`
 * @param {string} raw
 * @returns {{ range: { min:number, max:number }, options: Array<{ value:string, weight:number, enabled:boolean }>, joiner:string, allowDuplicate:boolean, sortMode:'none'|'asc'|'desc' }}
 */
export function parseInlineArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      range: { ...CASCADE_DEFAULTS.RANGE },
      options: [],
      joiner: CASCADE_DEFAULTS.JOINER,
      allowDuplicate: CASCADE_DEFAULTS.ALLOW_DUPLICATE,
      sortMode: CASCADE_DEFAULTS.SORT_MODE,
    };
  }

  const tokens = splitInlineList(raw);
  if (!tokens.length) {
    return {
      range: { ...CASCADE_DEFAULTS.RANGE },
      options: [],
      joiner: CASCADE_DEFAULTS.JOINER,
      allowDuplicate: CASCADE_DEFAULTS.ALLOW_DUPLICATE,
      sortMode: CASCADE_DEFAULTS.SORT_MODE,
    };
  }

  const [rangeToken, ...optionTokens] = tokens;
  const range = parseRangeToken(rangeToken ?? '', { ...CASCADE_DEFAULTS.RANGE });

  const parsedOptions = parseWeightedTokens(optionTokens).map((item) => ({
    value: item.value,
    weight: Number.isFinite(item.weight) ? item.weight : 1,
    enabled: true,
  }));

  return {
    range,
    options: parsedOptions,
    joiner: CASCADE_DEFAULTS.JOINER,
    allowDuplicate: CASCADE_DEFAULTS.ALLOW_DUPLICATE,
    sortMode: CASCADE_DEFAULTS.SORT_MODE,
  };
}

/**
 * 根据宏组 ID 获取配置。
 * @param {MacrosState} state
 * @param {string} identifier
 * @returns {CascadeGroup|null}
 */
export function resolveGroup(state, identifier) {
  if (!state?.cascade || typeof identifier !== 'string') {
    return null;
  }

  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  return state.cascade.groups?.[trimmed] || null;
}

/**
 * 生成输出行数，处理禁重复场景。
 * @param {{ min:number, max:number }} range
 * @param {boolean} allowDuplicate
 * @param {number} optionsLength
 * @param {() => number} rng
 * @param {(message: string, level?: 'info'|'warn'|'error') => void} notify
 * @returns {number}
 */
export function generateCount(range, allowDuplicate, optionsLength, rng, notify) {
  const count = randomIntInRange(range, rng);

  if (!allowDuplicate && count > optionsLength) {
    notify(`瀑布抽取数量 ${count} 超出可用选项数，已自动调整为 ${optionsLength}。`, 'warn');
    return optionsLength;
  }

  return count;
}

/**
 * 内部：构造通知函数。
 * @param {any} ctx
 * @returns {(message:string, level?:'info'|'warn'|'error') => void}
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
 * 按配置执行 cascade 宏。
 * @param {{
 *   ctx: any;
 *   state: MacrosState;
 *   evaluator: { expand: (raw:string, depth?:number, env?:Record<string,unknown>) => Promise<string>; canEvaluate:boolean; maxDepth:number };
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

  let options = [];
  let range = { ...CASCADE_DEFAULTS.RANGE };
  let joiner = CASCADE_DEFAULTS.JOINER;
  let allowDuplicate = CASCADE_DEFAULTS.ALLOW_DUPLICATE;
  let sortMode = CASCADE_DEFAULTS.SORT_MODE;
  let prefix = CASCADE_DEFAULTS.PREFIX;

  if (typeof inlineArgs === 'string' && inlineArgs.trim()) {
    const parsed = parseInlineArgs(inlineArgs);
    options = parsed.options;
    range = parsed.range;
    joiner = parsed.joiner;
    allowDuplicate = parsed.allowDuplicate;
    sortMode = parsed.sortMode;
  } else if (typeof groupId === 'string' && groupId.trim()) {
    const group = resolveGroup(state, groupId);
    if (!group) {
      notify(`未找到名为 ${groupId} 的 cascade 宏组，已返回原文。`);
      return fallback;
    }

    options = Array.isArray(group.options) ? group.options : [];
    range = group.range ? { ...group.range } : { ...CASCADE_DEFAULTS.RANGE };
    joiner = typeof group.joiner === 'string' ? group.joiner : CASCADE_DEFAULTS.JOINER;
    prefix = typeof group.prefix === 'string' ? group.prefix : CASCADE_DEFAULTS.PREFIX;
    allowDuplicate = group.allowDuplicate !== false;
    sortMode = ['none', 'asc', 'desc'].includes(group.sortMode) ? group.sortMode : CASCADE_DEFAULTS.SORT_MODE;
  } else {
    notify('缺少合法的 cascade 参数，已返回原文。');
    return fallback;
  }

  const enabledOptions = options.filter((option) => option && option.enabled !== false);
  if (!enabledOptions.length) {
    notify('可用的 cascade 条目为空，已返回原文。');
    return fallback;
  }

  const count = generateCount(range, allowDuplicate, enabledOptions.length, rng, notify);
  if (count <= 0) {
    notify('生成条目数量为 0，已返回原文。', 'info');
    return fallback;
  }

  const results = [];
  let pool = enabledOptions.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  for (let i = 0; i < count; i += 1) {
    const selection = pickWeighted(pool, { rng, preventRepeat: false });
    const chosen = selection.entry;

    if (!chosen || typeof chosen.value !== 'string') {
      notify('cascade 选取失败，提前结束。');
      break;
    }

    if (!allowDuplicate) {
      pool = pool.filter((item) => (item.id ?? item.value) !== (chosen.id ?? chosen.value));
      if (!pool.length && i + 1 < count) {
        notify('可选条目耗尽，已提前结束抽取。', 'info');
      }
    }

    if (!evaluator || evaluator.canEvaluate !== true) {
      results.push(chosen.value);
      continue;
    }

    try {
      const expanded = await evaluator.expand(chosen.value, depth + 1, environment);
      results.push(expanded);
    } catch (error) {
      notify('宏展开失败，已使用原始文本。');
      console.warn(`${TAG} 展开异常`, error);
      results.push(chosen.value);
    }
  }

  if (!results.length) {
    return fallback;
  }

  let finalList = results.filter((item) => typeof item === 'string');
  finalList = sortStrings(finalList, sortMode);

  // 前缀+编号
  if (typeof prefix === 'string' && prefix.trim()) {
    finalList = finalList.map((line, idx) => `${prefix}${idx + 1}：${line}`);
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

  let output = finalList.join(joiner);
  for (let i = 0; i < MAX_SYNC_PASSES; i += 1) {
    const next = expandOnce(output);
    if (next === output) break;
    output = next;
  }

  return output;
}

/**
 * 复用 roulette 的内联解析（保持语法一致性）。
 * @deprecated 保留兼容外部调用，推荐使用 parseInlineArgs。
 */
export const parseOptionsInline = parseRouletteInline;
/**
 * 同步评估器：用于键式宏注册（registerMacro）同步返回最终文本。
 * 形态：{{cascade_<groupId>}}
 * 逻辑：读取宏组配置 → 计算抽取次数 → 逐次加权选取项 → 使用 substituteParams 做一次宏展开 → 排序 → join
 * 注意：不依赖异步 evaluator，保证可作为 MacrosParser 的同步值。
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
    notify('缺少合法的 cascade 组 ID，已返回原文。');
    return fallback;
  }

  const group = resolveGroup(state, groupId);
  if (!group) {
    notify(`未找到名为 ${groupId} 的 cascade 宏组，已返回原文。`);
    return fallback;
  }

  const options = Array.isArray(group.options) ? group.options : [];
  const enabledOptions = options.filter((opt) => opt && opt.enabled !== false);
  if (!enabledOptions.length) {
    notify('可用的 cascade 条目为空，已返回原文。');
    return fallback;
  }

  const range = group.range ? { ...group.range } : { ...CASCADE_DEFAULTS.RANGE };
  const joiner = typeof group.joiner === 'string' ? group.joiner : CASCADE_DEFAULTS.JOINER;
  const prefix = typeof group.prefix === 'string' ? group.prefix : CASCADE_DEFAULTS.PREFIX;
  const allowDuplicate = group.allowDuplicate !== false;
  const sortMode = ['none', 'asc', 'desc'].includes(group.sortMode) ? group.sortMode : CASCADE_DEFAULTS.SORT_MODE;

  const count = generateCount(range, allowDuplicate, enabledOptions.length, rng, notify);
  if (count <= 0) {
    notify('生成条目数量为 0，已返回原文。', 'info');
    return fallback;
  }

  const results = [];
  let pool = enabledOptions.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  for (let i = 0; i < count; i += 1) {
    const { entry } = pickWeighted(pool, { rng, preventRepeat: false });
    if (!entry || typeof entry.value !== 'string') {
      notify('cascade 选取失败，提前结束。');
      break;
    }

    // 去重策略：抽中过的项从池中移除
    if (!allowDuplicate) {
      pool = pool.filter((item) => (item.id ?? item.value) !== (entry.id ?? entry.value));
      if (!pool.length && i + 1 < count) {
        notify('可选条目耗尽，已提前结束抽取。', 'info');
      }
    }

    // 一次宏展开：让被选中的值中的其它宏（如 {{time}}、{{random}}、{{roulette_*}}）得到替换
    try {
      if (typeof ctx?.substituteParams === 'function') {
        results.push(ctx.substituteParams(entry.value));
      } else {
        results.push(entry.value);
      }
    } catch (error) {
      console.warn(`${TAG} substituteParams 展开异常`, error);
      results.push(entry.value);
    }
  }

  if (!results.length) {
    return fallback;
  }

  let finalList = results.filter((x) => typeof x === 'string');
  finalList = sortStrings(finalList, sortMode);
  if (typeof prefix === 'string' && prefix.trim()) {
    finalList = finalList.map((line, idx) => `${prefix}${idx + 1}：${line}`);
  }
  return finalList.join(joiner);
}