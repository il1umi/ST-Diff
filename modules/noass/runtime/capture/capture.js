/**
 * @file 提供对捕获规则与存储占位数据的读写工具，供合并流水线与 UI 共用。
 */
import { defaultTemplate } from '../../state/defaults.js';

/**
 * 遍历捕获规则匹配文本并写入 stored_data。
 * 支持叠加/替换模式、范围过滤，返回值表示数据是否发生变化。
 */
/**
 * 依据模板配置的捕获规则扫描文本并写入 `stored_data`。
 *
 * @param {object} template 当前模板对象
 * @param {string} content 待匹配的原始文本
 * @returns {boolean} 是否对存储数据进行了修改
 */
export function captureAndStoreData(template, content) {
  const rules = template.capture_rules || [];
  if (!template.capture_enabled || !rules.length) {
    return false;
  }

  const storedData = ensureStoredDataContainer(template);
  let hasChanges = false;

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;

    try {
      const regexMatch = rule.regex.match(/^\/(.+)\/([gimsu]*)$/);
      if (!regexMatch) {
        console.warn('[ST-Diff][noass] 无效正则表达式：', rule.regex);
        continue;
      }

      const pattern = regexMatch[1];
      const flags = regexMatch[2];
      const regex = new RegExp(pattern, flags);

      regex.lastIndex = 0;
      const matches = [];
      let match;

      if (flags.includes('g')) {
        while ((match = regex.exec(content)) !== null) {
          matches.push(match[0]);
          if (match.index === regex.lastIndex) {
            regex.lastIndex++;
          }
        }
      } else {
        match = regex.exec(content);
        if (match) {
          matches.push(match[0]);
        }
      }

      if (!matches.length) continue;

      let filteredMatches = matches;
      if (rule.range && rule.range.trim()) {
        filteredMatches = filterByRange(matches, rule.range.trim());
      }
      if (!filteredMatches.length) continue;

      const tag = rule.tag;
      if (!tag) continue;

      if (rule.updateMode === 'replace') {
        storedData[tag] = filteredMatches.slice();
        hasChanges = true;
      } else {
        storedData[tag] = Array.isArray(storedData[tag]) ? storedData[tag] : [];
        const beforeLength = storedData[tag].length;
        for (const item of filteredMatches) {
          if (!storedData[tag].includes(item)) {
            storedData[tag].push(item);
          }
        }
        if (storedData[tag].length !== beforeLength) {
          hasChanges = true;
        }
      }
    } catch (error) {
      console.error('[ST-Diff][noass] 处理捕获规则出错：', rule.tag, error);
    }
  }

  return hasChanges;
}

/**
 * 获取 stored_data 的快照（深拷贝），供 UI 与日志使用。
 */
/**
 * 获取 `stored_data` 的不可变快照，供 UI 展示与日志记录使用。
 *
 * @param {object} template 当前模板对象
 * @returns {Record<string, string[]>} 存储条目的浅拷贝
 */
export function getStoredDataSnapshot(template) {
  const storedData = ensureStoredDataContainer(template);
  const snapshot = {};
  for (const [tag, entries] of Object.entries(storedData)) {
    snapshot[tag] = Array.isArray(entries) ? entries.map((entry) => normalizeText(entry)) : [];
  }
  return snapshot;
}

/**
 * 以“就位”方式清空 stored_data，保持对象引用不变。
 */
/**
 * 清空模板中的全部存储条目。
 *
 * @param {object} template 当前模板对象
 * @returns {Record<string, string[]>} 清空后的存储容器
 */
export function clearStoredData(template) {
  const storedData = ensureStoredDataContainer(template);
  Object.keys(storedData).forEach((key) => {
    delete storedData[key];
  });
  return storedData;
}

/**
 * 删除指定标记的存储数据。
 */
/**
 * 删除指定标记的存储数据。
 *
 * @param {object} template 当前模板对象
 * @param {string} tag 需要删除的占位标记
 * @returns {Record<string, string[]>} 更新后的存储容器
 */
export function removeStoredDataTag(template, tag) {
  if (!tag) return ensureStoredDataContainer(template);
  const storedData = ensureStoredDataContainer(template);
  if (Object.prototype.hasOwnProperty.call(storedData, tag)) {
    delete storedData[tag];
  }
  return storedData;
}

/**
 * 覆写指定标记的存储数据。传入空数组时会移除该标记。
 */
/**
 * 用新内容替换指定标记的存储数据。
 *
 * @param {object} template 当前模板对象
 * @param {string} tag 占位标记
 * @param {string[]} entries 替换内容数组
 * @returns {Record<string, string[]>} 更新后的存储容器
 */
