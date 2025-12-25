/**
 * @file 状态管理：负责宏模块的初始化、校验、导入导出与持久化。
 */
import {
  EXTENSION_KEY,
  MODULE_NAMESPACE,
  MACRO_KEYS,
  DEFAULT_GROUP_IDS,
  STORAGE_KEYS,
  CASCADE_DEFAULTS,
  FLOW_DEFAULTS,
  MAX_MACRO_DEPTH,
} from '../constants.js';
import {
  createDefaultMacrosState,
  createDefaultRouletteGroup,
  createDefaultCascadeGroup,
  createDefaultFlowGroup,
  createDefaultRouletteEntry,
  createDefaultCascadeOption,
  createDefaultFlowItem,
  createMetadata,
  DEFAULT_STATE_VERSION,
} from './defaults.js';
import {
  validateGroupId,
  validateWeight,
  validateRange,
  detectCycle,
  detectDuplicates,
} from './validators.js';
import {
  generateId,
  normalizeWeight,
  splitInlineList,
  parseWeightedTokens,
} from '../runtime/utils.js';

const STATE_LOG_TAG = '[ST-Diff][macros:state]';
const ROULETTE_REF_REGEX = /\{\{\s*roulette_([a-zA-Z][\w-]{2,31})\s*\}\}/g;
const CASCADE_REF_REGEX = /\{\{\s*cascade_([a-zA-Z][\w-]{2,31})\s*\}\}/g;
const FLOW_REF_REGEX = /\{\{\s*flow_([a-zA-Z][\w-]{2,31})\s*\}\}/g;

/**
 * 自定义错误类型，便于UI捕获并提示。
 */
export class MacroStateError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   */
  constructor(message, details) {
    super(message);
    this.name = 'MacroStateError';
    if (details) {
      this.details = details;
    }
  }
}

/**
 * 初始化或升级宏模块的状态树。
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @returns {MacrosState}
 */
export function ensureMacrosState(ctx) {
  const root = ctx?.extensionSettings || (window.extension_settings ||= {});
  const extNamespace = (root[EXTENSION_KEY] ||= {});
  const state = (extNamespace[MODULE_NAMESPACE] ||= createDefaultMacrosState());

  if (typeof state.version !== 'number') {
    state.version = DEFAULT_STATE_VERSION;
  }

  // 根级独立开关迁移：缺失时默认启用，避免初装或历史配置导致未注册宏
  if (typeof state.enabled !== 'boolean') {
    state.enabled = true;
  }

  state.ui = normalizeUIState(state.ui);
  state.roulette = normalizeRouletteState(state.roulette);
  state.cascade = normalizeCascadeState(state.cascade);
  state.flow = normalizeFlowState(state.flow);

  return state;
}

/**
 * 持久化设置（兼容不同宿主版本）
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 */
export function saveMacrosState(ctx) {
  try {
    if (typeof ctx?.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    } else if (typeof ctx?.saveSettings === 'function') {
      ctx.saveSettings();
    } else if (typeof window.saveSettingsDebounced === 'function') {
      window.saveSettingsDebounced();
    } else if (typeof window.saveSettings === 'function') {
      window.saveSettings();
    }
  } catch (error) {
    console.warn('[ST-Diff][macros:state] 保存设置失败', error);
    try {
      const notifier = ctx?.ui?.notify ?? window?.stdiffNotify ?? window?.notify;
      if (typeof notifier === 'function') {
        const type = 'error';
        const prefersTriplet = notifier.length >= 3;

        try {
          if (prefersTriplet) {
            notifier(type, '保存设置失败，请查看控制台日志。', 'ST-Diff');
          } else {
            notifier('保存设置失败，请查看控制台日志。', type);
          }
        } catch {
          try { notifier('保存设置失败，请查看控制台日志。', type); } catch {}
          try { notifier(type, '保存设置失败，请查看控制台日志。', 'ST-Diff'); } catch {}
        }
      }
    } catch {}
  }
}

/**
 * 读取指定类型的宏组
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @param {string} id
 * @returns {RouletteGroup|CascadeGroup|null}
 */
export function getGroup(state, type, id) {
  if (type === MACRO_KEYS.ROULETTE) {
    return state?.roulette?.groups?.[id] || null;
  }
  if (type === MACRO_KEYS.CASCADE) {
    return state?.cascade?.groups?.[id] || null;
  }
  if (type === MACRO_KEYS.FLOW) {
    return state?.flow?.groups?.[id] || null;
  }
  return null;
}

