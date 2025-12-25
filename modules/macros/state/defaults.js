/**
 * @file 默认状态构造器：提供宏模块初始化所需的数据结构。
 */
import { DEFAULT_GROUP_IDS, MACRO_KEYS, CASCADE_DEFAULTS, FLOW_DEFAULTS } from '../constants.js';
import { generateId } from '../runtime/utils.js';

export const DEFAULT_STATE_VERSION = 1;

function currentTimestamp() {
  return Date.now();
}

export function createMetadata(now = currentTimestamp()) {
  return {
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultRouletteEntry(value = '示例元素', weight = 1) {
  const now = currentTimestamp();
  return {
    id: generateId('roulette-entry'),
    label: value,
    value,
    weight,
    enabled: true,
    metadata: createMetadata(now),
  };
}

export function createDefaultRouletteGroup(id = DEFAULT_GROUP_IDS.ROULETTE) {
  const now = currentTimestamp();
  return {
    id,
    label: '默认 roulette 宏',
    description: '',
    preventRepeat: false,
    entries: [
      createDefaultRouletteEntry('示例元素 A', 1),
      createDefaultRouletteEntry('示例元素 B', 1),
    ],
    metadata: createMetadata(now),
  };
}

export function createDefaultCascadeOption(value = '示例元素', weight = 1) {
  const now = currentTimestamp();
  return {
    id: generateId('cascade-option'),
    value,
    weight,
    enabled: true,
    metadata: createMetadata(now),
  };
}

export function createDefaultCascadeGroup(id = DEFAULT_GROUP_IDS.CASCADE) {
  const now = currentTimestamp();
  return {
    id,
    label: '默认 cascade 宏',
    description: '',
    range: { ...CASCADE_DEFAULTS.RANGE },
    joiner: CASCADE_DEFAULTS.JOINER,
    prefix: CASCADE_DEFAULTS.PREFIX,
    dedupePrefix: true,
    allowDuplicate: CASCADE_DEFAULTS.ALLOW_DUPLICATE,
    sortMode: CASCADE_DEFAULTS.SORT_MODE,
    options: [
      createDefaultCascadeOption('示例元素 A', 1),
      createDefaultCascadeOption('示例元素 B', 1),
      createDefaultCascadeOption('示例元素 C', 1),
    ],
    metadata: createMetadata(now),
  };
}

export function createDefaultFlowItem(value = '示例元素', weight = 1) {
  const now = currentTimestamp();
  return {
    id: generateId('flow-item'),
    label: value,
    value,
    weight,
    enabled: true,
    metadata: createMetadata(now),
  };
}

export function createDefaultFlowGroup(id = DEFAULT_GROUP_IDS.FLOW) {
  const now = currentTimestamp();
  return {
    id,
    label: '默认 flow 宏',
    description: '',
    range: { ...FLOW_DEFAULTS.RANGE },
    joiner: FLOW_DEFAULTS.JOINER,
    preventRepeat: FLOW_DEFAULTS.PREVENT_REPEAT,
    items: [
      createDefaultFlowItem('示例元素 A', 1),
      createDefaultFlowItem('示例元素 B', 1),
      createDefaultFlowItem('示例元素 C', 1),
    ],
    metadata: createMetadata(now),
  };
}

export function createDefaultMacrosState() {
  const now = currentTimestamp();

  const rouletteGroup = createDefaultRouletteGroup();
  const cascadeGroup = createDefaultCascadeGroup();
  const flowGroup = createDefaultFlowGroup();

  return {
    version: DEFAULT_STATE_VERSION,
    enabled: true,
    ui: {
      activeTab: MACRO_KEYS.ROULETTE,
      collapsed: true,
      metadata: createMetadata(now),
    },
    roulette: {
      enabled: true,
      preventRepeat: false,
      activeGroupId: rouletteGroup.id,
      groups: {
        [rouletteGroup.id]: rouletteGroup,
      },
      metadata: createMetadata(now),
    },
    cascade: {
      enabled: true,
      renumber: {
        enabled: true,
        tagName: 'framework',
      },
      activeGroupId: cascadeGroup.id,
      groups: {
        [cascadeGroup.id]: cascadeGroup,
      },
      metadata: createMetadata(now),
    },
    flow: {
      enabled: true,
      activeGroupId: flowGroup.id,
      groups: {
        [flowGroup.id]: flowGroup,
      },
      metadata: createMetadata(now),
    },
  };
}