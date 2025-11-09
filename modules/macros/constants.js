/**
 * @file 常量定义：宏模块使用的键值、配置上限与 UI 选择器。
 */

export const EXTENSION_KEY = 'st-diff';
export const MODULE_NAMESPACE = 'macros';

export const MACRO_KEYS = Object.freeze({
  ROULETTE: 'roulette',
  CASCADE: 'cascade',
});

export const DEFAULT_GROUP_IDS = Object.freeze({
  ROULETTE: 'defaultRoulette',
  CASCADE: 'defaultCascade',
});

export const MAX_MACRO_DEPTH = 16;

export const CASCADE_DEFAULTS = Object.freeze({
  RANGE: { min: 1, max: 1 },
  JOINER: '\n',
  ALLOW_DUPLICATE: true,
  SORT_MODE: 'none', // none | asc | desc
  PREFIX: '', // 每行前缀；非空时将在行首添加“<PREFIX><index>：”
});

export const UI_SELECTORS = Object.freeze({
  ROOT_SECTION: '[data-stdiff-section="macros"]',
  TABS: '[data-macros-tabs]',
  PANE: '[data-pane]',
  TOOLBAR: '[data-macros-actions]',
  ROULETTE_PANE: '[data-pane="roulette"]',
  CASCADE_PANE: '[data-pane="cascade"]',
  PREVIEW: '[data-macros-preview]',
  ENABLE_TOGGLE: '#stdiff-macros-enabled',
  ROOT_BODY: '#stdiff-macros-body',
});

export const STORAGE_KEYS = Object.freeze({
  STATE_VERSION: 'version',
  ROULETTE: 'roulette',
  CASCADE: 'cascade',
});