/**
 * 写入或更新宏组
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @param {Partial<RouletteGroup>|Partial<CascadeGroup>} payload
 */
export function setGroup(ctx, state, type, payload) {
  const payloadId =
    typeof payload?.id === 'string' && payload.id
      ? payload.id
      : typeof payload?.identifier === 'string'
        ? payload.identifier
        : undefined;

  console.debug(STATE_LOG_TAG, 'setGroup invoked', {
    type,
    payloadId,
    existingRouletteKeys: Object.keys(state?.roulette?.groups ?? {}),
    existingCascadeKeys: Object.keys(state?.cascade?.groups ?? {}),
  });

  if (type === MACRO_KEYS.ROULETTE) {
    const normalized = normalizeRouletteGroup(payload, state);
    state.roulette.groups[normalized.id] = normalized;
    ensureActiveGroup(state.roulette, normalized.id);
    touchMetadata(state.roulette.metadata);
    console.debug(STATE_LOG_TAG, 'roulette group persisted', {
      normalizedId: normalized.id,
      totalGroups: Object.keys(state.roulette.groups).length,
      activeGroupId: state.roulette.activeGroupId,
    });
  } else if (type === MACRO_KEYS.CASCADE) {
    const normalized = normalizeCascadeGroup(payload, state);
    state.cascade.groups[normalized.id] = normalized;
    ensureActiveGroup(state.cascade, normalized.id);
    touchMetadata(state.cascade.metadata);
    console.debug(STATE_LOG_TAG, 'cascade group persisted', {
      normalizedId: normalized.id,
      totalGroups: Object.keys(state.cascade.groups).length,
      activeGroupId: state.cascade.activeGroupId,
    });
  } else if (type === MACRO_KEYS.FLOW) {
    const normalized = normalizeFlowGroup(payload, state);
    state.flow.groups[normalized.id] = normalized;
    ensureActiveGroup(state.flow, normalized.id);
    touchMetadata(state.flow.metadata);
    console.debug(STATE_LOG_TAG, 'flow group persisted', {
      normalizedId: normalized.id,
      totalGroups: Object.keys(state.flow.groups).length,
      activeGroupId: state.flow.activeGroupId,
    });
  } else {
    throw new MacroStateError(`未知的宏类型：${type}`);
  }

  state.version = DEFAULT_STATE_VERSION;
  touchMetadata(state.ui);
  saveMacrosState(ctx);

  console.debug(STATE_LOG_TAG, 'setGroup complete', {
    type,
    activeRoulette: state?.roulette?.activeGroupId,
    activeCascade: state?.cascade?.activeGroupId,
  });
}

/**
 * 删除宏组。
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @param {string} id
 */
export function deleteGroup(ctx, state, type, id) {
  const container =
    type === MACRO_KEYS.ROULETTE
      ? state?.roulette
      : type === MACRO_KEYS.CASCADE
        ? state?.cascade
        : type === MACRO_KEYS.FLOW
          ? state?.flow
          : null;

  if (!container) {
    throw new MacroStateError(`未知的宏类型：${type}`);
  }

  if (!container?.groups?.[id]) {
    throw new MacroStateError(`宏组 ${id} 不存在`);
  }

  const keys = Object.keys(container.groups);
  if (keys.length <= 1) {
    throw new MacroStateError('至少需要保留一个宏组，删除被拒绝');
  }

  delete container.groups[id];
  if (container.activeGroupId === id) {
    container.activeGroupId = Object.keys(container.groups)[0];
  }

  touchMetadata(container.metadata);
  state.version = DEFAULT_STATE_VERSION;
  saveMacrosState(ctx);
}

/**
 * 重命名宏组 ID，并同步更新所有引用 {{roulette_old}} / {{cascade_old}}
 * 该操作为“原子迁移”：修改 groups 的键名与组内 id 字段，同时重写跨类型引用字符串。
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @param {string} oldId
 * @param {string} newId
 */
