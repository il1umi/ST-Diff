/**
 * @file 负责在 clewd 合并前后插入/移除世界书目标标记，并辅助 Dry-Run 日志收集。
 */
import {
  worldbookState,
  registerDryRunDepthSummary,
  collectGroupMatchedEntries,
  warnWorldbookIssue,
  debugWorldbookLog,
  summarizeTextForDiagnostics,
} from './state.js';
import { generateSentinelPrefix } from './normalize.js';
import { WORLD_BOOK_ANCHORS } from '../../state/defaults.js';

/**
 * 在合并前为命中的世界书条目插入首尾目标标记，以便后续搬运。
 * @param {object} config
 * @param {Array} blockToMerge
 */
/**
 * 为世界书命中的消息段插入首尾目标标记，便于后续搬运。
 *
 * @param {object} config 运行期配置
 * @param {Array<object>} blockToMerge 即将合并的消息块
 */
export function injectWorldbookSentinels(config, blockToMerge) {
  const groups = config?.worldbook?.groups;
  const snapshot = config?.worldbook?.snapshot;
  if (!Array.isArray(groups) || !groups.length || !snapshot?.entriesByDepth || !Array.isArray(blockToMerge)) {
    return;
  }

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;

    if (!group.sentinel || typeof group.sentinel !== 'object') {
      group.sentinel = { prefix: generateSentinelPrefix(0), opened: false, moved: false };
    }

    const prefix = group.sentinel.prefix || generateSentinelPrefix(0);
    group.sentinel.prefix = prefix;
    group.sentinel.opened = !!group.sentinel.opened;
    group.sentinel.moved = !!group.sentinel.moved;

    if (group.sentinel.moved) {
      warnWorldbookIssue('worldbook group already dispatched, skipping sentinel injection', {
        group: group.id,
      });
      continue;
    }

    if (!(group.matches instanceof Map)) {
      group.matches = new Map();
    } else {
      group.matches.clear();
    }

    const beginMarker = `${prefix}BEGIN`;
    const endMarker = `${prefix}END`;
    const depthEntries = Object.entries(snapshot.entriesByDepth || {});
    const whitelistDepths = group.whitelistDepths || new Set();
    const whitelistTitles = group.whitelistTitles || new Set();
    const matchesSummary = [];

    for (const [depthKey, entries] of depthEntries) {
      const depth = Number(depthKey);
      if (!Number.isFinite(depth)) continue;
      if (whitelistDepths.has(depth)) {
        debugWorldbookLog('depth excluded by whitelist', { group: group.id, depth });
        continue;
      }
      if (typeof group.depthMatcher === 'function' && !group.depthMatcher(depth)) {
        continue;
      }

      const filteredEntries = (entries || []).filter((entry) => {
        if (!entry || !entry.content) return false;
        const title = (entry.comment || '').trim().toLowerCase();
        if (title && whitelistTitles.has(title)) {
          debugWorldbookLog('entry excluded by whitelist title', { group: group.id, depth, uid: entry.uid, title });
          return false;
        }
        return true;
      });

      if (!filteredEntries.length) continue;

      const matchesForDepth = [];

      for (const entry of filteredEntries) {
        const entryCandidates = getEntryTextCandidates(entry);
        if (!entryCandidates.length) {
          debugWorldbookLog('worldbook entry has no text candidates', {
            group: group.id,
            depth,
            uid: entry.uid,
          });
          continue;
        }

        let matchedRecord = null;

        for (const candidate of entryCandidates) {
          const candidateText = typeof candidate.text === 'string' ? candidate.text : '';
          if (!candidateText.trim()) continue;
          const variants = buildCandidateTextVariants(candidateText);
          const variantList = variants.length ? variants : [candidateText.trim()];

          for (let messageIndex = 0; messageIndex < blockToMerge.length; messageIndex++) {
            const message = blockToMerge[messageIndex];
            if (!message?.content || typeof message.content !== 'string') continue;
            const matchResult = findCandidateMatchInMessage(message.content, variantList);
            if (!matchResult) continue;

            const entryKey = group.makeDryRunEntryKey
              ? group.makeDryRunEntryKey(entry, depth, entry?.order ?? null, messageIndex)
              : null;

            matchedRecord = {
              entry,
              entryKey,
              depth,
              messageIndex,
              offset: matchResult.offset,
              matchedText: matchResult.matchedSnippet ?? candidateText,
              beginNeedle: matchResult.beginNeedle ?? matchResult.matchedSnippet ?? candidateText,
              endNeedle: matchResult.endNeedle ?? matchResult.matchedSnippet ?? candidateText,
              source: candidate.source,
            };
            break;
          }
          if (matchedRecord) break;
        }

        if (matchedRecord) {
          matchesForDepth.push(matchedRecord);
        } else {
          warnWorldbookIssue('worldbook entry not found for sentinel injection', {
            group: group.id,
            depth,
            uid: entry.uid,
            candidates: entryCandidates.map((candidate) => ({
              source: candidate.source,
              preview: summarizeTextForDiagnostics(candidate.text, 60),
            })),
          });
        }
      }

      if (!matchesForDepth.length) continue;

      if (matchesForDepth.length !== filteredEntries.length) {
        debugWorldbookLog('skip sentinel insertion due to partial coverage', {
          group: group.id,
          depth,
          expected: filteredEntries.length,
          matched: matchesForDepth.length,
        });
        continue;
      }

      matchesForDepth.sort((a, b) => {
        if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
        return a.offset - b.offset;
      });

      const firstMatch = matchesForDepth[0];
      const lastMatch = matchesForDepth[matchesForDepth.length - 1];

      const firstMessage = blockToMerge[firstMatch.messageIndex];
      const lastMessage = blockToMerge[lastMatch.messageIndex];

      const originalFirstContent = firstMessage.content;
      const originalLastContent = lastMessage.content;
      const beginNeedle = firstMatch.beginNeedle ?? firstMatch.matchedText ?? firstMatch.entry.content ?? '';
      const endNeedle = lastMatch.endNeedle ?? lastMatch.matchedText ?? lastMatch.entry.content ?? '';

      const updatedFirst = insertBeforeFirstOccurrence(originalFirstContent, beginNeedle, beginMarker);

      if (updatedFirst === originalFirstContent) {
        warnWorldbookIssue('failed to insert worldbook begin sentinel', {
          group: group.id,
          depth,
          uid: firstMatch.entry.uid,
          messageIndex: firstMatch.messageIndex,
          preview: summarizeTextForDiagnostics(beginNeedle, 60),
        });
        continue;
      }

      firstMessage.content = updatedFirst;

      const lastBaseContent = lastMessage === firstMessage ? firstMessage.content : lastMessage.content;
      const updatedLast = insertAfterLastOccurrence(lastBaseContent, endNeedle, endMarker);

      if (updatedLast === lastBaseContent) {
        warnWorldbookIssue('failed to insert worldbook end sentinel', {
          group: group.id,
          depth,
          uid: lastMatch.entry.uid,
          messageIndex: lastMatch.messageIndex,
          preview: summarizeTextForDiagnostics(endNeedle, 60),
        });
        firstMessage.content = originalFirstContent;
        if (lastMessage !== firstMessage) {
          lastMessage.content = originalLastContent;
        }
        continue;
      }

      if (lastMessage === firstMessage) {
        firstMessage.content = updatedLast;
      } else {
        lastMessage.content = updatedLast;
      }

      group.matches.set(depth, {
        beginMarker,
        endMarker,
        entries: matchesForDepth.map((match) => ({
          entryKey: match.entryKey,
          uid: match.entry.uid,
          comment: match.entry.comment,
          depth,
          messageIndex: match.messageIndex,
          order: match.entry.order,
          offset: match.offset ?? null,
          matchedSource: match.source,
          beginNeedle: match.beginNeedle || null,
          endNeedle: match.endNeedle || null,
          matchedPreview: summarizeTextForDiagnostics(match.matchedText ?? '', 60),
        })),
      });

      matchesSummary.push({ depth, count: matchesForDepth.length });
      registerDryRunDepthSummary(group, depth, matchesForDepth);
    }

    if (matchesSummary.length) {
      group.sentinel = group.sentinel || {};
      group.sentinel.opened = true;
      group.sentinel.moved = false;
      debugWorldbookLog('sentinel markers injected', { group: group.id, matches: matchesSummary });
    }
  }
}

