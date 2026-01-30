/**
 * @file 负责管理 noass 模块的设置读写逻辑，包括模板初始化与世界书组规范化。
 */
import {
  DEFAULT_TEMPLATE_NAME,
  defaultTemplate,
  defaultRule,
  defaultClewdTagTransferRule,
  defaultWorldbookGroup,
  WORLD_BOOK_GROUP_MODES,
  WORLD_BOOK_ANCHORS,
  WORLD_BOOK_DEFAULT_ROLE,
} from './defaults.js';

/**
 * 确保 extensionSettings 中存在 noass 命名空间，并返回对应状态对象。
 */
/**
 * 确保 `extensionSettings` 中存在 noass 命名空间并返回其状态对象。
 *
 * @param {object} ctx SillyTavern 扩展上下文
 * @returns {NoassState} noass 状态对象
 */
export function ensureState(ctx) {
  const root = ctx.extensionSettings || (window.extension_settings ||= {});
  const moduleState = (root['st-diff'] ||= {});
  const noass = (moduleState.noass ||= {});

  if (typeof noass.enabled === 'undefined') {
    noass.enabled = true;
  }

  noass.templates ||= {};
  if (!Object.keys(noass.templates).length) {
    noass.templates[DEFAULT_TEMPLATE_NAME] = cloneTemplate(defaultTemplate);
  }

  for (const name of Object.keys(noass.templates)) {
    ensureTemplateDefaults(noass.templates[name]);
  }

  if (!noass.active || !noass.templates[noass.active]) {
    noass.active = Object.keys(noass.templates)[0];
  }

  return noass;
}

/**
 * 保存设置（使用酒馆提供的节流方法）。
 */
/**
 * 将当前设置写回宿主，自动兼容不同的保存方法。
 *
 * @param {object} ctx SillyTavern 扩展上下文
 */
export function saveState(ctx) {
  if (typeof ctx?.saveSettingsDebounced === 'function') {
    ctx.saveSettingsDebounced();
  } else if (typeof ctx?.saveSettings === 'function') {
    ctx.saveSettings();
  } else if (typeof window.saveSettingsDebounced === 'function') {
    window.saveSettingsDebounced();
  } else if (typeof window.saveSettings === 'function') {
    window.saveSettings();
  }
}

/**
 * 深拷贝模板对象并补齐默认值。
 */
/**
 * 深拷贝模板并补齐默认值，避免引用共享。
 *
 * @param {NoassTemplate} template 原模板
 * @returns {NoassTemplate} 拷贝后的模板
 */
export function cloneTemplate(template) {
  return ensureTemplateDefaults(JSON.parse(JSON.stringify(template)));
}

/**
 * 规范化布尔值，兼容 'true'/'false'、'1'/'0'、'yes'/'no'、数值与空串等历史存储形态。
 * @param {*} value 原值
 * @param {boolean} def 默认值
 * @returns {boolean}
 */
function normalizeBool(value, def = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off', ''].includes(v)) return false;
    return def;
  }
  if (typeof value === 'number') return value !== 0;
  if (value == null) return def;
  // 其他类型（对象/函数等）一律回退默认
  return def;
}

/**
 * 为模板补齐默认字段，保持向后兼容。
 */
/**
 * 为模板对象补齐缺省字段，保持向后兼容。
 *
 * @param {NoassTemplate} template 模板对象
 * @returns {NoassTemplate} 已补齐默认值的模板
 */
export function ensureTemplateDefaults(template) {
  if (!template || typeof template !== 'object') {
    return cloneTemplate(defaultTemplate);
  }

  for (const key of Object.keys(defaultTemplate)) {
    if (typeof template[key] === 'undefined') {
      const def = defaultTemplate[key];
      template[key] = Array.isArray(def) ? def.slice() : typeof def === 'object' ? { ...def } : def;
    }
  }

  template.capture_rules = Array.isArray(template.capture_rules)
    ? template.capture_rules.map((rule) => ({
        enabled: rule?.enabled !== false,
        regex: rule?.regex || '',
        tag: rule?.tag || '',
        updateMode: rule?.updateMode === 'replace' ? 'replace' : 'accumulate',
        range: rule?.range || '',
      }))
    : [];

  template.clewd_tag_transfer_rules = Array.isArray(template.clewd_tag_transfer_rules)
    ? template.clewd_tag_transfer_rules.map((rule, index) => sanitizeClewdTagTransferRule(rule, index))
    : [];

  if (!template.stored_data || typeof template.stored_data !== 'object') {
    template.stored_data = {};
  }

  // 统一布尔字段为严格布尔，修复历史上可能存成字符串 "false"/"true" 导致 !!value 判定错误的问题
  template.capture_enabled = normalizeBool(template.capture_enabled, true);
  template.single_user = normalizeBool(template.single_user, false);
  template.inject_prefill = normalizeBool(template.inject_prefill, true);
  template.clean_clewd = normalizeBool(template.clean_clewd, false);
  template.debug_worldbook = normalizeBool(template.debug_worldbook, false);

  sanitizeWorldbookGroups(template);
  return template;
}

/**
 * 构造默认的 clewd 标签搬运规则。
 *
 * @param {number} [index=0] 规则顺序
 * @returns {object} 默认规则
 */
export function createDefaultClewdTagTransferRule(index = 0) {
  return {
    ...defaultClewdTagTransferRule,
    label: `规则${index + 1}`,
  };
}