export function renameGroup(ctx, state, type, oldId, newId) {
  const container =
    type === MACRO_KEYS.ROULETTE
      ? state?.roulette
      : type === MACRO_KEYS.CASCADE
        ? state?.cascade
        : type === MACRO_KEYS.FLOW
          ? state?.flow
          : null;

  if (!container) {
    throw new MacroStateError(`未知的宏类型：${type}`);
  }

  if (!container?.groups?.[oldId]) {
    throw new MacroStateError(`待重命名的宏组 ${oldId} 不存在`);
  }

  if (typeof newId !== 'string') {
    throw new MacroStateError('新的调用名(ID) 不能为空');
  }

  newId = newId.trim();
  if (newId === oldId) {
    return; // 无变更
  }

  const idValidation = validateGroupId(newId);
  if (!idValidation.ok) {
    throw new MacroStateError(idValidation.message || '新的调用名(ID) 不合法', { newId });
  }

  if (container.groups[newId]) {
    throw new MacroStateError(`调用名(ID)「${newId}」已存在，请换一个不重复的 ID`);
  }

  // 迁移该类型 groups 的键名与对象内 id 字段
  const group = container.groups[oldId];
  delete container.groups[oldId];
  group.id = newId;
  container.groups[newId] = group;

  // 活动指针迁移
  if (container.activeGroupId === oldId) {
    container.activeGroupId = newId;
  }

  // 同步更新所有引用
  updateReferencesForRename(state, type, oldId, newId);

  // 重新校验有向图，避免出现循环或悬挂引用
  verifyRouletteGraph(state.roulette.groups);
  verifyCascadeGraph(state.cascade.groups);
  verifyFlowGraph(state.flow.groups);

  // 元数据触碰与持久化
  touchMetadata(container.metadata);
  touchMetadata(state.ui?.metadata);
  state.version = DEFAULT_STATE_VERSION;
  saveMacrosState(ctx);
}

/* ------------------------------ 引用更新工具 ------------------------------ */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRefRegex(kind, id) {
  // 匹配 {{   roulette_id   }} / {{cascade_id}}，允许可选空白
  return new RegExp('\\{\\{\\s*' + kind + '_' + escapeRegExp(id) + '\\s*\\}\\}', 'g');
}

function replaceRefsInText(text, kind, oldId, newId) {
  if (typeof text !== 'string' || !text) return text;
  const regex = buildRefRegex(kind, oldId);
  const replacement = '{{' + kind + '_' + newId + '}}';
  return text.replace(regex, replacement);
}

/**
 * 在整个 macros 状态树中重写引用。
 * - 若重命名 roulette 组：需要在 roulette.entries[].value 与 cascade.options[].value 中替换 {{roulette_old}}
 * - 若重命名 cascade 组：需要在上述相同位置替换 {{cascade_old}}
 */
function updateReferencesForRename(state, type, oldId, newId) {
  const kinds = [];
  if (type === MACRO_KEYS.ROULETTE) {
    kinds.push('roulette');
  } else if (type === MACRO_KEYS.CASCADE) {
    kinds.push('cascade');
  } else if (type === MACRO_KEYS.FLOW) {
    kinds.push('flow');
  } else {
    return;
  }

  // 遍历 roulette 组的 entries
  if (state?.roulette?.groups) {
    for (const g of Object.values(state.roulette.groups)) {
      if (!Array.isArray(g.entries)) continue;
      g.entries = g.entries.map((entry) => {
        const next = { ...entry };
        kinds.forEach((k) => {
          next.value = replaceRefsInText(next.value, k, oldId, newId);
        });
        return next;
      });
    }
  }

  // 遍历 cascade 组的 options
  if (state?.cascade?.groups) {
    for (const g of Object.values(state.cascade.groups)) {
      if (!Array.isArray(g.options)) continue;
      g.options = g.options.map((opt) => {
        const next = { ...opt };
        kinds.forEach((k) => {
          next.value = replaceRefsInText(next.value, k, oldId, newId);
        });
        return next;
      });
    }
  }

  // 遍历 flow 组的 items
  if (state?.flow?.groups) {
    for (const g of Object.values(state.flow.groups)) {
      if (!Array.isArray(g.items)) continue;
      g.items = g.items.map((item) => {
        const next = { ...item };
        kinds.forEach((k) => {
          next.value = replaceRefsInText(next.value, k, oldId, newId);
        });
        return next;
      });
    }
  }
}

/**
 * 导出指定宏类型的配置快照。
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @returns {MacroExportPayload}
 */