/**
 * 将世界书匹配到的文本候选集合出来，包含随机宏的展开。
 */
function getEntryTextCandidates(entry) {
  const result = [];
  const seen = new Set();

  const pushCandidate = (text, source) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push({ text, source });
  };

  pushCandidate(entry?.promptContent, 'prompt');
  pushCandidate(entry?.content, 'content');
  pushCandidate(entry?.rawContent, 'raw');
  if (entry?.source && typeof entry.source.content === 'string') {
    pushCandidate(entry.source.content, 'source');
  }

  const randomSource =
    typeof entry?.rawContent === 'string' && entry.rawContent.includes('{{random')
      ? entry.rawContent
      : typeof entry?.source?.content === 'string' && entry.source.content.includes('{{random')
        ? entry.source.content
        : null;

  if (randomSource) {
    const variants = expandRandomMacroVariants(randomSource, 64);
    for (const variant of variants) {
      pushCandidate(variant, 'randomVariant');
    }
  }

  return result;
}

function expandRandomMacroVariants(rawText, maxVariants = 64) {
  if (typeof rawText !== 'string' || rawText.indexOf('{{random') === -1) {
    return [];
  }

  const MAX_DEPTH = 16;
  const VARIANT_LIMIT = Math.max(1, maxVariants);
  const placeholderToken = '\u{FFFC}';
  const unique = new Set();

  const splitRandomOptions = (body) => {
    if (typeof body !== 'string') return [''];
    const usesDoubleColon = body.includes('::');
    let parts;
    if (usesDoubleColon) {
      parts = body.split('::');
    } else {
      const placeholderEscaped = body.replace(/\\,/g, placeholderToken);
      parts = placeholderEscaped
        .split(',')
        .map((part) => part.replace(new RegExp(placeholderToken, 'g'), ','));
    }
    return parts.map((part) => part.trim()).filter(Boolean);
  };

  const expand = (text, depth = 0) => {
    if (unique.size >= VARIANT_LIMIT) {
      return;
    }
    if (depth > MAX_DEPTH) {
      unique.add(text);
      return;
    }

    const pattern = /{{random\s*::?([^}]+)}}/i;
    const match = pattern.exec(text);
    if (!match) {
      unique.add(text);
      return;
    }

    const [fullMatch, body] = match;
    const options = splitRandomOptions(body);
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(match.index + fullMatch.length);

    const effectiveOptions = options.length ? options : [''];
    for (const option of effectiveOptions) {
      if (unique.size >= VARIANT_LIMIT) {
        break;
      }
      expand(prefix + option + suffix, depth + 1);
    }
  };

  expand(rawText);
  return Array.from(unique.values());
}

