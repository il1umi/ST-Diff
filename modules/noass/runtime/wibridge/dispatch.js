/**
 * @file 负责将世界书段落从合并结果中抽取出来，并根据策略搬运到目标位置。
 */
import { WORLD_BOOK_ANCHORS, WORLD_BOOK_DEFAULT_ROLE } from '../../state/defaults.js';
import {
  DRY_RUN_STATUS,
  warnWorldbookIssue,
  appendDryRunSegments,
  pushDryRunDispatch,
  updateDryRunEntryStatus,
  collectGroupMatchedEntries,
  summarizeTextForDiagnostics,
} from './state.js';
import { captureContextPreview } from './sentinel.js';

const regexEscape = (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 统一世界书片段换行符与空行，保证表现一致。
 */
export function normalizeWorldbookFragment(fragment) {
  if (typeof fragment !== 'string') return '';
  const unified = fragment.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = unified.trim();
  return trimmed.replace(/\n{3,}/g, '\n\n');
}

/**
 * 对完整文本执行换行规范化，移除多余空行并应用 trim，避免 clewd 输出出现额外空白。
 */
export function normalizeWorldbookContent(text) {
  if (typeof text !== 'string') return '';
  const unified = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const collapsed = unified.replace(/\n{3,}/g, '\n\n');
  return collapsed.trim();
}

function summarizePreviewPayload(snippet, location) {
  return {
    location,
    snippet: summarizeTextForDiagnostics(snippet ?? '', 160),
  };
}

/**
 * 将提取出的世界书段落按目标锚点写入。
 */
/**
 * 根据策略组配置将提取的世界书片段写入目标位置。
 *
 * @param {object} group 运行期世界书策略组
 * @param {string[]} segments 已抽取的世界书片段
 * @param {{ value: string }} contentHolder 合并文本容器
 * @param {Array<object>} beforeMessages 追加到主消息之前的列表
 * @param {Array<object>} afterMessages 追加到主消息之后的列表
 * @returns {{ status: string, anchor: string, role: string, reason: string | null, preview: object | null }}
 */
export function applyWorldbookSegmentDispatch(group, segments, contentHolder, beforeMessages, afterMessages) {
  const role = group?.target?.role?.trim() || WORLD_BOOK_DEFAULT_ROLE;
  const anchor = group?.target?.anchor || WORLD_BOOK_ANCHORS.AFTER;
  const resultInfo = {
    status: DRY_RUN_STATUS.SUCCESS,
    anchor,
    role,
    reason: null,
    preview: null,
  };

  const payload = normalizeWorldbookFragment(segments.join('\n\n'));
  if (!payload) {
    resultInfo.status = DRY_RUN_STATUS.FAILED;
    resultInfo.reason = 'empty payload after normalization';
    return resultInfo;
  }

  const message = { role, content: payload };
  let preview = null;

  switch (anchor) {
    case WORLD_BOOK_ANCHORS.BEFORE:
      beforeMessages.push(message);
      preview = summarizePreviewPayload(message.content, WORLD_BOOK_ANCHORS.BEFORE);
      pushDryRunDispatch(group, 'before', message);
      break;

    case WORLD_BOOK_ANCHORS.AFTER:
      afterMessages.push(message);
      preview = summarizePreviewPayload(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'after', message);
      break;

    case WORLD_BOOK_ANCHORS.HEADER: {
      contentHolder.value = normalizeWorldbookContent(`${payload}\n\n${contentHolder.value}`);
      const contextPreview = captureContextPreview(contentHolder.value, payload, { before: 80, after: 80 });
      preview = summarizePreviewPayload(contextPreview || payload, WORLD_BOOK_ANCHORS.HEADER);
      pushDryRunDispatch(group, 'header', payload);
      break;
    }

    case WORLD_BOOK_ANCHORS.MEMORY: {
      contentHolder.value = normalizeWorldbookContent(`${contentHolder.value}\n\n${payload}`);
      const contextPreview = captureContextPreview(contentHolder.value, payload, { before: 80, after: 80 });
      preview = summarizePreviewPayload(contextPreview || payload, WORLD_BOOK_ANCHORS.MEMORY);
      pushDryRunDispatch(group, 'memory', payload);
      break;
    }

    case WORLD_BOOK_ANCHORS.CUSTOM: {
      const key = (group?.target?.customKey || '').trim();
      if (key) {
        const anchorIndex = contentHolder.value.indexOf(key);
        if (anchorIndex !== -1) {
          const beforeAnchor = contentHolder.value.slice(0, anchorIndex);
          const afterAnchor = contentHolder.value.slice(anchorIndex + key.length);
          contentHolder.value = `${beforeAnchor}${payload}${afterAnchor}`;
          const contextPreview = captureContextPreview(contentHolder.value, payload, { before: 80, after: 80 });
          preview = summarizePreviewPayload(contextPreview || payload, `${WORLD_BOOK_ANCHORS.CUSTOM}:${key}`);
          pushDryRunDispatch(group, 'custom', payload);
          break;
        }

        resultInfo.status = DRY_RUN_STATUS.FALLBACK;
        resultInfo.reason = `custom anchor "${key}" not found`;
      } else {
        resultInfo.status = DRY_RUN_STATUS.FALLBACK;
        resultInfo.reason = 'custom anchor not specified';
      }

      resultInfo.anchor = WORLD_BOOK_ANCHORS.AFTER;
      afterMessages.push(message);
      preview = summarizePreviewPayload(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'custom', message, { fallback: true });
      break;
    }

    default:
      afterMessages.push(message);
      preview = summarizePreviewPayload(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'after', message);
      break;
  }

  resultInfo.preview = preview;

  return resultInfo;
}

/**
 * 从 clewd 合并结果中抽取目标标记内容并搬移。
 */
/**
 * 将合并文本中的目标标记段抽取出来，并调用 {@link applyWorldbookSegmentDispatch} 完成搬运。
 *
 * @param {object} config 运行期配置
 * @param {{ role: string, content: string }} mergedAssistantMessage 合并后的助手消息
 * @returns {{ before: Array<object>, after: Array<object> }} 追加到主消息前后的内容
 */
export function dispatchWorldbookSegments(config, mergedAssistantMessage) {
  const result = { before: [], after: [] };
  const groups = config?.worldbook?.groups;
  if (!Array.isArray(groups) || !groups.length || !mergedAssistantMessage?.content) {
    return result;
  }

  const contentHolder = { value: mergedAssistantMessage.content };

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const prefix = group.sentinel?.prefix;
    if (!prefix) continue;

    const beginMarker = `${prefix}BEGIN`;
    const endMarker = `${prefix}END`;
    const pattern = new RegExp(`${regexEscape(beginMarker)}([\\s\\S]*?)${regexEscape(endMarker)}`, 'g');
    const segments = [];
    const matchedEntryKeys = collectGroupMatchedEntries(group);

    const defaultAnchor = group?.target?.anchor || WORLD_BOOK_ANCHORS.AFTER;
    const defaultRole = group?.target?.role || WORLD_BOOK_DEFAULT_ROLE;

    contentHolder.value = contentHolder.value.replace(pattern, (_match, inner) => {
      const normalized = normalizeWorldbookFragment(inner);
      if (normalized) {
        segments.push(normalized);
      }
      return '';
    });

    const orphanBegin = contentHolder.value.includes(beginMarker);
    const orphanEnd = contentHolder.value.includes(endMarker);
    if (orphanBegin || orphanEnd) {
      warnWorldbookIssue('unpaired sentinel markers detected', {
        group: group.id,
        beginRemaining: orphanBegin,
        endRemaining: orphanEnd,
      });
      contentHolder.value = contentHolder.value
        .replace(new RegExp(regexEscape(beginMarker), 'g'), '')
        .replace(new RegExp(regexEscape(endMarker), 'g'), '');
    }

    if (!segments.length) {
      if (matchedEntryKeys.length) {
        matchedEntryKeys.forEach((entryKey) =>
          updateDryRunEntryStatus(group, entryKey, DRY_RUN_STATUS.FALLBACK, {
            anchor: defaultAnchor,
            role: defaultRole,
            reason: 'no worldbook segments extracted between sentinels',
            preview: null,
          }),
        );
      }

      if (
        group.target?.anchor === WORLD_BOOK_ANCHORS.CUSTOM &&
        group.clean_orphan_anchor === true
      ) {
        const orphanKey = (group.target.customKey || '').trim();
        if (orphanKey && contentHolder.value.includes(orphanKey)) {
          contentHolder.value = contentHolder.value.split(orphanKey).join('');
        }
      }

      if (group.sentinel?.opened) {
        warnWorldbookIssue('sentinel opened without extracted segments', { group: group.id });
      }
      continue;
    }

    if (group.sentinel?.moved) {
      warnWorldbookIssue('duplicate worldbook dispatch detected, skipping group', { group: group.id });
      continue;
    }

    if (group.matches instanceof Map) {
      group.matches.clear();
    }

    appendDryRunSegments(group, segments);
    group.sentinel = group.sentinel || {};
    group.sentinel.opened = false;

    let dispatchInfo;
    try {
      dispatchInfo = applyWorldbookSegmentDispatch(group, segments, contentHolder, result.before, result.after);
      group.sentinel.moved = true;
    } catch (error) {
      warnWorldbookIssue('failed to dispatch worldbook segments', { group: group.id, error });
      dispatchInfo = {
        status: DRY_RUN_STATUS.FAILED,
        anchor: defaultAnchor,
        role: defaultRole,
        reason: error?.message || 'worldbook dispatch failed',
        preview: null,
      };
    }

    const statusValue = dispatchInfo?.status || DRY_RUN_STATUS.SUCCESS;
    const extra = {
      anchor: dispatchInfo?.anchor ?? defaultAnchor,
      role: dispatchInfo?.role ?? defaultRole,
      reason: dispatchInfo?.reason ?? null,
      preview: dispatchInfo?.preview ?? null,
    };

    matchedEntryKeys.forEach((entryKey) => updateDryRunEntryStatus(group, entryKey, statusValue, extra));
  }

  contentHolder.value = normalizeWorldbookContent(contentHolder.value);
  mergedAssistantMessage.content = contentHolder.value;

  return result;
}