export function exportModule(state, type) {
  if (type === MACRO_KEYS.ROULETTE) {
    return {
      version: state.version,
      type,
      groups: Object.values(state.roulette.groups).map(stripRuntimeFields),
    };
  }

  if (type === MACRO_KEYS.CASCADE) {
    return {
      version: state.version,
      type,
      groups: Object.values(state.cascade.groups).map(stripRuntimeFields),
    };
  }

  if (type === MACRO_KEYS.FLOW) {
    return {
      version: state.version,
      type,
      groups: Object.values(state.flow.groups).map(stripRuntimeFields),
    };
  }

  throw new MacroStateError(`未知的宏类型：${type}`);
}

/**
 * 导入宏配置。
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @param {MacrosState} state
 * @param {'roulette'|'cascade'} type
 * @param {string|object} payload
 */
export function importModule(ctx, state, type, payload) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new MacroStateError('导入文本不是合法的 JSON');
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new MacroStateError('导入数据为空或格式非法');
  }

  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  if (!groups.length) {
    throw new MacroStateError('导入数据未包含任何宏组');
  }

  const snapshot = {};
  for (const group of groups) {
    let normalized;
    if (type === MACRO_KEYS.ROULETTE) {
      normalized = normalizeRouletteGroup(group, state, { overwriteMetadata: true });
    } else if (type === MACRO_KEYS.CASCADE) {
      normalized = normalizeCascadeGroup(group, state, { overwriteMetadata: true });
    } else if (type === MACRO_KEYS.FLOW) {
      normalized = normalizeFlowGroup(group, state, { overwriteMetadata: true });
    } else {
      throw new MacroStateError(`未知的宏类型：${type}`);
    }
    snapshot[normalized.id] = normalized;
  }

  if (type === MACRO_KEYS.ROULETTE) {
    state.roulette.groups = snapshot;
    ensureActiveGroup(state.roulette, Object.keys(snapshot)[0]);
    touchMetadata(state.roulette.metadata);
  } else if (type === MACRO_KEYS.CASCADE) {
    state.cascade.groups = snapshot;
    ensureActiveGroup(state.cascade, Object.keys(snapshot)[0]);
    touchMetadata(state.cascade.metadata);
  } else if (type === MACRO_KEYS.FLOW) {
    state.flow.groups = snapshot;
    ensureActiveGroup(state.flow, Object.keys(snapshot)[0]);
    touchMetadata(state.flow.metadata);
  }

  state.version = DEFAULT_STATE_VERSION;
  saveMacrosState(ctx);
}

/* -------------------------------------------------------------------------- */
/*                                就叫Normalizers                                 */
/* -------------------------------------------------------------------------- */

function normalizeUIState(ui) {
  const normalized = typeof ui === 'object' && ui !== null ? { ...ui } : {};
  normalized.activeTab = Object.values(MACRO_KEYS).includes(normalized.activeTab)
    ? normalized.activeTab
    : MACRO_KEYS.ROULETTE;

  // UI 折叠状态：缺失时按模块设计默认折叠
  if (typeof normalized.collapsed !== 'boolean') {
    normalized.collapsed = true;
  }

  normalized.metadata = ensureMetadata(normalized.metadata);
  return normalized;
}

function normalizeRouletteState(state) {
  const normalized = typeof state === 'object' && state !== null ? { ...state } : {};
  normalized.enabled = normalized.enabled !== false;
  normalized.preventRepeat = normalized.preventRepeat === true;
  normalized.metadata = ensureMetadata(normalized.metadata);

  const groups = normalizeGroupMap(
    normalized.groups,
    () => createDefaultRouletteGroup(),
    (group) => normalizeRouletteGroup(group, normalized),
  );

  normalized.groups = groups;
  ensureActiveGroup(normalized, normalized.activeGroupId || Object.keys(groups)[0]);
  verifyRouletteGraph(groups);

  return normalized;
}

function normalizeCascadeState(state) {
  const normalized = typeof state === 'object' && state !== null ? { ...state } : {};
  normalized.enabled = normalized.enabled !== false;
  normalized.metadata = ensureMetadata(normalized.metadata);
  normalized.renumber = normalizeCascadeRenumber(normalized.renumber);

  const groups = normalizeGroupMap(
    normalized.groups,
    () => createDefaultCascadeGroup(),
    (group) => normalizeCascadeGroup(group, normalized),
  );

  normalized.groups = groups;
  ensureActiveGroup(normalized, normalized.activeGroupId || Object.keys(groups)[0]);
  verifyCascadeGraph(groups);

  return normalized;
}