export function setStoredDataEntries(template, tag, entries) {
  if (!tag) return ensureStoredDataContainer(template);
  const storedData = ensureStoredDataContainer(template);
  const sanitized = normalizeStoredEntries(entries);
  if (!sanitized.length) {
    delete storedData[tag];
  } else {
    storedData[tag] = sanitized;
  }
  return storedData;
}

/**
 * 解析文本内容为存储数组。
 */
/**
 * 将文本编辑器内容解析为存储数组。
 *
 * @param {string} text 文本形式的存储内容
 * @returns {string[]} 解析后的数组
 */
export function parseStoredDataText(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/\n---\n|\n-{3,}\n/)
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0);
}

/**
 * 将存储数组格式化为文本内容。
 */
/**
 * 将存储数组格式化为文本，使用 `---` 作为分隔。
 *
 * @param {string[]} entries 存储内容数组
 * @returns {string} 适合写回文本区域的串
 */
export function formatStoredDataEntries(entries) {
  const sanitized = normalizeStoredEntries(entries);
  return sanitized.join('\n---\n');
}

/** 解析 "+1,-2,+3~+5" 等片段，提取匹配结果中的子集。 */
/**
 * 按规则字符串筛选匹配结果子集，例如 `+1,+3~+5,-2`。
 *
 * @param {Array} array 原始匹配结果
 * @param {string} rangeStr 范围描述字符串
 * @returns {Array} 过滤后的结果
 */
export function filterByRange(array, rangeStr) {
  try {
    const result = [];
    const segments = rangeStr.split(',');

    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) continue;

      if (segment.includes('~')) {
        const [startRaw, endRaw] = segment.split('~');
        let startIndex = parseRangeIndex(startRaw, array.length);
        let endIndex = parseRangeIndex(endRaw, array.length);
        if (startIndex > endIndex) {
          const tmp = startIndex;
          startIndex = endIndex;
          endIndex = tmp;
        }
        for (let index = startIndex; index <= endIndex && index < array.length; index++) {
          if (index >= 0 && !result.includes(array[index])) {
            result.push(array[index]);
          }
        }
      } else {
        const index = parseRangeIndex(segment, array.length);
        if (index >= 0 && index < array.length && !result.includes(array[index])) {
          result.push(array[index]);
        }
      }
    }

    return result;
  } catch (error) {
    console.warn('[ST-Diff][noass] 范围格式无效：', rangeStr, error);
    return array;
  }
}

/** 将范围字符串转换为零基索引，兼容正负向两种写法。 */
/**
 * 将范围描述转换为数组索引。
 *
 * @param {string} indexStr 范围片段
 * @param {number} arrayLength 原数组长度
 * @returns {number} 转换后的索引
 */
export function parseRangeIndex(indexStr, arrayLength) {
  const trimmed = indexStr.trim();
  if (trimmed.startsWith('+')) {
    return parseInt(trimmed.substring(1), 10) - 1;
  }
  if (trimmed.startsWith('-')) {
    return arrayLength + parseInt(trimmed, 10);
  }
  return parseInt(trimmed, 10) - 1;
}

/**
 * 用 stored_data 中的内容替换占位符。
 * 当 cleanEmpty 为真时会同时清理未命中规则的占位符，避免残留。
 */
/**
 * 使用 `stored_data` 替换文本中的占位符。
 *
 * @param {string} content 原始文本
 * @param {object} template 当前模板
 * @param {boolean} [cleanEmpty=false] 是否移除未命中的占位符
 * @returns {string} 替换后的文本
 */
export function replaceTagsWithStoredData(content, template, cleanEmpty = false) {
  const storedData = ensureStoredDataContainer(template);
  const tags = new Set(Object.keys(storedData));
  if (cleanEmpty) {
    (template.capture_rules || [])
      .filter((rule) => rule?.tag)
      .forEach((rule) => tags.add(rule.tag));
  }

  let result = content;
  for (const tag of tags) {
    if (!tag || !result.includes(tag)) continue;
    const replacementArray = storedData[tag] || [];
    if (!replacementArray.length && !cleanEmpty) continue;
    const replacement = replacementArray.length ? replacementArray.join('\n') : '';
    const escapedTag = escapeRegExp(tag);
    const regex = new RegExp(escapedTag, 'g');
    result = result.replace(regex, replacement);
  }
  return result;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在缺省模板尚未初始化时，确保 stored_data 字段存在。
 * 某些调用方在 cloneTemplate(defaultTemplate) 之前仍引用 defaultTemplate.stored_data。
 */
defaultTemplate.stored_data ||= {};

function ensureStoredDataContainer(template) {
  if (!template || typeof template !== 'object') {
    return {};
  }
  if (!template.stored_data || typeof template.stored_data !== 'object') {
    template.stored_data = {};
  }
  return template.stored_data;
}

function normalizeStoredEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => normalizeText(entry)).filter((item) => item.length > 0);
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value).replace(/\r\n?/g, '\n').trim();
}