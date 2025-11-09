/**
 * @file 负责将世界书策略配置规范化为运行期结构，并生成目标标记前缀。
 */
import {
  WORLD_BOOK_GROUP_MODES,
  WORLD_BOOK_ANCHORS,
} from '../../state/defaults.js';
import { WORLD_BOOK_DEFAULT_ROLE, WORLD_BOOK_SENTINEL_PREFIX } from '../clewd/constants.js';

/**
 * 生成世界书目标标记前缀。
 * @param {number} index
 * @returns {string}
 */
/**
 * 生成唯一的世界书目标标记前缀，用于包裹启用条目段落。
 *
 * @param {number} [index=0] 基于顺序生成的标识
 * @returns {string} 目标标记前缀
 */
export function generateSentinelPrefix(index = 0) {
  return `${WORLD_BOOK_SENTINEL_PREFIX}${index}__`;
}

/**
 * 规范化单个世界书搬运组：
 * - 补齐缺失字段并保证类型安全；
 * - 将用户配置转换成运行期可直接处理的结构。
 */
/**
 * 将单个世界书策略组规范化，补齐默认值并校正非法配置。
 *
 * @param {object} group 原始策略配置
 * @param {number} [index=0] 在模板中的顺序索引
 * @returns {object|null} 规范化后的策略组，若输入非法返回 null
 */
export function normalizeWorldbookGroup(group, index = 0) {
  if (!group || typeof group !== 'object') {
    return null;
  }

  const normalized = { ...group };

  normalized.label =
    typeof group.label === 'string' && group.label.trim() ? group.label.trim() : `策略${index + 1}`;

  normalized.id =
    typeof group.id === 'string' && group.id.trim()
      ? group.id.trim()
      : `group-${index}`;
  normalized.enabled = group.enabled !== false;

  const allowedModes = Object.values(WORLD_BOOK_GROUP_MODES);
  normalized.mode = allowedModes.includes(group.mode) ? group.mode : WORLD_BOOK_GROUP_MODES.RANGE;

  const rawDepth = group.depth || {};
  const depthMin = Number.isFinite(Number(rawDepth.min)) ? Number(rawDepth.min) : 0;

  if (normalized.mode === WORLD_BOOK_GROUP_MODES.RANGE) {
    const depthMax = Number.isFinite(Number(rawDepth.max)) ? Number(rawDepth.max) : depthMin;
    normalized.depth = { min: depthMin, max: depthMax };
  } else {
    normalized.depth = { min: depthMin };
  }

  const whitelist = group.whitelist || {};
  const excludeDepths = Array.isArray(whitelist.excludeDepths)
    ? [...new Set(whitelist.excludeDepths.map(Number).filter((num) => Number.isFinite(num) && num >= 0))]
    : [];
  const excludeTitles = Array.isArray(whitelist.excludeTitles)
    ? [
        ...new Set(
          whitelist.excludeTitles
            .map((title) => String(title).trim())
            .filter(Boolean),
        ),
      ]
    : [];

  normalized.whitelist = {
    excludeDepths,
    excludeTitles,
  };

  const allowedAnchors = Object.values(WORLD_BOOK_ANCHORS);
  const target = group.target || {};
  const anchor = allowedAnchors.includes(target.anchor) ? target.anchor : WORLD_BOOK_ANCHORS.BEFORE;
  const customKey = typeof target.customKey === 'string' ? target.customKey.trim() : '';
  const role =
    typeof target.role === 'string' && target.role.trim() ? target.role.trim() : WORLD_BOOK_DEFAULT_ROLE;
  const order = Number.isFinite(Number(target.order)) ? Number(target.order) : index;

  normalized.target = {
    anchor,
    customKey,
    role,
    order,
  };

  normalized.clean_orphan_anchor = group.clean_orphan_anchor === true;

  const sentinelPrefix =
    typeof group.sentinel?.prefix === 'string' && group.sentinel.prefix.trim()
      ? group.sentinel.prefix.trim()
      : generateSentinelPrefix(index);

  normalized.sentinel = {
    prefix: sentinelPrefix,
    opened: !!group.sentinel?.opened,
    moved: !!group.sentinel?.moved,
  };

  normalized.order = Number.isFinite(Number(group.order)) ? Number(group.order) : order;

  return normalized;
}

/**
 * 构建运行期世界书搬运组集合：
 * - 过滤未启用的组；
 * - 预编译白名单、深度匹配函数、排序信息等。
 */
/**
 * 根据模板构建运行期可用的世界书策略组集合。
 *
 * @param {object} template 当前模板
 * @returns {Array<object>} 经过排序与预编译的策略组列表
 */
export function buildWorldbookRuntimeGroups(template) {
  if (!template || !Array.isArray(template.worldbook_groups)) {
    return [];
  }

  const runtimeGroups = [];

  template.worldbook_groups.forEach((group, index) => {
    const normalized = normalizeWorldbookGroup(group, index);
    if (!normalized || normalized.enabled === false) return;

    const whitelistTitles = normalized.whitelist.excludeTitles.map((title) => title.toLowerCase());

    const runtime = {
      id: normalized.id,
      label: normalized.label,
      mode: normalized.mode,
      depth: normalized.depth,
      whitelist: normalized.whitelist,
      whitelistDepths: new Set(normalized.whitelist.excludeDepths),
      whitelistTitles: new Set(whitelistTitles),
      target: { ...normalized.target },
      sentinel: { prefix: normalized.sentinel.prefix, opened: false, moved: false },
      clean_orphan_anchor: normalized.clean_orphan_anchor === true,
      order: normalized.order,
    };

    runtime.matches = new Map();

    runtime.depthMatcher =
      runtime.mode === WORLD_BOOK_GROUP_MODES.GTE
        ? (depth) => Number.isFinite(depth) && depth >= runtime.depth.min
        : (depth) =>
            Number.isFinite(depth) &&
            depth >= runtime.depth.min &&
            depth <= runtime.depth.max;

    runtimeGroups.push(runtime);
  });

  runtimeGroups.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.target.order !== b.target.order) return a.target.order - b.target.order;
    return a.id.localeCompare(b.id);
  });

  return runtimeGroups;
}