function normalizeCascadeRenumber(renumber) {
  const enabled = renumber?.enabled !== false;
  const fallbackTag = 'framework';
  const rawTag = typeof renumber?.tagName === 'string' ? renumber.tagName : fallbackTag;
  const tagName = String(rawTag).trim() || fallbackTag;

  return {
    enabled,
    tagName: tagName.slice(0, 64),
  };
}

function normalizeFlowState(state) {
  const normalized = typeof state === 'object' && state !== null ? { ...state } : {};
  normalized.enabled = normalized.enabled !== false;
  normalized.metadata = ensureMetadata(normalized.metadata);

  const groups = normalizeGroupMap(
    normalized.groups,
    () => createDefaultFlowGroup(),
    (group) => normalizeFlowGroup(group, normalized),
  );

  normalized.groups = groups;
  ensureActiveGroup(normalized, normalized.activeGroupId || Object.keys(groups)[0]);
  verifyFlowGraph(groups);

  return normalized;
}

function normalizeGroupMap(rawGroups, factory, normalizer) {
  /** @type {Record<string, any>} */
  const groupMap = {};

  if (Array.isArray(rawGroups)) {
    for (const item of rawGroups) {
      const normalized = normalizer(item);
      groupMap[normalized.id] = normalized;
    }
  } else if (rawGroups && typeof rawGroups === 'object') {
    for (const key of Object.keys(rawGroups)) {
      const normalized = normalizer({ ...rawGroups[key], id: key });
      groupMap[normalized.id] = normalized;
    }
  }

  if (!Object.keys(groupMap).length) {
    const fallback = normalizer(factory());
    groupMap[fallback.id] = fallback;
  }

  return groupMap;
}

function normalizeRouletteGroup(group, state, options = {}) {
  const now = Date.now();
  const id = typeof group?.id === 'string' ? group.id : group?.identifier;

  const validation = validateGroupId(id || '');
  if (!validation.ok) {
    throw new MacroStateError(validation.message || '宏组 ID 非法', { group });
  }

  const normalized = {
    id: id.trim(),
    label: typeof group?.label === 'string' && group.label.trim() ? group.label.trim() : `roulette 宏 ${id}`,
    description: typeof group?.description === 'string' ? group.description : '',
    preventRepeat: group?.preventRepeat === true,
    entries: [],
    metadata: ensureMetadata(options.overwriteMetadata ? group?.metadata : createMetadata(now)),
  };

  const entries = Array.isArray(group?.entries)
    ? group.entries
    : deriveEntriesFromInline(group?.items || group?.values || '');

  if (!entries.length) {
    entries.push(createDefaultRouletteEntry());
  }

  normalized.entries = entries.map((entry) => normalizeRouletteEntry(entry));
  ensureUniqueEntryIds(normalized.entries, 'Roulette宏条目');

  const activeState = state?.roulette || {};
  if (activeState.groups && activeState.groups[normalized.id]) {
    normalized.metadata.createdAt = activeState.groups[normalized.id].metadata?.createdAt || normalized.metadata.createdAt;
  }
  touchMetadata(normalized.metadata, now);

  return normalized;
}

function normalizeCascadeGroup(group, state, options = {}) {
  const now = Date.now();
  const id = typeof group?.id === 'string' ? group.id : group?.identifier;

  const validation = validateGroupId(id || '');
  if (!validation.ok) {
    throw new MacroStateError(validation.message || '宏组 ID 非法', { group });
  }

  const normalized = {
    id: id.trim(),
    label: typeof group?.label === 'string' && group.label.trim() ? group.label.trim() : `cascade 宏 ${id}`,
    description: typeof group?.description === 'string' ? group.description : '',
    joiner: typeof group?.joiner === 'string' ? group.joiner : CASCADE_DEFAULTS.JOINER,
    prefix: typeof group?.prefix === 'string' ? group.prefix : CASCADE_DEFAULTS.PREFIX,
    dedupePrefix: group?.dedupePrefix !== false,
    allowDuplicate: group?.allowDuplicate !== false,
    sortMode: ['none', 'asc', 'desc'].includes(group?.sortMode) ? group.sortMode : CASCADE_DEFAULTS.SORT_MODE,
    range: { ...CASCADE_DEFAULTS.RANGE },
    options: [],
    metadata: ensureMetadata(options.overwriteMetadata ? group?.metadata : createMetadata(now)),
  };

  const rangeValidation = validateRange(group?.range || {});
  normalized.range = rangeValidation.value;
  if (!rangeValidation.ok) {
    throw new MacroStateError(rangeValidation.message || '范围非法', { group });
  }

  const optionsList = Array.isArray(group?.options)
    ? group.options
    : deriveOptionsFromInline(group?.items || group?.values || '');

  if (!optionsList.length) {
    optionsList.push(createDefaultCascadeOption());
  }

  normalized.options = optionsList.map((option) => normalizeCascadeOption(option));
  ensureUniqueEntryIds(normalized.options, '瀑布条目');

  const activeState = state?.cascade || {};
  if (activeState.groups && activeState.groups[normalized.id]) {
    normalized.metadata.createdAt = activeState.groups[normalized.id].metadata?.createdAt || normalized.metadata.createdAt;
  }
  touchMetadata(normalized.metadata, now);

  return normalized;
}