/**
 * 规范化单条 clewd 标签搬运规则。
 *
 * @param {any} rule 原始规则
 * @param {number} [index=0] 规则顺序
 * @returns {{ enabled: boolean, label: string, startTag: string, endTag: string, targetTag: string }}
 */
export function sanitizeClewdTagTransferRule(rule, index = 0) {
  const base = createDefaultClewdTagTransferRule(index);
  if (!rule || typeof rule !== 'object') {
    return base;
  }

  const sanitized = { ...base, ...rule };
  sanitized.enabled = normalizeBool(rule.enabled, true);
  sanitized.label =
    typeof rule.label === 'string' && rule.label.trim()
      ? rule.label.trim()
      : base.label;
  sanitized.startTag = typeof rule.startTag === 'string' ? rule.startTag.trim() : '';
  sanitized.endTag = typeof rule.endTag === 'string' ? rule.endTag.trim() : '';
  sanitized.targetTag = typeof rule.targetTag === 'string' ? rule.targetTag.trim() : '';
  return sanitized;
}

/**
 * 规范化单个世界书策略组。
 */
/**
 * 规范化世界书策略组的配置项。
 *
 * @param {WorldbookGroup} group 原始策略配置
 * @param {number} [index=0] 策略在数组中的索引
 * @returns {WorldbookGroup} 规范化后的策略
 */
export function sanitizeWorldbookGroup(group, index = 0) {
  const base = createDefaultWorldbookGroup(index);
  if (!group || typeof group !== 'object') {
    return base;
  }

  const sanitized = { ...base, ...group };
  sanitized.enabled = group.enabled !== false;

  sanitized.label =
    typeof group.label === 'string' && group.label.trim() ? group.label.trim() : base.label;

  const allowedModes = Object.values(WORLD_BOOK_GROUP_MODES);
  sanitized.mode = allowedModes.includes(group.mode) ? group.mode : base.mode;

  const depth = group.depth || {};
  const depthMin = Number.isFinite(Number(depth.min)) ? Number(depth.min) : base.depth.min;
  const depthMax = Number.isFinite(Number(depth.max)) ? Number(depth.max) : depthMin;
  sanitized.depth =
    sanitized.mode === WORLD_BOOK_GROUP_MODES.GTE
      ? { min: depthMin }
      : { min: depthMin, max: depthMax };

  const whitelist = group.whitelist || {};
  const excludeDepths = Array.isArray(whitelist.excludeDepths)
    ? [...new Set(whitelist.excludeDepths.map(Number).filter((num) => Number.isInteger(num) && num >= 0))]
    : [];
  const excludeTitles = Array.isArray(whitelist.excludeTitles)
    ? [...new Set(whitelist.excludeTitles.map((title) => String(title).trim()).filter(Boolean))]
    : [];

  sanitized.whitelist = { excludeDepths, excludeTitles };

  const allowedAnchors = Object.values(WORLD_BOOK_ANCHORS);
  const target = group.target || {};
  const targetAnchor = allowedAnchors.includes(target.anchor) ? target.anchor : base.target.anchor;
  const targetRole =
    typeof target.role === 'string' && target.role.trim() ? target.role.trim() : WORLD_BOOK_DEFAULT_ROLE;
  const targetOrder = Number.isFinite(Number(target.order)) ? Number(target.order) : index;

  sanitized.target = {
    anchor: targetAnchor,
    customKey: typeof target.customKey === 'string' ? target.customKey.trim() : '',
    role: targetRole,
    order: targetOrder,
  };

  sanitized.clean_orphan_anchor = group.clean_orphan_anchor === true;

  sanitized.order = Number.isFinite(Number(group.order)) ? Number(group.order) : index;
  sanitized.target.order = Number.isFinite(Number(sanitized.target.order))
    ? Number(sanitized.target.order)
    : sanitized.order;

  return sanitized;
}

/**
 * 确保模板下的所有世界书策略组已规范化，并至少存在一组。
 */
/**
 * 遍历模板中的世界书组并进行规范化，确保至少存在一个策略。
 *
 * @param {NoassTemplate} template 模板对象
 */
export function sanitizeWorldbookGroups(template) {
  template.worldbook_groups = Array.isArray(template.worldbook_groups)
    ? template.worldbook_groups.map((group, index) => sanitizeWorldbookGroup(group, index))
    : [];

  if (!template.worldbook_groups.length) {
    template.worldbook_groups.push(createDefaultWorldbookGroup(0));
  }

  template.worldbook_groups.forEach((group, index) => {
    if (group.order === defaultWorldbookGroup.order) {
      group.order = index;
    }
    if (group.target?.order === defaultWorldbookGroup.target.order) {
      group.target.order = index;
    }
  });
}

/**
 * 生成默认世界书策略（带序号的副本）。
 */
/**
 * 根据索引生成默认的世界书策略，以便初始化或新增。
 *
 * @param {number} [index=0] 策略顺序
 * @returns {WorldbookGroup} 默认策略
 */
export function createDefaultWorldbookGroup(index = 0) {
  return {
    ...defaultWorldbookGroup,
    label: `策略${index + 1}`,
    target: { ...defaultWorldbookGroup.target, order: index },
    order: index,
  };
}

/**
 * 获取默认捕获规则（深copy）。
 */
/**
 * 构造默认捕获规则。
 *
 * @returns {CaptureRule} 默认规则
 */
export function createDefaultRule() {
  return { ...defaultRule };
}