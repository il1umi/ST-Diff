/**
 * @file 声明 noass 模块使用到的常量默认值（模板、世界书组、命名空间等）。
 */
export const EXT_KEY = 'st-diff';
export const DEFAULT_TEMPLATE_NAME = '配置1';
export const NO_TRANS_TAG = '<|no-trans|>';

export const WORLD_BOOK_GROUP_MODES = Object.freeze({
  RANGE: 'depthRange',
  GTE: 'depthGE',
});

export const WORLD_BOOK_ANCHORS = Object.freeze({
  BEFORE: 'before',
  AFTER: 'after',
  HEADER: 'header',
  MEMORY: 'memory',
  CUSTOM: 'custom',
});

export const WORLD_BOOK_DEFAULT_ROLE = 'system';

export const WORLD_INFO_POSITION = Object.freeze({
  BEFORE: 0,
  AFTER: 1,
  AN_TOP: 2,
  AN_BOTTOM: 3,
  AT_DEPTH: 4,
  EM_TOP: 5,
  EM_BOTTOM: 6,
});

export const WORLD_BOOK_DEPTH_PRESETS = Array.from({ length: 10 }, (_, i) => i);

/**
 * 默认模板配置，供首次安装或缺失字段时回填使用。
 *
 * @type {import('./state.js').NoassTemplate}
 */
export const defaultTemplate = {
  user: 'Human',
  assistant: 'Assistant',
  example_user: 'H',
  example_assistant: 'A',
  system: 'SYSTEM',
  separator: '',
  separator_system: '',
  prefill_user: 'Continue the conversation.',
  capture_enabled: true,
  capture_rules: [],
  clewd_tag_transfer_rules: [],
  stored_data: {},
  worldbook_groups: [],
  debug_worldbook: false,
  single_user: false,
  inject_prefill: true,
  clean_clewd: false,
  collapsed_sections: {},
};

export const defaultRule = {
  enabled: true,
  regex: '',
  tag: '',
  updateMode: 'accumulate',
  range: '',
};

export const defaultClewdTagTransferRule = {
  enabled: true,
  label: '规则1',
  startTag: '',
  endTag: '',
  targetTag: '',
};

/**
 * 默认的世界书策略配置。
 *
 * @type {import('./state.js').WorldbookGroup}
 */
export const defaultWorldbookGroup = {
  enabled: true,
  label: '策略1',
  mode: WORLD_BOOK_GROUP_MODES.RANGE,
  depth: { min: 0, max: 0 },
  whitelist: { excludeDepths: [], excludeTitles: [] },
  target: {
    anchor: WORLD_BOOK_ANCHORS.BEFORE,
    customKey: '',
    role: WORLD_BOOK_DEFAULT_ROLE,
    order: 0,
  },
  clean_orphan_anchor: false,
  order: 0,
};