function normalizeFlowGroup(group, state, options = {}) {
  const now = Date.now();
  const id = typeof group?.id === 'string' ? group.id : group?.identifier;

  const validation = validateGroupId(id || '');
  if (!validation.ok) {
    throw new MacroStateError(validation.message || '宏组 ID 非法', { group });
  }

  const normalized = {
    id: id.trim(),
    label: typeof group?.label === 'string' && group.label.trim() ? group.label.trim() : `flow 宏 ${id}`,
    description: typeof group?.description === 'string' ? group.description : '',
    joiner: typeof group?.joiner === 'string' ? group.joiner : FLOW_DEFAULTS.JOINER,
    preventRepeat: group?.preventRepeat === true,
    range: { ...FLOW_DEFAULTS.RANGE },
    items: [],
    metadata: ensureMetadata(options.overwriteMetadata ? group?.metadata : createMetadata(now)),
  };

  const rangeValidation = validateRange(group?.range || {});
  normalized.range = rangeValidation.value;
  if (!rangeValidation.ok) {
    throw new MacroStateError(rangeValidation.message || '范围非法', { group });
  }

  const itemsList = Array.isArray(group?.items) ? group.items : [];

  if (!itemsList.length) {
    itemsList.push(createDefaultFlowItem());
  }

  normalized.items = itemsList.map((item) => normalizeFlowItem(item));
  ensureUniqueEntryIds(normalized.items, 'Flow宏条目');

  const activeState = state?.flow || {};
  if (activeState.groups && activeState.groups[normalized.id]) {
    normalized.metadata.createdAt = activeState.groups[normalized.id].metadata?.createdAt || normalized.metadata.createdAt;
  }
  touchMetadata(normalized.metadata, now);

  return normalized;
}

function normalizeRouletteEntry(entry) {
  const now = Date.now();
  const id =
    typeof entry?.id === 'string' && entry.id.trim()
      ? entry.id.trim()
      : generateId('roulette-entry');

  const weightValidation = validateWeight(entry?.weight, { min: 0 });
  if (!weightValidation.ok && weightValidation.message) {
    console.warn('[ST-Diff][macros] 权重自动纠正：', weightValidation.message);
  }

  return {
    id,
    label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : entry?.value || '未命名条目',
    value: typeof entry?.value === 'string' ? entry.value : String(entry?.value ?? ''),
    weight: weightValidation.value,
    enabled: entry?.enabled !== false,
    metadata: ensureMetadata(entry?.metadata, now),
  };
}

function normalizeCascadeOption(option) {
  const now = Date.now();
  const id =
    typeof option?.id === 'string' && option.id.trim()
      ? option.id.trim()
      : generateId('cascade-option');

  const weightValidation = validateWeight(option?.weight, { min: 0 });
  if (!weightValidation.ok && weightValidation.message) {
    console.warn('[ST-Diff][macros] 权重自动纠正：', weightValidation.message);
  }

  return {
    id,
    value: typeof option?.value === 'string' ? option.value : String(option?.value ?? ''),
    weight: weightValidation.value,
    enabled: option?.enabled !== false,
    metadata: ensureMetadata(option?.metadata, now),
  };
}

