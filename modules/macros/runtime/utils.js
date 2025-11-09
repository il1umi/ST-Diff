/**
 * @file 通用工具：权重计算、序列解析、范围处理与随机数辅助。
 */

const UUID_FALLBACK_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成随机 ID，优先使用 crypto.randomUUID。
 * @param {string} [prefix='item']
 * @returns {string}
 */
export function generateId(prefix = 'item') {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  let suffix = '';
  for (let i = 0; i < 12; i += 1) {
    const index = Math.floor(Math.random() * UUID_FALLBACK_CHARS.length);
    suffix += UUID_FALLBACK_CHARS[index];
  }
  return `${prefix}-${Date.now().toString(36)}-${suffix}`;
}

/**
 * 将输入权重规范化为非负浮点数。
 * @param {unknown} value
 * @param {number} [fallback=1]
 * @returns {number}
 */
export function normalizeWeight(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  return Math.max(0, Math.round(num * 1e6) / 1e6);
}

/**
 * 归一化候选条目的权重并返回累计分布。
 * @param {Array<{ weight:number }>} entries
 * @returns {{ total: number, cumulative: number[] }}
 */
export function buildWeightAcc(entries) {
  const cumulative = [];
  let total = 0;

  for (const entry of entries) {
    const w = normalizeWeight(entry.weight, 1);
    total += w;
    cumulative.push(total);
  }

  return { total, cumulative };
}

/**
 * 按权重随机选择条目。
 * @template T
 * @param {T[]} entries
 * @param {{ total:number, cumulative:number[] }} stats
 * @param {() => number} [rng=Math.random]
 * @returns {{ item: T | null, index: number }}
 */
export function pickWeighted(entries, stats, rng = Math.random) {
  if (!entries.length || !stats || stats.total <= 0) {
    return { item: null, index: -1 };
  }

  const target = rng() * stats.total;
  const { cumulative } = stats;

  for (let i = 0; i < cumulative.length; i += 1) {
    if (target < cumulative[i]) {
      return { item: entries[i], index: i };
    }
  }

  return { item: entries[entries.length - 1], index: entries.length - 1 };
}

/**
 * 将内联宏参数转换为数组。
 * 支持使用 `::` 或 `,` 作为分隔，自动识别并处理转义逗号。
 * @param {string} raw
 * @returns {string[]}
 */
export function splitInlineList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }

  const trimmed = raw.trim();

  if (trimmed.includes('::')) {
    return trimmed.split('::').map((item) => item.trim()).filter(Boolean);
  }

  return trimmed
    .replace(/\\,/g, '__STD_MACRO_ESC_COMMA__')
    .split(',')
    .map((item) => item.trim().replace(/__STD_MACRO_ESC_COMMA__/g, ','))
    .filter(Boolean);
}

/**
 * 解析 `value|weight` 形式的字符串为条目描述。
 * @param {string[]} tokens
 * @returns {Array<{ value:string, weight:number }>}
 */
export function parseWeightedTokens(tokens) {
  return tokens.map((token) => {
    const parts = token.split('|');
    if (parts.length === 1) {
      return { value: parts[0], weight: 1 };
    }
    const value = parts.slice(0, -1).join('|').trim();
    const weight = normalizeWeight(parts.at(-1), 1);
    return { value, weight };
  });
}

/**
 * 解析 `min-max` 文本为范围对象。
 * @param {string} raw
 * @param {{ min:number, max:number }} defaults
 * @returns {{ min:number, max:number }}
 */
export function parseRange(raw, defaults = { min: 1, max: 1 }) {
  const fallback = { ...defaults };
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback;
  }

  const cleaned = raw.replace(/\s+/g, '');
  const [minText, maxText] = cleaned.split('-', 2);
  let minVal = Number(minText);
  let maxVal = typeof maxText === 'undefined' || maxText === '' ? minVal : Number(maxText);

  if (!Number.isFinite(minVal)) minVal = fallback.min;
  if (!Number.isFinite(maxVal)) maxVal = minVal;

  minVal = Math.max(0, Math.floor(minVal));
  maxVal = Math.max(0, Math.floor(maxVal));

  if (maxVal < minVal) {
    [minVal, maxVal] = [maxVal, minVal];
  }

  return { min: minVal, max: maxVal };
}

/**
 * 将数字裁剪在给定范围内。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * 根据范围生成随机整数。
 * @param {{ min:number, max:number }} range
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function randomIntInRange(range, rng = Math.random) {
  const min = Math.floor(range.min);
  const max = Math.floor(range.max);

  if (max <= min) {
    return min;
  }

  const delta = max - min + 1;
  return min + Math.floor(rng() * delta);
}

/**
 * 去除重复值，保持顺序。
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
export function uniq(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * 将字符串排序。
 * @param {string[]} items
 * @param {'none'|'asc'|'desc'} mode
 * @returns {string[]}
 */
export function sortStrings(items, mode = 'none') {
  if (mode === 'asc') {
    return [...items].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  if (mode === 'desc') {
    return [...items].sort((a, b) => b.localeCompare(a, 'zh-CN'));
  }
  return items;
}