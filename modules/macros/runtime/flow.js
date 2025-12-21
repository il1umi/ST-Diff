import { FLOW_DEFAULTS } from '../constants.js';
import { buildWeightAcc, clamp, pickWeighted, randomIntInRange } from './utils.js';

const TAG = '[ST-Diff][macros][flow]';

/**
 * @typedef {import('../state/manager.js').MacrosState} MacrosState
 * @typedef {import('../state/manager.js').FlowGroup} FlowGroup
 */

/**
 * 构造通知函数。
 * @param {any} ctx
 * @returns {(message:string, level?:'info'|'warn'|'error') => void}
 */
function createNotifier(ctx) {
  const hostNotify = ctx?.ui?.notify ?? window?.stdiffNotify ?? window?.notify;
  const normalizeType = (level) => (level === 'warn' ? 'warning' : level);

  if (typeof hostNotify === 'function') {
    return (message, level = 'warn') => {
      const type = normalizeType(level);
      try {
        // UI侧约定：notify(message, type)
        hostNotify(message, type);
      } catch (error) {
        try {
          // 兼容签名：notify(type, message, title)
          hostNotify(type, message, 'ST-Diff 宏');
        } catch (innerError) {
          console.warn(`${TAG} 通知失败`, innerError);
        }
      }
    };
  }

  const toastr = window?.toastr;
  if (toastr) {
    return (message, level = 'warn') => {
      const type = normalizeType(level);
      try {
        if (typeof toastr[type] === 'function') {
          toastr[type](message, 'ST-Diff 宏');
          return;
        }
      } catch (error) {
        console.warn(`${TAG} 通知失败`, error);
        return;
      }

      if (type === 'error') {
        console.error(`${TAG} ${message}`);
      } else {
        console.warn(`${TAG} ${message}`);
      }
    };
  }

  return (message, level = 'warn') => {
    if (level === 'error') {
      console.error(`${TAG} ${message}`);
    } else {
      console.warn(`${TAG} ${message}`);
    }
  };
}

/**
 * 判断条目启用状态。
 * @param {{ enabled?: boolean }} item
 * @returns {boolean}
 */
function isItemEnabled(item) {
  return item && item.enabled !== false;
}

/**
 * 根据ID获取配置。
 * @param {MacrosState} state
 * @param {string} identifier
 * @returns {FlowGroup|null}
 */
export function resolveGroup(state, identifier) {
  if (!state?.flow || typeof identifier !== 'string') {
    return null;
  }

  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  return state.flow.groups?.[trimmed] || null;
}

/**
 * 在候选池中按权重抽取一个元素，可选“禁止相邻重复”。
 * - 当开启禁止重复且候选项 大于等于 2 时，优先排除 lastToken 后再抽取。
 * - 若排除后为空或抽取失败，降级为允许重复
 *
 * @param {Array<{ id?: string, value: string, weight: number }>} pool
 * @param {{
 *   rng?: () => number;
 *   preventRepeat?: boolean;
 *   lastToken?: string|null;
 * }} options
 * @returns {{ item: { id?: string, value: string, weight: number } | null, token: string|null }}
 */
function pickFlowItem(pool, options = {}) {
  const { rng = Math.random, preventRepeat = false, lastToken = null } = options;

  if (!Array.isArray(pool) || !pool.length) {
    return { item: null, token: null };
  }

  const normalizedPool = pool.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  const tryPick = (items) => {
    let stats = buildWeightAcc(items);
    let effective = items;

    if (!stats || stats.total <= 0) {
      effective = items.map((x) => ({ ...x, weight: 1 }));
      stats = buildWeightAcc(effective);
    }

    const { item } = pickWeighted(effective, stats, rng);
    if (!item) return null;
    return item;
  };

  if (preventRepeat && lastToken && normalizedPool.length > 1) {
    const filtered = normalizedPool.filter((item) => (item.id ?? item.value) !== lastToken);
    if (filtered.length) {
      const picked = tryPick(filtered);
      if (picked) {
        return { item: picked, token: picked.id ?? picked.value ?? null };
      }
    }
  }

  const picked = tryPick(normalizedPool);
  if (!picked) {
    return { item: null, token: null };
  }
  return { item: picked, token: picked.id ?? picked.value ?? null };
}