function normalizeFlowItem(item) {
  const now = Date.now();
  const id =
    typeof item?.id === 'string' && item.id.trim()
      ? item.id.trim()
      : generateId('flow-item');

  const weightValidation = validateWeight(item?.weight, { min: 0 });
  if (!weightValidation.ok && weightValidation.message) {
    console.warn('[ST-Diff][macros] 权重自动纠正：', weightValidation.message);
  }

  return {
    id,
    label: typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : item?.value || '未命名条目',
    value: typeof item?.value === 'string' ? item.value : String(item?.value ?? ''),
    weight: weightValidation.value,
    enabled: item?.enabled !== false,
    metadata: ensureMetadata(item?.metadata, now),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function ensureMetadata(meta, now = Date.now()) {
  const createdAt =
    Number.isFinite(meta?.createdAt) && meta.createdAt > 0 ? meta.createdAt : now;
  const updatedAt =
    Number.isFinite(meta?.updatedAt) && meta.updatedAt > 0 ? meta.updatedAt : now;
  return { createdAt, updatedAt };
}

function touchMetadata(meta, now = Date.now()) {
  if (!meta || typeof meta !== 'object') return;
  meta.updatedAt = now;
}

function ensureActiveGroup(container, id) {
  if (!container.groups[id]) {
    container.activeGroupId = Object.keys(container.groups)[0];
  } else {
    container.activeGroupId = id;
  }
}

function ensureUniqueEntryIds(list, label) {
  const duplicates = detectDuplicates(list, (item) => item.id);
  if (!duplicates.ok) {
    throw new MacroStateError(`${label}存在重复 ID：${duplicates.duplicates.join(', ')}`);
  }
}

function stripRuntimeFields(group) {
  const clone = JSON.parse(JSON.stringify(group));
  return clone;
}

function deriveEntriesFromInline(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  return parseWeightedTokens(splitInlineList(raw)).map((entry) => ({
    ...entry,
    id: generateId('roulette-entry'),
    enabled: true,
  }));
}

function deriveOptionsFromInline(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  return parseWeightedTokens(splitInlineList(raw)).map((entry) => ({
    ...entry,
    id: generateId('cascade-option'),
    enabled: true,
  }));
}

/* -------------------------------------------------------------------------- */
/*                                Graph Checks                                */
/* -------------------------------------------------------------------------- */

function verifyRouletteGraph(groups) {
  const adjacency = {};
  for (const [id, group] of Object.entries(groups)) {
    adjacency[id] = [];
    for (const entry of group.entries) {
      let match;
      while ((match = ROULETTE_REF_REGEX.exec(entry.value))) {
        adjacency[id].push(match[1]);
      }
    }
  }

  const cycle = detectCycle(adjacency);
  if (!cycle.ok) {
    throw new MacroStateError(cycle.message || '检测到宏组循环引用', cycle);
  }
}

function verifyCascadeGraph(groups) {
  const adjacency = {};
  for (const [id, group] of Object.entries(groups)) {
    adjacency[id] = [];
    for (const option of group.options) {
      let match;
      while ((match = CASCADE_REF_REGEX.exec(option.value))) {
        adjacency[id].push(match[1]);
      }
    }
  }

  const cycle = detectCycle(adjacency);
  if (!cycle.ok) {
    throw new MacroStateError(cycle.message || '检测到宏组循环引用', cycle);
  }
}

function verifyFlowGraph(groups) {
  const adjacency = {};
  for (const [id, group] of Object.entries(groups)) {
    adjacency[id] = [];
    const items = Array.isArray(group.items) ? group.items : [];
    for (const item of items) {
      let match;
      while ((match = FLOW_REF_REGEX.exec(item.value))) {
        adjacency[id].push(match[1]);
      }
    }
  }

  const cycle = detectCycle(adjacency);
  if (!cycle.ok) {
    throw new MacroStateError(cycle.message || '检测到宏组循环引用', cycle);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {ReturnType<typeof createDefaultMacrosState>} MacrosState
 * @typedef {ReturnType<typeof createDefaultRouletteGroup>} RouletteGroup
 * @typedef {ReturnType<typeof createDefaultCascadeGroup>} CascadeGroup
 * @typedef {ReturnType<typeof createDefaultFlowGroup>} FlowGroup
 * @typedef {{ version:number, type:'roulette'|'cascade'|'flow', groups:Array<RouletteGroup|CascadeGroup|FlowGroup> }} MacroExportPayload
 */