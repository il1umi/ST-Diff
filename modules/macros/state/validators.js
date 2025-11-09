/**
 * @file 纯函数校验器：负责验证宏组ID、权重、范围配置与循环引用。
 */

const GROUP_ID_PATTERN = /^[a-zA-Z][\w-]{2,31}$/;
const DEFAULT_MIN_RANGE = 0;
const DEFAULT_MAX_RANGE = 500;

/**
 * 校验宏组ID
 * @param {string} id
 * @param {{ allowDefault?: boolean, reserved?: Set<string> }} [options]
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateGroupId(id, options = {}) {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) {
    return { ok: false, message: '宏组 ID 不能为空' };
  }

  if (!GROUP_ID_PATTERN.test(trimmed)) {
    return { ok: false, message: '宏组 ID 需以字母开头，可包含字母、数字、下划线或中划线（3~32 字符）' };
  }

  if (options.allowDefault === false && trimmed.startsWith('default')) {
    return { ok: false, message: 'default 前缀为系统保留，请使用其它命名' };
  }

  if (options.reserved?.has(trimmed)) {
    return { ok: false, message: `宏组 ID ${trimmed} 已被占用` };
  }

  return { ok: true };
}

/**
 * 校验权重值，返回规整后的浮点数
 * @param {unknown} weight
 * @param {{ min?: number, max?: number }} [options]
 * @returns {{ ok: boolean, value: number, message?: string }}
 */
export function validateWeight(weight, options = {}) {
  const min = Number.isFinite(options.min) ? options.min : 0;
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;

  const num = Number(weight);
  if (!Number.isFinite(num)) {
    return { ok: false, value: min, message: '权重必须为数字' };
  }

  if (num < min || num > max) {
    return { ok: false, value: clamp(num, min, max), message: `权重需介于 ${min} 与 ${max} 之间` };
  }

  const rounded = Math.round(num * 1e6) / 1e6;
  return { ok: true, value: rounded };
}

/**
 * 校验范围对象 `{ min, max }`
 * @param {{ min?: unknown, max?: unknown }} range
 * @param {{ min?: number, max?: number }} [options]
 * @returns {{ ok: boolean, value: { min:number, max:number }, message?: string }}
 */
export function validateRange(range, options = {}) {
  const absoluteMin = Number.isFinite(options.min) ? options.min : DEFAULT_MIN_RANGE;
  const absoluteMax = Number.isFinite(options.max) ? options.max : DEFAULT_MAX_RANGE;

  let minVal = Number(range?.min);
  let maxVal = Number(range?.max);

  if (!Number.isInteger(minVal)) minVal = absoluteMin;
  if (!Number.isInteger(maxVal)) maxVal = minVal;

  minVal = clamp(minVal, absoluteMin, absoluteMax);
  maxVal = clamp(maxVal, absoluteMin, absoluteMax);

  if (maxVal < minVal) {
    [minVal, maxVal] = [maxVal, minVal];
  }

  const value = { min: minVal, max: maxVal };
  const ok = Number.isInteger(minVal) && Number.isInteger(maxVal);
  return {
    ok,
    value,
    message: ok ? undefined : '范围需为整数',
  };
}

/**
 * 检测宏组引用图中是否存在环。
 *
 * @param {Record<string, string[]>} adjacency 表示引用关系的邻接表
 * @returns {{ ok: boolean, cycle?: string[], message?: string }}
 */
export function detectCycle(adjacency) {
  const visited = new Set();
  const stack = new Set();
  const path = [];

  const visit = (node) => {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      return path.slice(cycleStart).concat(node);
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    stack.add(node);
    path.push(node);

    const neighbors = adjacency[node] || [];
    for (const next of neighbors) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }

    stack.delete(node);
    path.pop();
    return null;
  };

  for (const node of Object.keys(adjacency)) {
    const cycle = visit(node);
    if (cycle) {
      return { ok: false, cycle, message: `检测到宏组循环引用：${cycle.join(' → ')}` };
    }
  }

  return { ok: true };
}

/**
 * 对数组元素执行唯一性校验。
 * @template T
 * @param {T[]} list
 * @param {(item: T) => string} keyExtractor
 * @returns {{ ok: boolean, duplicates: string[] }}
 */
export function detectDuplicates(list, keyExtractor) {
  const seen = new Set();
  const duplicates = new Set();

  for (const item of list) {
    const key = keyExtractor(item);
    if (seen.has(key)) {
      duplicates.add(key);
      continue;
    }
    seen.add(key);
  }

  return { ok: duplicates.size === 0, duplicates: [...duplicates] };
}

/**
 * 一个简易clamp，避免重复引入其它模块。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}