function buildCandidateTextVariants(baseText) {
  const variants = [];
  const seen = new Set();

  const push = (value) => {
    const trimmed = (value || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    variants.push(trimmed);
  };

  const normalized = (baseText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  push(normalized);
  push(normalized.replace(/<\/?framework>/gi, ''));
  push(normalized.replace(/<\/?[^>]+>/g, ''));

  return variants;
}

function findCandidateMatchInMessage(content, variants) {
  if (typeof content !== 'string' || !content) return null;

  for (const variant of variants) {
    if (!variant) continue;
    const index = content.indexOf(variant);
    if (index !== -1) {
      return {
        offset: index,
        beginNeedle: variant,
        endNeedle: variant,
        matchedSnippet: variant,
      };
    }
  }

  for (const variant of variants) {
    if (!variant) continue;
    const lines = variant
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) continue;

    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];

    const startIdx = content.indexOf(firstLine);
    if (startIdx === -1) continue;

    const endIdxStart = content.lastIndexOf(lastLine);
    if (endIdxStart === -1) continue;

    const endIdx = endIdxStart + lastLine.length;
    if (endIdx <= startIdx) continue;

    return {
      offset: startIdx,
      beginNeedle: firstLine,
      endNeedle: lastLine,
      matchedSnippet: variant,
    };
  }

  return null;
}