/**
 * 异步：用于UI预览
 * @param {{
 *   ctx: any;
 *   state: MacrosState;
 *   evaluator: { expand: (raw:string, depth?:number, env?:Record<string,unknown>) => Promise<string>; canEvaluate:boolean; maxDepth:number };
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
    groupId,
    depth = 0,
    environment = {},
    fallback = '',
    rng = Math.random,
  } = payload || {};

  const notify = createNotifier(ctx);

  if (typeof groupId !== 'string' || !groupId.trim()) {
    notify('缺少合法的 flow 参数，已返回原文。');
    return fallback;
  }

  const group = resolveGroup(state, groupId);
  if (!group) {
    notify(`未找到名为 ${groupId} 的 flow 宏组，已返回原文。`);
    return fallback;
  }

  const joiner = typeof group.joiner === 'string' ? group.joiner : FLOW_DEFAULTS.JOINER;
  const preventRepeat = group.preventRepeat === true;

  const enabledItems = (Array.isArray(group.items) ? group.items : []).filter(isItemEnabled);
  if (!enabledItems.length) {
    notify('可用的 flow 条目为空，已返回原文。');
    return fallback;
  }

  const rawRange = group.range ? { ...group.range } : { ...FLOW_DEFAULTS.RANGE };
  const safeMax = clamp(Number(rawRange.max), 0, FLOW_DEFAULTS.MAX_OUTPUT);
  const safeMin = clamp(Number(rawRange.min), 0, safeMax);
  const range = {
    min: Number.isInteger(safeMin) ? safeMin : 0,
    max: Number.isInteger(safeMax) ? safeMax : Number.isInteger(safeMin) ? safeMin : 0,
  };

  let count = randomIntInRange(range, rng);
  if (count <= 0) {
    notify('生成条目数量为 0，已返回原文。', 'info');
    return fallback;
  }

  if (count > FLOW_DEFAULTS.MAX_OUTPUT) {
    notify(`flow 输出数量过大，已限制为 ${FLOW_DEFAULTS.MAX_OUTPUT}。`, 'warn');
    count = FLOW_DEFAULTS.MAX_OUTPUT;
  }

  const pool = enabledItems.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  const parts = [];
  let lastToken = null;

  for (let i = 0; i < count; i += 1) {
    const { item, token } = pickFlowItem(pool, { rng, preventRepeat, lastToken });
    if (!item || typeof item.value !== 'string') {
      notify('flow 选取失败，提前结束。');
      break;
    }

    let value = item.value;
    if (evaluator && evaluator.canEvaluate === true) {
      try {
        value = await evaluator.expand(value, depth + 1, environment);
      } catch (error) {
        console.warn(`${TAG} 展开异常`, error);
      }
    }

    parts.push(value);
    lastToken = token ?? null;
  }

  if (!parts.length) {
    return fallback;
  }

  // 多轮同步展开：最多 4 轮，直至内容稳定（与 roulette/cascade 对齐）
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

  let output = parts.join(joiner);
  for (let i = 0; i < MAX_SYNC_PASSES; i += 1) {
    const next = expandOnce(output);
    if (next === output) break;
    output = next;
  }

  return output;
}

/**
 * 同步评估：键式宏注册（registerMacro）同步返回最终文本。
 * 形态：{{flow_<groupId>}}
 * @param {{
 *   ctx: any;
 *   state: MacrosState;
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
    notify('缺少合法的 flow 组 ID，已返回原文。');
    return fallback;
  }

  const group = resolveGroup(state, groupId);
  if (!group) {
    notify(`未找到名为 ${groupId} 的 flow 宏组，已返回原文。`);
    return fallback;
  }

  const joiner = typeof group.joiner === 'string' ? group.joiner : FLOW_DEFAULTS.JOINER;
  const preventRepeat = group.preventRepeat === true;

  const enabledItems = (Array.isArray(group.items) ? group.items : []).filter(isItemEnabled);
  if (!enabledItems.length) {
    notify('可用的 flow 条目为空，已返回原文。');
    return fallback;
  }

  const rawRange = group.range ? { ...group.range } : { ...FLOW_DEFAULTS.RANGE };
  const safeMax = clamp(Number(rawRange.max), 0, FLOW_DEFAULTS.MAX_OUTPUT);
  const safeMin = clamp(Number(rawRange.min), 0, safeMax);
  const range = {
    min: Number.isInteger(safeMin) ? safeMin : 0,
    max: Number.isInteger(safeMax) ? safeMax : Number.isInteger(safeMin) ? safeMin : 0,
  };

  let count = randomIntInRange(range, rng);
  if (count <= 0) {
    notify('生成条目数量为 0，已返回原文。', 'info');
    return fallback;
  }

  if (count > FLOW_DEFAULTS.MAX_OUTPUT) {
    notify(`flow 输出数量过大，已限制为 ${FLOW_DEFAULTS.MAX_OUTPUT}。`, 'warn');
    count = FLOW_DEFAULTS.MAX_OUTPUT;
  }

  const pool = enabledItems.map((item) => ({
    ...item,
    weight: Number.isFinite(item.weight) ? item.weight : 0,
  }));

  const parts = [];
  let lastToken = null;

  for (let i = 0; i < count; i += 1) {
    const { item, token } = pickFlowItem(pool, { rng, preventRepeat, lastToken });
    if (!item || typeof item.value !== 'string') {
      notify('flow 选取失败，提前结束。');
      break;
    }
    parts.push(item.value);
    lastToken = token ?? null;
  }

  if (!parts.length) {
    return fallback;
  }

  // 多轮同步展开：最多 4 轮，直至内容稳定（与roulette对齐）
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

  let output = parts.join(joiner);
  for (let i = 0; i < MAX_SYNC_PASSES; i += 1) {
    const next = expandOnce(output);
    if (next === output) break;
    output = next;
  }

  return output;
}