function insertBeforeFirstOccurrence(haystack, needle, insertText) {
  if (!haystack || !needle || typeof haystack !== 'string') return haystack;
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return `${haystack.slice(0, index)}${insertText}${haystack.slice(index)}`;
}

function insertAfterLastOccurrence(haystack, needle, insertText) {
  if (!haystack || !needle || typeof haystack !== 'string') return haystack;
  const index = haystack.lastIndexOf(needle);
  if (index === -1) return haystack;
  const offset = index + needle.length;
  return `${haystack.slice(0, offset)}${insertText}${haystack.slice(offset)}`;
}

/**
 * 捕获上下文预览，供 Dry-Run 报告使用。
 */
/**
 * 生成包含目标片段前后上下文的预览字符串，供 Dry-Run 日志使用。
 *
 * @param {string} containerText 合并后的完整文本
 * @param {string} segmentText 目标段落
 * @param {{ before?: number, after?: number }} [options] 上下文字符范围
 * @returns {string|null} 带标记的预览文本
 */
export function captureContextPreview(containerText, segmentText, { before = 60, after = 60 } = {}) {
  if (typeof containerText !== 'string' || typeof segmentText !== 'string') {
    return null;
  }
  const target = segmentText.trim();
  if (!target) {
    return null;
  }

  const normalizedContainer = containerText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normalizedTarget = target.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let index = normalizedContainer.indexOf(normalizedTarget);
  if (index === -1) {
    const firstLine = normalizedTarget.split('\n').map((line) => line.trim()).find(Boolean);
    if (firstLine) {
      index = normalizedContainer.indexOf(firstLine);
      if (index !== -1) {
        const start = Math.max(0, index - before);
        const end = Math.min(normalizedContainer.length, index + firstLine.length + after);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < normalizedContainer.length ? '…' : '';
        return `${prefix}${normalizedContainer.slice(start, index)}[<<${normalizedContainer.slice(
          index,
          index + firstLine.length,
        )}>>]${normalizedContainer.slice(index + firstLine.length, end)}${suffix}`;
      }
    }
    return summarizeTextForDiagnostics(normalizedContainer, before + after);
  }

  const start = Math.max(0, index - before);
  const end = Math.min(normalizedContainer.length, index + normalizedTarget.length + after);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalizedContainer.length ? '…' : '';
  const beforeText = normalizedContainer.slice(start, index);
  const targetText = normalizedContainer.slice(index, index + normalizedTarget.length);
  const afterText = normalizedContainer.slice(index + normalizedTarget.length, end);
  return `${prefix}${beforeText}[<<${targetText}>>]${afterText}${suffix}`;
}

/**
 * 从配置中取出 makeDryRunEntryKey，如果不存在则回退到 state 提供的实现。
 * 主要用于在 injectWorldbookSentinels 中轻松接入 Dry-Run。
 */
/**
 * 为运行期策略组补充 Dry-Run 所需的辅助方法（如 entry key 生成）。
 *
 * @param {object} config 运行期配置
 */
export function attachDryRunHelpers(config) {
  const groups = config?.worldbook?.groups;
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    if (!group) continue;
    if (typeof group.makeDryRunEntryKey !== 'function') {
      group.makeDryRunEntryKey = worldbookState.makeDryRunEntryKey;
    }
  }
}