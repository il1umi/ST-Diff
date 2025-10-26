/**
 * noass 模块核心：负责:
 * 对聊天消息执行 clewd 风格的合并、正则替换与可配置的数据捕获。
 * 模块通过 `mount`/`unmount` 与酒馆对接。
 */
const EXT_KEY = 'st-diff';
const SECTION_SELECTOR = '#stdiff-noass';
const DEFAULT_TEMPLATE_NAME = '配置1';
const NO_TRANS_TAG = '<|no-trans|>';

const WORLD_BOOK_GROUP_MODES = Object.freeze({
  RANGE: 'depthRange',
  GTE: 'depthGE',
});

const WORLD_BOOK_ANCHORS = Object.freeze({
  BEFORE: 'before',
  AFTER: 'after',
  HEADER: 'header',
  MEMORY: 'memory',
  CUSTOM: 'custom',
});

const WORLD_BOOK_SENTINEL_PREFIX = '__STDIFF_WB_G';
const WORLD_BOOK_DEFAULT_ROLE = 'system';

const WORLD_INFO_POSITION = Object.freeze({
  BEFORE: 0,
  AFTER: 1,
  AN_TOP: 2,
  AN_BOTTOM: 3,
  AT_DEPTH: 4,
  EM_TOP: 5,
  EM_BOTTOM: 6,
});

const WORLD_BOOK_DEPTH_PRESETS = Array.from({ length: 10 }, (_, i) => i);

const regexEscape = (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const worldbookState = {
  entries: [],
  entriesById: new Map(),
  entriesByDepth: new Map(),
  listeners: [],
  uiSubscribers: new Set(),
  lastUpdated: 0,
  initialized: false,
  debug: false,
  regexHelpers: null,
};

const DRY_RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  SUCCESS: 'success',
  FALLBACK: 'fallback',
  FAILED: 'failed',
});

function makeDryRunEntryKey(entry, depth, order, messageIndex) {
  if (entry?.uid !== undefined && entry?.uid !== null) {
    return String(entry.uid);
  }
  const depthPart = Number.isFinite(depth) ? depth : 'na';
  const orderPart = Number.isFinite(order) ? order : 'na';
  const messagePart = Number.isInteger(messageIndex) ? messageIndex : 'na';
  return `depth${depthPart}-order${orderPart}-msg${messagePart}`;
}

function updateDryRunEntryStatus(group, entryKey, status, extra = {}) {
  if (!isDryRunActive()) return;
  const report = ensureDryRunGroupReport(group);
  if (!report || !entryKey) return;

  const idx = report.entryIndexByUid?.[entryKey];
  if (typeof idx === 'undefined') {
    return;
  }

  const record = report.entries?.[idx];
  if (!record) return;

  if (status && DRY_RUN_STATUS[status.toUpperCase?.()] !== undefined) {
    record.status = status;
  }

  if (typeof extra.anchor !== 'undefined') {
    record.targetAnchor = extra.anchor;
  }
  if (typeof extra.role !== 'undefined') {
    record.targetRole = extra.role;
  }
  if (typeof extra.reason !== 'undefined') {
    record.reason = extra.reason || null;
  }
  if (typeof extra.preview !== 'undefined') {
    record.preview = extra.preview || null;
  }

  if (Array.isArray(report.failures)) {
    const failureIndex = report.failures.indexOf(record);
    const shouldTrackFailure =
      status === DRY_RUN_STATUS.FAILED || status === DRY_RUN_STATUS.FALLBACK;
    if (shouldTrackFailure && failureIndex === -1) {
      report.failures.push(record);
    } else if (!shouldTrackFailure && failureIndex !== -1) {
      report.failures.splice(failureIndex, 1);
    }
  }
}

function collectGroupMatchedEntries(group) {
  if (!group?.matches || !(group.matches instanceof Map)) {
    return [];
  }
  const keys = [];
  for (const [, matchInfo] of group.matches.entries()) {
    if (!matchInfo || !Array.isArray(matchInfo.entries)) continue;
    for (const entry of matchInfo.entries) {
      const entryKey = entry?.entryKey;
      if (entryKey && !keys.includes(entryKey)) {
        keys.push(entryKey);
      }
    }
  }
  return keys;
}

let regexHelpersPromise = null;

async function ensureRegexHelpers(ctx) {
  if (worldbookState.regexHelpers) {
    return worldbookState.regexHelpers;
  }
  if (!regexHelpersPromise) {
    regexHelpersPromise = (async () => {
      try {
        const module = await import('../../../../regex/engine.js');
        if (module?.getRegexedString && module?.regex_placement) {
          return {
            getRegexedString: module.getRegexedString,
            regex_placement: module.regex_placement,
          };
        }
      } catch (error) {
        console.warn('[ST-Diff][noass] regex 引擎加载失败', error);
      }
      return null;
    })();
  }
  const helpers = await regexHelpersPromise;
  regexHelpersPromise = null;
  if (helpers) {
    worldbookState.regexHelpers = helpers;
  }
  return worldbookState.regexHelpers;
}

function computeWorldbookPromptContent(rawContent, depth) {
  const helpers = worldbookState.regexHelpers;
  if (!helpers?.getRegexedString || typeof rawContent !== 'string') {
    return rawContent ?? '';
  }
  try {
    return helpers.getRegexedString(rawContent, helpers.regex_placement.WORLD_INFO, {
      depth,
      isPrompt: true,
    });
  } catch (error) {
    console.warn('[ST-Diff][noass] regex 展开失败', { depth, error });
    return rawContent;
  }
}

function summarizeTextForDiagnostics(text, length = 80) {
  if (typeof text !== 'string') {
    return '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}

function captureContextPreview(containerText, segmentText, { before = 60, after = 60 } = {}) {
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
    // 若未找到完整匹配，尝试忽略首尾空白或仅使用首行
    const firstLine = normalizedTarget.split('\n').map(line => line.trim()).find(Boolean);
    if (firstLine) {
      index = normalizedContainer.indexOf(firstLine);
      if (index !== -1) {
        const start = Math.max(0, index - before);
        const end = Math.min(normalizedContainer.length, index + firstLine.length + after);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < normalizedContainer.length ? '…' : '';
        return `${prefix}${normalizedContainer.slice(start, index)}[<<${normalizedContainer.slice(index, index + firstLine.length)}>>]${normalizedContainer.slice(index + firstLine.length, end)}${suffix}`;
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
      parts = placeholderEscaped.split(',').map((part) => part.replace(new RegExp(placeholderToken, 'g'), ','));
    }
    return parts.map(part => part.trim()).filter(Boolean);
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

let runtimeCtx = null;
let currentNoassState = null;
let worldbookLogAdapter = { append: null, reset: null };

let worldbookDryRunWarnings = null;
let worldbookDryRunContext = null;

function isDryRunActive() {
  return !!worldbookDryRunContext;
}

/**
 * 初始化干跑上下文：
 * - worldbookDryRunWarnings：记录本轮遇到的告警，供日志/调试使用。
 * - worldbookDryRunContext.groups：以策略组 id 为 key 的报告 Map，后续累积每组的命中情况。
 */
function createDryRunContext() {
  worldbookDryRunWarnings = [];
  worldbookDryRunContext = {
    startedAt: Date.now(),
    groups: new Map(),
  };
}

/**
 * 收尾干跑流程，返回 { context, warnings }，并清理全局缓存状态。
 * 这样既能让调用方渲染报告，又可以不会污染真实请求的运行时。
 */
function finalizeDryRunContext() {
  const context = worldbookDryRunContext;
  const warnings = Array.isArray(worldbookDryRunWarnings) ? [...worldbookDryRunWarnings] : [];
  worldbookDryRunContext = null;
  worldbookDryRunWarnings = null;
  return { context, warnings };
}

/**
 * Dry Run 主流程：
 * 1. 复用最近一次 completion 快照，克隆模板与消息列表。
 * 2. 调用与真实流程一致的合并/搬运逻辑，采集各策略组的命中与派发摘要。
 * 3. 将结构化结果写入 worldbookLogAdapter，避免破坏真实上下文。
 */
async function runWorldbookDryRun(ctx) {
  if (!worldbookLogAdapter || typeof worldbookLogAdapter.reset !== 'function') {
    console.warn('[ST-Diff][noass] Dry Run log adapter not ready');
    return;
  }

  worldbookLogAdapter.reset();
  worldbookLogAdapter.append('Dry Run 开始', { timestamp: new Date().toISOString() }, { force: true });

  if (!lastCompletionSnapshot || !Array.isArray(lastCompletionSnapshot.messages)) {
    worldbookLogAdapter.append('Dry Run 失败：暂无可用对话快照', null, { force: true });
    try {
      (ctx?.toastr || window.toastr || { warning: () => {} }).warning?.('暂无可用上下文，请先发送一轮消息。');
    } catch {}
    return;
  }

  const snapshot = lastCompletionSnapshot;
  const templateClone = ensureTemplateDefaults(cloneTemplate(snapshot.template || defaultTemplate));
  const config = buildRuntimeConfig(templateClone);
  const messagesClone = cloneMessageArray(snapshot.messages || []);
  const finalMessages = [];
  let currentMergeBlock = [];
  let storedChanged = false;

  // 与实时流程一致：将当前累积的消息块交给 processAndAddMergeBlock，
  // 以便在干跑中模拟 clewd 合并、目标标记搬运等后续逻辑。
  const flushMergeBlock = () => {
    if (!currentMergeBlock.length) return;
    storedChanged = processAndAddMergeBlock(templateClone, config, currentMergeBlock, finalMessages) || storedChanged;
    currentMergeBlock = [];
  };

  // 日志预览使用的文本截断工具，保证干跑输出可读性。
  const summarizeText = (text, length = 160) => {
    if (typeof text !== 'string') return '';
    return text.length > length ? `${text.slice(0, length)}…` : text;
  };

  // dryRunResult 保存 finalizeDryRunContext 的报告；runError 用于捕获执行异常。
  let dryRunResult = null;
  let runError = null;

  try {
    createDryRunContext();

    // 与实时流程保持一致：遇到 NO_TRANS_TAG 时 flush 当前块，再最小化处理保留消息。
    for (const message of messagesClone) {
      if (message?.content && message.content.indexOf(NO_TRANS_TAG) !== -1) {
        flushMergeBlock();

        const messageWithoutTag = {
          role: message.role,
          content: message.content.replace(NO_TRANS_TAG, '').trim(),
        };
        if (message.name) {
          messageWithoutTag.name = message.name;
        }

        if (messageWithoutTag.content) {
          processPreservedSystemMessage(config, templateClone, messageWithoutTag, finalMessages);
        }
      } else {
        currentMergeBlock.push(message);
      }
    }

    flushMergeBlock();
    dryRunResult = finalizeDryRunContext();
  } catch (error) {
    runError = error;
    if (isDryRunActive()) {
      dryRunResult = finalizeDryRunContext();
    }
    console.error('[ST-Diff][noass] Dry Run 执行失败', error);
    try {
      if (worldbookLogAdapter?.append) {
        worldbookLogAdapter.append(
          'Dry Run 异常',
          {
            message: error?.message || String(error),
            stack: error?.stack || null,
          },
          { force: true }
        );
      }
    } catch (logError) {
      console.warn('[ST-Diff][noass] Dry Run 错误日志写入失败', logError);
    }
  }

  const warnings = Array.isArray(dryRunResult?.warnings) ? dryRunResult.warnings : [];
  const groupReports =
    dryRunResult?.context?.groups instanceof Map ? Array.from(dryRunResult.context.groups.values()) : [];

  if (runError) {
    worldbookLogAdapter.append(
      'Dry Run 失败',
      { error: runError?.message || String(runError), warnings: warnings.length },
      { force: true }
    );
    try {
      (ctx?.toastr || window.toastr || { error: () => {} }).error?.('Dry Run 执行失败，请查看控制台日志。');
    } catch {}
    return;
  }

  worldbookLogAdapter.append(
    'Dry Run 完成',
    {
      groups: groupReports.length,
      warnings: warnings.length,
      storedChanged: storedChanged === true,
    },
    { force: true }
  );

  if (!groupReports.length) {
    worldbookLogAdapter.append('未命中任何启用的世界书条目', null, { force: true });
  } else {
    groupReports.forEach(report => {
      const depths = (report.depths || []).map(item => ({ depth: item.depth, count: item.count }));
      const dispatchSummary = {};
      Object.entries(report.dispatch || {}).forEach(([anchor, payloads]) => {
        if (Array.isArray(payloads) && payloads.length) {
          dispatchSummary[anchor] = {
            count: payloads.length,
            samples: payloads.slice(0, 2).map(payload =>
              typeof payload === 'string'
                ? summarizeText(payload)
                : `${payload.role || 'unknown'}: ${summarizeText(payload.content || '')}`
            ),
          };
        }
      });

      const entrySummaries = (report.entries || []).map(entry => {
        const previewSnippet = entry.preview?.snippet
          ? summarizeText(entry.preview.snippet)
          : null;
        return {
          key: entry.key || null,
          uid: entry.uid,
          comment: entry.comment,
          depth: entry.depth,
          order: entry.order,
          target: entry.targetAnchor,
          role: entry.targetRole,
          status: entry.status || 'pending',
          reason: entry.reason || null,
          preview: entry.preview
            ? {
                location: entry.preview.location || entry.targetAnchor,
                snippet: previewSnippet,
              }
            : null,
        };
      });

      worldbookLogAdapter.append(
        `组 ${report.label || report.id}`,
        {
          target: report.target,
          depths,
          entries: entrySummaries,
          segmentsPreview: (report.segments || []).slice(0, 3).map(segment => summarizeText(segment)),
          dispatch: dispatchSummary,
        },
        { force: true }
      );
    });
  }

  if (warnings.length) {
    warnings.forEach((warning, index) => {
      worldbookLogAdapter.append(
        `警告 ${index + 1}`,
        { message: warning?.message, context: warning?.context || null },
        { force: true }
      );
    });
  }

  if (finalMessages.length) {
    const preview = finalMessages.map((message, index) => ({
      index,
      role: message?.role,
      preview: summarizeText(message?.content || ''),
    }));
    worldbookLogAdapter.append('合并结果预览', { messages: preview }, { force: true });
  }

  try {
    (ctx?.toastr || window.toastr || { success: () => {} }).success?.('Dry Run 完成，请查看日志。');
  } catch {}
}

function cloneDryRunMessage(message) {
  if (!message || typeof message !== 'object') return { role: '', content: '' };
  const cloned = {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
  };
  if (typeof message.name === 'string') {
    cloned.name = message.name;
  }
  if (message.meta && typeof message.meta === 'object') {
    try {
      cloned.meta = JSON.parse(JSON.stringify(message.meta));
    } catch {
      cloned.meta = { ...message.meta };
    }
  }
  return cloned;
}

function cloneMessageArray(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(cloneDryRunMessage);
}

function ensureDryRunGroupReport(group) {
  if (!worldbookDryRunContext || !group) return null;
  const reportMap = worldbookDryRunContext.groups;
  const key = group.id || group.sentinel?.prefix || `group-${reportMap.size}`;
  if (!reportMap.has(key)) {
    reportMap.set(key, {
      id: group.id || key,
      label: group.label || group.id || key,
      target: { ...(group.target || {}) },
      whitelist: {
        excludeDepths: Array.from(group.whitelistDepths || []),
        excludeTitles: Array.from(group.whitelistTitles || []),
      },
      depths: [],
      entries: [],
      entryIndexByUid: Object.create(null),
      segments: [],
      failures: [],
      dispatch: {
        before: [],
        after: [],
        header: [],
        memory: [],
        custom: [],
        fallback: [],
      },
    });
  }
  return reportMap.get(key);
}

function registerDryRunDepthSummary(group, depth, entries) {
  const report = ensureDryRunGroupReport(group);
  if (!report) return;

  const targetAnchor = group?.target?.anchor || WORLD_BOOK_ANCHORS.AFTER;
  const targetRole = group?.target?.role || WORLD_BOOK_DEFAULT_ROLE;

  const summaryEntries = entries.map(item => {
    const entryKey =
      item.entryKey ||
      makeDryRunEntryKey(
        item.entry,
        depth,
        item.entry?.order ?? null,
        item.messageIndex
      );

    const preview = {
      location: item.source || targetAnchor,
      beginNeedle: item.beginNeedle ? summarizeTextForDiagnostics(item.beginNeedle, 80) : null,
      endNeedle: item.endNeedle ? summarizeTextForDiagnostics(item.endNeedle, 80) : null,
      snippet: summarizeTextForDiagnostics(item.matchedText ?? '', 80),
    };

    if (!Object.prototype.hasOwnProperty.call(report.entryIndexByUid, entryKey)) {
      report.entryIndexByUid[entryKey] = report.entries.length;
      report.entries.push({
        key: entryKey,
        uid: item.entry?.uid ?? null,
        comment: item.entry?.comment ?? '',
        depth,
        order: item.entry?.order ?? null,
        targetAnchor,
        targetRole,
        status: DRY_RUN_STATUS.PENDING,
        reason: null,
        preview,
      });
    } else {
      const existingIndex = report.entryIndexByUid[entryKey];
      if (typeof existingIndex === 'number' && report.entries[existingIndex]) {
        report.entries[existingIndex].preview = preview;
      }
    }

    return {
      key: entryKey,
      uid: item.entry?.uid,
      comment: item.entry?.comment,
      depth,
      messageIndex: item.messageIndex,
      order: item.entry?.order,
      matchedSource: item.source || null,
      matchedPreview: preview.snippet,
      beginNeedle: item.beginNeedle || null,
      endNeedle: item.endNeedle || null,
      targetAnchor,
      targetRole,
      preview,
    };
  });

  const summary = {
    depth,
    count: entries.length,
    entries: summaryEntries,
  };
  report.depths.push(summary);
}

function appendDryRunSegments(group, segments) {
  const report = ensureDryRunGroupReport(group);
  if (!report || !segments?.length) return;
  report.segments.push(
    ...segments.map(segment => (typeof segment === 'string' ? segment : String(segment)))
  );
}

function pushDryRunDispatch(group, anchor, payload, { fallback = false } = {}) {
  if (!isDryRunActive()) return;
  const report = ensureDryRunGroupReport(group);
  if (!report) return;

  const targetKey = fallback ? 'fallback' : anchor;
  if (!report.dispatch[targetKey]) {
    report.dispatch[targetKey] = [];
  }

  if (payload && typeof payload === 'object' && 'content' in payload) {
    report.dispatch[targetKey].push(cloneDryRunMessage(payload));
  } else {
    report.dispatch[targetKey].push(typeof payload === 'string' ? payload : String(payload ?? ''));
  }
}

let lastCompletionSnapshot = null;

function generateSentinelPrefix(index = 0) {
  return `${WORLD_BOOK_SENTINEL_PREFIX}${index}__`;
}

/**
 * 世界书逻辑调试警告：
 * - 只在遇到未预期的运行时状态（如目标标记未闭合、重复搬移）时调用；
 * - 采用 console.warn 避免影响原有 clewd/noass 的普通日志的级别。
 */
function warnWorldbookIssue(message, context = {}) {
  try {
    console.warn('[ST-Diff][noass][worldbook warning]', message, context);
  } catch {}

  if (Array.isArray(worldbookDryRunWarnings)) {
    worldbookDryRunWarnings.push({ message, context });
  }
}

/**
 * 规范化单个世界书搬运组：
 * - 补齐缺少字段（深度范围、白名单、目标锚点、目标标记前缀等）；
 * - 将用户配置转换成运行期可直接处理的结构，确保旧版配置兼容。
 */
function normalizeWorldbookGroup(group, index = 0) {
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
    ? [...new Set(whitelist.excludeDepths.map(Number).filter(num => Number.isFinite(num) && num >= 0))]
    : [];
  const excludeTitles = Array.isArray(whitelist.excludeTitles)
    ? [...new Set(whitelist.excludeTitles.map(title => String(title).trim()).filter(Boolean))]
    : [];

  // 将需要排除的深度与标题整理为 Set，后续匹配时可 O(1) 判断。
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

  // target.order 默认降级为 group.order，来保证 UI/配置双层排序兼容。
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
 * 世界书调试日志：
 * - 仅在 debug_worldbook 开关启用时输出；
 * - 方便与 clewd/noass 的自有日志区分。
 */
function debugWorldbookLog(...args) {
  if (!worldbookState.debug) return;
  try {
    console.debug('[ST-Diff][noass][worldbook]', ...args);
  } catch {}
}

/**
 * 更新世界书缓存：
 * - 实时监听 WORLD_INFO_ACTIVATED 事件刷新；
 * - 在 entriesByDepth 中保留按 depth、order 排序后的条目列表，用于快速定位。
 */
function updateWorldbookCache(entries, { source = 'unknown' } = {}) {
  const list = Array.isArray(entries) ? entries.filter(item => item && typeof item === 'object') : [];
  const normalized = [];
  const byId = new Map();
  const byDepth = new Map();

  list.forEach((entry, index) => {
    const depth = Number.isFinite(entry.depth) ? Number(entry.depth) : null;
    const order = Number.isFinite(entry.order) ? Number(entry.order) : 0;
    const position = typeof entry.position === 'number' ? entry.position : null;
    const uid = typeof entry.uid !== 'undefined' ? entry.uid : `auto-${index}`;
    const comment =
      typeof entry.comment === 'string' && entry.comment.trim()
        ? entry.comment.trim()
        : Array.isArray(entry.key) && entry.key.length
          ? String(entry.key[0])
          : '';

    const rawContent = typeof entry.content === 'string' ? entry.content : '';
    const promptContent = computeWorldbookPromptContent(rawContent, depth);
    const normalizedEntry = {
      uid,
      id: `${entry.world ?? 'world'}:${uid}`,
      world: entry.world ?? '',
      comment,
      depth,
      order,
      position,
      role: entry.role,
      content: rawContent,
      rawContent,
      promptContent,
      disabled: entry.disable === true,
      source: entry,
    };

    if (rawContent && !promptContent?.trim()) {
      warnWorldbookIssue('worldbook prompt content empty after expansion', {
        uid,
        depth,
        source,
      });
    }

    normalized.push(normalizedEntry);
    byId.set(normalizedEntry.uid, normalizedEntry);

    if (
      // 仅保留 "按深度(世界书的at depth)" 触发类型且未禁用的条目，避免误处理其它世界书位置。
      normalizedEntry.disabled !== true &&
      position === WORLD_INFO_POSITION.AT_DEPTH &&
      Number.isInteger(depth)
    ) {
      const bucket = byDepth.get(depth) || [];
      bucket.push(normalizedEntry);
      byDepth.set(depth, bucket);
    }
  });

  for (const bucket of byDepth.values()) {
    bucket.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.uid).localeCompare(String(b.uid));
    });
  }

  worldbookState.entries = normalized;
  worldbookState.entriesById = byId;
  worldbookState.entriesByDepth = byDepth;
  worldbookState.lastUpdated = Date.now();

  debugWorldbookLog('cache updated', { source, count: normalized.length, depthBuckets: byDepth.size });
  notifyWorldbookSnapshotSubscribers();
}

/**
 * 挂载世界书事件监听：
 * - 自动对接酒馆的事件系统；
 * - 首次挂载时尝试使用上下文中的 lastActivatedEntries 填充缓存。
 */
async function initializeWorldbookIntegration(ctx) {
  if (!ctx?.eventSource) {
    return;
  }

  await ensureRegexHelpers(ctx);

  const eventSource = ctx.eventSource;
  const eventTypes = ctx.eventTypes || ctx.event_types || {};
  const activatedEvent = eventTypes.WORLD_INFO_ACTIVATED || 'world_info_activated';

  if (!worldbookState.listeners.some(listener => listener.event === activatedEvent)) {
    const activatedHandler = async entries => {
      await ensureRegexHelpers(ctx);
      updateWorldbookCache(entries, { source: 'WORLD_INFO_ACTIVATED' });
    };

    if (typeof eventSource.on === 'function') {
      eventSource.on(activatedEvent, activatedHandler);
    } else if (typeof eventSource.addListener === 'function') {
      eventSource.addListener(activatedEvent, activatedHandler);
    } else if (typeof eventSource.addEventListener === 'function') {
      eventSource.addEventListener(activatedEvent, activatedHandler);
    }

    worldbookState.listeners.push({ event: activatedEvent, handler: activatedHandler });
    debugWorldbookLog('listener attached', activatedEvent);
  }

  if (Array.isArray(ctx?.worldInfo?.lastActivatedEntries)) {
    updateWorldbookCache(ctx.worldInfo.lastActivatedEntries, { source: 'context.lastActivatedEntries' });
  }

  worldbookState.initialized = true;
}

/**
 * 卸载世界书事件监听，避免重复绑定导致的内存泄漏。
 */
function teardownWorldbookIntegration(ctx) {
  if (!ctx?.eventSource || !worldbookState.listeners.length) {
    worldbookState.listeners = [];
    worldbookState.initialized = false;
    return;
  }

  const eventSource = ctx.eventSource;
  const off =
    (typeof eventSource.off === 'function' && ((event, handler) => eventSource.off(event, handler))) ||
    (typeof eventSource.removeListener === 'function' && ((event, handler) => eventSource.removeListener(event, handler))) ||
    (typeof eventSource.removeEventListener === 'function' && ((event, handler) => eventSource.removeEventListener(event, handler))) ||
    null;

  for (const { event, handler } of worldbookState.listeners) {
    if (off) {
      off(event, handler);
    }
  }

  worldbookState.listeners = [];
  worldbookState.initialized = false;
  debugWorldbookLog('listeners detached');
}

/**
 * 根据模板配置构建运行时世界书组：
 * - 过滤掉未启用的组；
 * - 预编译白名单、深度匹配函数、目标标记状态及排序信息。
 */
function buildWorldbookRuntimeGroups(template) {
  if (!template || !Array.isArray(template.worldbook_groups)) {
    return [];
  }

  const runtimeGroups = [];

  template.worldbook_groups.forEach((group, index) => {
    const normalized = normalizeWorldbookGroup(group, index);
    if (!normalized || normalized.enabled === false) return;

    const whitelistTitles = normalized.whitelist.excludeTitles.map(title => title.toLowerCase());

    // 拷贝关键信息，避免直接修改模板对象导致跨请求串扰。
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
  
    // runtime.matches 用于临时记录每个深度的命中情况，方便后续日志/排错。
    runtime.matches = new Map();
  
    runtime.depthMatcher =
      runtime.mode === WORLD_BOOK_GROUP_MODES.GTE
        ? depth => Number.isFinite(depth) && depth >= runtime.depth.min
        : depth =>
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

/**
 * 封装一份世界书快照：
 * - 用于目标标记注入阶段识别当前启用条目；
 * - 通过深copy保证后续逻辑不会意外修改全局缓存。
 */
function notifyWorldbookSnapshotSubscribers() {
  if (!worldbookState.uiSubscribers.size) return;
  const snapshot = exportWorldbookSnapshot();
  for (const callback of Array.from(worldbookState.uiSubscribers)) {
    try {
      callback(snapshot);
    } catch (error) {
      console.warn('[ST-Diff][noass] 世界书快照通知失败', error);
    }
  }
}

function subscribeWorldbookSnapshot(callback) {
  if (typeof callback === 'function') {
    worldbookState.uiSubscribers.add(callback);
  }
}

function unsubscribeWorldbookSnapshot(callback) {
  if (typeof callback === 'function') {
    worldbookState.uiSubscribers.delete(callback);
  }
}

function exportWorldbookSnapshot() {
  const entries = worldbookState.entries.map(entry => ({ ...entry }));
  const entriesByDepth = {};

  worldbookState.entriesByDepth.forEach((list, depth) => {
    // list 为单一 depth 下已排序的条目数组，此处再次拷贝用于运行时隔离。
    entriesByDepth[depth] = list.map(entry => ({ ...entry }));
  });

  return {
    entries,
    entriesByDepth,
    lastUpdated: worldbookState.lastUpdated,
    initialized: worldbookState.initialized,
  };
}

const defaultWorldbookGroup = {
  enabled: true,
  label: '策略1',
  mode: WORLD_BOOK_GROUP_MODES.RANGE,
  depth: { min: 0, max: 0 },
  whitelist: { excludeDepths: [], excludeTitles: [] },
  target: { anchor: WORLD_BOOK_ANCHORS.BEFORE, customKey: '', role: WORLD_BOOK_DEFAULT_ROLE, order: 0 },
  clean_orphan_anchor: false,
  order: 0,
};

function createDefaultWorldbookGroup(index = 0) {
  const label = `策略${index + 1}`;
  return {
    ...defaultWorldbookGroup,
    label,
    target: { ...defaultWorldbookGroup.target, order: index },
    clean_orphan_anchor: false,
    order: index,
  };
}

function sanitizeWorldbookGroup(group, index = 0) {
  const base = createDefaultWorldbookGroup(index);
  if (!group || typeof group !== 'object') {
    return base;
  }

  const sanitized = { ...base, ...group };
  sanitized.enabled = group.enabled !== false;

  sanitized.label =
    typeof group.label === 'string' && group.label.trim()
      ? group.label.trim()
      : base.label;

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
    ? [...new Set(whitelist.excludeDepths.map(Number).filter(num => Number.isInteger(num) && num >= 0))]
    : [];
  const excludeTitles = Array.isArray(whitelist.excludeTitles)
    ? [...new Set(whitelist.excludeTitles.map(title => String(title).trim()).filter(Boolean))]
    : [];

  sanitized.whitelist = { excludeDepths, excludeTitles };

  const allowedAnchors = Object.values(WORLD_BOOK_ANCHORS);
  const target = group.target || {};
  const targetAnchor = allowedAnchors.includes(target.anchor) ? target.anchor : base.target.anchor;
  const targetRole =
    typeof target.role === 'string' && target.role.trim()
      ? target.role.trim()
      : WORLD_BOOK_DEFAULT_ROLE;
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

function sanitizeWorldbookGroups(tpl) {
  if (!Array.isArray(tpl.worldbook_groups)) {
    tpl.worldbook_groups = [];
  }

  tpl.worldbook_groups = tpl.worldbook_groups.map((group, index) => sanitizeWorldbookGroup(group, index));

  if (!tpl.worldbook_groups.length) {
    tpl.worldbook_groups.push(createDefaultWorldbookGroup(0));
  }

  tpl.worldbook_groups.forEach((group, index) => {
    if (group.order === defaultWorldbookGroup.order) {
      group.order = index;
    }
    if (group.target?.order === defaultWorldbookGroup.target.order) {
      group.target.order = index;
    }
  });
}
/** 默认模板：对应设置面板的全部前缀、捕获与模式配置，使用酒馆的标准设置持久化于 extensionSettings。 */
const defaultTemplate = {
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
  stored_data: {},
  worldbook_groups: [],
  debug_worldbook: false,
  single_user: false,
  inject_prefill: true,
  clean_clewd: false,
};

/** 捕获规则默认值：用于 UI 新增操作时的初始开关、模式与占位符。 */
const defaultRule = {
  enabled: true,
  regex: '',
  tag: '',
  updateMode: 'accumulate',
  range: '',
};

let completionHandler = null;
let completionEventName = null;
let refreshStoredDataView = null;
let isUpdatingUI = false;
let worldbookSnapshotCallback = null;

/**
 * 挂载入口：
 * 1. 初始化 noass 状态与模板；
 * 2. 构建 UI 绑定（若找不到contain则直接返回）；
 * 3. 注册 chatcompletion 事件用于改写消息。
 */
export async function mount(ctx) {
  runtimeCtx = ctx;
  const state = ensureState(ctx);
  if (!bindUI(ctx, state)) {
    console.warn('[ST-Diff][noass] 未找到 noass UI 容器，挂载跳过');
    return;
  }
  registerCompletionHandler(ctx, state);
  await initializeWorldbookIntegration(ctx);
}

/**
 * 卸载入口：注销已注册的 completion 事件监听，防止重复处理。
 */
export async function unmount(ctx) {
  if (runtimeCtx === ctx) {
    runtimeCtx = null;
  }
  if (currentNoassState === (ctx?.extensionSettings?.[EXT_KEY]?.noass || null)) {
    currentNoassState = null;
  }
  const eventSource = ctx?.eventSource;
  if (completionHandler && eventSource && completionEventName) {
    const off =
      eventSource.off ||
      eventSource.removeListener ||
      eventSource.removeEventListener ||
      eventSource.removeAllListeners;
    if (typeof off === 'function') {
      off.call(eventSource, completionEventName, completionHandler);
    } else if (typeof eventSource.removeListener === 'function') {
      eventSource.removeListener(completionEventName, completionHandler);
    }
  }
  completionHandler = null;
  completionEventName = null;
  refreshStoredDataView = null;
  if (worldbookSnapshotCallback) {
    unsubscribeWorldbookSnapshot(worldbookSnapshotCallback);
    worldbookSnapshotCallback = null;
  }
  teardownWorldbookIntegration(ctx);
}

/**
 * ensureState：确保 extensionSettings 内存在 noass 命名空间与默认模板。
 * - 初始化模板列表与当前激活名称；
 * - 为旧数据补齐新增字段，保障向后兼容。
 */
function ensureState(ctx) {
  const root = ctx.extensionSettings || window.extension_settings || (window.extension_settings = {});
  root[EXT_KEY] = root[EXT_KEY] || {};
  const state = root[EXT_KEY];
  state.noass = state.noass || {};
  const noass = state.noass;

  if (typeof noass.enabled === 'undefined') noass.enabled = true;
  noass.templates = noass.templates || {};
  if (!Object.keys(noass.templates).length) {
    noass.templates[DEFAULT_TEMPLATE_NAME] = cloneTemplate(defaultTemplate);
  }

  for (const name of Object.keys(noass.templates)) {
    ensureTemplateDefaults(noass.templates[name]);
  }

  if (!noass.active || !noass.templates[noass.active]) {
    noass.active = Object.keys(noass.templates)[0];
  }

  currentNoassState = noass;
  return noass;
}

/** 深copy模板并补齐默认字段，避免引用共享导致的联动修改。 */
function cloneTemplate(tpl) {
  return ensureTemplateDefaults(JSON.parse(JSON.stringify(tpl)));
}

/**
 * ensureTemplateDefaults：为模板对象补足缺省字段与安全格式，
 * 包含 capture_rules/stored_data 等嵌套结构的初始化。
 */
function ensureTemplateDefaults(tpl) {
  if (!tpl || typeof tpl !== 'object') {
    return cloneTemplate(defaultTemplate);
  }

  for (const key of Object.keys(defaultTemplate)) {
    if (typeof tpl[key] === 'undefined') {
      const def = defaultTemplate[key];
      tpl[key] = Array.isArray(def) ? def.slice() : typeof def === 'object' ? { ...def } : def;
    }
  }

  if (!Array.isArray(tpl.capture_rules)) {
    tpl.capture_rules = [];
  } else {
    tpl.capture_rules = tpl.capture_rules.map(rule => ({
      enabled: rule?.enabled !== false,
      regex: rule?.regex || '',
      tag: rule?.tag || '',
      updateMode: rule?.updateMode === 'replace' ? 'replace' : 'accumulate',
      range: rule?.range || '',
    }));
  }

  if (!tpl.stored_data || typeof tpl.stored_data !== 'object') {
    tpl.stored_data = {};
  }

  if (typeof tpl.capture_enabled === 'undefined') tpl.capture_enabled = true;
  if (typeof tpl.single_user === 'undefined') tpl.single_user = false;
  if (typeof tpl.inject_prefill === 'undefined') tpl.inject_prefill = true;
  if (typeof tpl.clean_clewd === 'undefined') tpl.clean_clewd = false;
  if (typeof tpl.debug_worldbook !== 'boolean') tpl.debug_worldbook = false;

  sanitizeWorldbookGroups(tpl);

  return tpl;
}

/** saveState：调用酒馆的节流保存方法，保证设置持久化。 */
function saveState(ctx) {
  if (!ctx) return;
  if (typeof ctx.saveSettingsDebounced === 'function') {
    ctx.saveSettingsDebounced();
  } else if (typeof ctx.saveSettings === 'function') {
    ctx.saveSettings();
  } else if (typeof window.saveSettingsDebounced === 'function') {
    window.saveSettingsDebounced();
  } else if (typeof window.saveSettings === 'function') {
    window.saveSettings();
  }
}

/**
 * bindUI：将模板与捕获配置同步到设置面板。
 * - 绑定启用开关、模板管理按钮等交互；
 * - 动态渲染捕获规则与存储数据；
 * - 任何变更都会写回 extensionSettings 并触发保存。
 */
function bindUI(ctx, state) {
  const $box = $(SECTION_SELECTOR);
  if (!$box.length) return false;

  const $enabled = $box.find('#stdiff-noass-enabled');
  const $tplSelect = $box.find('#stdiff-noass-tpl-select');
  const $tplNew = $box.find('#stdiff-noass-tpl-new');
  const $tplDup = $box.find('#stdiff-noass-tpl-dup');
  const $tplRename = $box.find('#stdiff-noass-tpl-rename');
  const $tplDelete = $box.find('#stdiff-noass-tpl-del');
  const $tplSave = $box.find('#stdiff-noass-tpl-save');
  const $tplExport = $box.find('#stdiff-noass-tpl-export');
  const $tplImport = $box.find('#stdiff-noass-tpl-import');
  const $tplImportFile = $box.find('#stdiff-noass-tpl-import-file');

  const $user = $box.find('#stdiff-noass-user');
  const $assistant = $box.find('#stdiff-noass-assistant');
  const $exampleUser = $box.find('#stdiff-noass-example-user');
  const $exampleAssistant = $box.find('#stdiff-noass-example-assistant');
  const $system = $box.find('#stdiff-noass-system');
  const $separator = $box.find('#stdiff-noass-separator');
  const $separatorSystem = $box.find('#stdiff-noass-sep-system');
  const $prefill = $box.find('#stdiff-noass-prefill');

  const $singleUser = $box.find('#stdiff-noass-single-user');
  const $cleanClewd = $box.find('#stdiff-noass-clean-clewd');
  const $injectPrefill = $box.find('#stdiff-noass-inject-prefill');
  const $worldbookBlock = $box.find('#stdiff-noass-worldbook');
  const $worldbookDebug = $box.find('#stdiff-noass-worldbook-debug');
  const $worldbookPrev = $box.find('#stdiff-noass-worldbook-prev');
  const $worldbookNext = $box.find('#stdiff-noass-worldbook-next');
  const $worldbookAdd = $box.find('#stdiff-noass-worldbook-add');
  const $worldbookDup = $box.find('#stdiff-noass-worldbook-dup');
  const $worldbookDel = $box.find('#stdiff-noass-worldbook-del');
  const $worldbookIndex = $box.find('#stdiff-noass-worldbook-index');
  const $worldbookEnabled = $box.find('#stdiff-noass-worldbook-enabled');
  const $worldbookLabel = $box.find('#stdiff-noass-worldbook-label');
  const $worldbookOrder = $box.find('#stdiff-noass-worldbook-order');
  const $worldbookSummary = $box.find('#stdiff-noass-worldbook-summary');
  const $worldbookModeRange = $box.find('#stdiff-noass-worldbook-mode-range');
  const $worldbookModeGte = $box.find('#stdiff-noass-worldbook-mode-gte');
  const $worldbookDepthMin = $box.find('#stdiff-noass-worldbook-depth-min');
  const $worldbookDepthMax = $box.find('#stdiff-noass-worldbook-depth-max');
  const $worldbookDepthChips = $box.find('#stdiff-noass-worldbook-depth-chips');
  const $worldbookDepthCustom = $box.find('#stdiff-noass-worldbook-depth-custom');
  const $worldbookDepthAdd = $box.find('#stdiff-noass-worldbook-depth-add');
  const $worldbookWhitelistSelect = $box.find('#stdiff-noass-worldbook-whitelist-select');
  const $worldbookWhitelistInput = $box.find('#stdiff-noass-worldbook-whitelist-input');
  const $worldbookWhitelistAdd = $box.find('#stdiff-noass-worldbook-whitelist-add');
  const $worldbookWhitelistClear = $box.find('#stdiff-noass-worldbook-whitelist-clear');
  const $worldbookWhitelistTags = $box.find('#stdiff-noass-worldbook-whitelist-tags');
  const $worldbookAnchor = $box.find('#stdiff-noass-worldbook-target-anchor');
  const $worldbookCustom = $box.find('#stdiff-noass-worldbook-target-custom');
  const $worldbookRole = $box.find('#stdiff-noass-worldbook-target-role');
  const $worldbookTargetOrder = $box.find('#stdiff-noass-worldbook-target-order');
  const $worldbookCleanOrphan = $box.find('#stdiff-noass-worldbook-clean-orphan');
  const $worldbookSnapshot = $box.find('#stdiff-noass-worldbook-snapshot');
  const $worldbookRefresh = $box.find('#stdiff-noass-worldbook-refresh');
  const $worldbookDryrun = $box.find('#stdiff-noass-worldbook-dryrun');
  const $worldbookLog = $box.find('#stdiff-noass-worldbook-log');

  const depthPresetValues = WORLD_BOOK_DEPTH_PRESETS;
  let latestWorldbookSnapshot = exportWorldbookSnapshot();
  let currentWorldbookIndex = 0;
  let worldbookInternalUpdate = false;
  let worldbookLogBuffer = [];
  function setWorldbookLogLines(lines = []) {
    worldbookLogBuffer = Array.isArray(lines) ? lines.slice(-40) : [];
    $worldbookLog.text(worldbookLogBuffer.join('\n'));
  }
  function appendWorldbookLog(message, data, options = {}) {
    if (!message) return;
    const { force = false, reset = false } = options;
    if (!$worldbookDebug.prop('checked') && !force) return;
    const line = data ? `${message} ${JSON.stringify(data)}` : message;
    const stamp = new Date().toLocaleTimeString();
    if (reset) {
      worldbookLogBuffer = [];
    }
    worldbookLogBuffer.push(`[${stamp}] ${line}`);
    if (worldbookLogBuffer.length > 40) worldbookLogBuffer.shift();
    $worldbookLog.text(worldbookLogBuffer.join('\n'));
  }

  worldbookLogAdapter = {
    append: (message, data, options) => {
      appendWorldbookLog(message, data, options);
      if (!$worldbookDebug.prop('checked')) {
        try {
          console.debug('[ST-Diff][noass][dryrun]', message, data || '');
        } catch {}
      }
    },
    reset: (lines = []) => {
      setWorldbookLogLines(Array.isArray(lines) ? lines : []);
    },
  };

  function getWorldbookGroups() {
    const tpl = activeTemplate();
    tpl.worldbook_groups ||= [];
    return tpl.worldbook_groups;
  }

  function ensureWorldbookGroups() {
    const groups = getWorldbookGroups();
    if (!groups.length) {
      groups.push(sanitizeWorldbookGroup(createDefaultWorldbookGroup(0), 0));
    }
    return groups;
  }

  function clampWorldbookIndex(index) {
    const groups = ensureWorldbookGroups();
    if (!groups.length) return 0;
    if (index < 0) return 0;
    if (index >= groups.length) return groups.length - 1;
    return index;
  }

  function refreshWorldbookIndexLabel() {
    const groups = ensureWorldbookGroups();
    const total = groups.length;
    const current = Math.min(currentWorldbookIndex, total ? total - 1 : 0);
    $worldbookIndex.text(total ? `${current + 1} / ${total}` : '0 / 0');
  }

  function renderWorldbookSummary(group) {
    if (!group) {
      $worldbookSummary.text('尚未创建世界书策略');
      return;
    }
    const depthInfo =
      group.mode === WORLD_BOOK_GROUP_MODES.GTE
        ? `深度 ≥ ${group.depth.min ?? 0}`
        : `深度 [${group.depth.min ?? 0}..${group.depth.max ?? group.depth.min ?? 0}]`;
    const whitelistDepths = group.whitelist?.excludeDepths?.length
      ? `排除深度: ${group.whitelist.excludeDepths.join(', ')}`
      : '排除深度: 无';
    const whitelistTitles = group.whitelist?.excludeTitles?.length
      ? `排除标题: ${group.whitelist.excludeTitles.length} 项`
      : '排除标题: 无';
    const anchor = group.target?.anchor || WORLD_BOOK_ANCHORS.AFTER;
    const role = group.target?.role || WORLD_BOOK_DEFAULT_ROLE;
    const summary = [
      depthInfo,
      whitelistDepths,
      whitelistTitles,
      `目标: ${anchor}${anchor === WORLD_BOOK_ANCHORS.CUSTOM && group.target?.customKey ? ` (${group.target.customKey})` : ''}`,
      `角色: ${role}`,
    ].join(' ｜ ');
    $worldbookSummary.text(summary);
  }

  function renderWorldbookDepthChips(group) {
    worldbookInternalUpdate = true;
    const activeDepths = new Set(group.whitelist?.excludeDepths || []);
    $worldbookDepthChips.empty();
    depthPresetValues.forEach(depth => {
      const $btn = $('<button type="button" class="stdiff-tag"></button>')
        .text(depth)
        .attr('data-depth', depth);
      if (activeDepths.has(depth)) {
        $btn.addClass('active');
      }
      $worldbookDepthChips.append($btn);
    });
    worldbookInternalUpdate = false;
  }

  function refreshWorldbookWhitelistTags(group) {
    worldbookInternalUpdate = true;
    $worldbookWhitelistTags.empty();
    const titles = group.whitelist?.excludeTitles || [];
    if (!titles.length) {
      $worldbookWhitelistTags.append('<span class="stdiff-noass-empty">暂无排除标题</span>');
      worldbookInternalUpdate = false;
      return;
    }
    titles.forEach(title => {
      const $tag = $('<span class="stdiff-tag"></span>').text(title);
      const $remove = $('<button type="button" aria-label="移除">×</button>').attr('data-title', title);
      $tag.append($remove);
      $worldbookWhitelistTags.append($tag);
    });
    worldbookInternalUpdate = false;
  }

  function refreshWorldbookWhitelistOptions() {
    const snapshot = latestWorldbookSnapshot;
    const groups = ensureWorldbookGroups();
    const currentGroup = groups[currentWorldbookIndex];
    $worldbookWhitelistSelect.empty();
    $worldbookWhitelistSelect.append('<option value="">从启用世界书条目中选择</option>');
    if (!snapshot?.entriesByDepth) return;

    const titles = new Set();
    Object.values(snapshot.entriesByDepth).forEach(entries => {
      entries.forEach(entry => {
        if (entry?.comment) {
          titles.add(entry.comment);
        }
      });
    });

    const sortedTitles = Array.from(titles).sort((a, b) => a.localeCompare(b, 'zh-Hans'));
    const excluded = new Set(currentGroup?.whitelist?.excludeTitles || []);
    sortedTitles.forEach(title => {
      const $option = $('<option></option>').attr('value', title).text(title);
      if (excluded.has(title)) {
        $option.prop('disabled', true);
      }
      $worldbookWhitelistSelect.append($option);
    });
  }

  function updateWorldbookSnapshotView() {
    const snapshot = latestWorldbookSnapshot;
    if (!snapshot?.initialized) {
      $worldbookSnapshot.text('尚未收到世界书激活事件');
      return;
    }
    const depthCount = Object.keys(snapshot.entriesByDepth || {}).length;
    const totalEntries = snapshot.entries?.length || 0;
    const timeText = snapshot.lastUpdated ? new Date(snapshot.lastUpdated).toLocaleString() : '未知时间';
    $worldbookSnapshot.text(`已缓存 ${totalEntries} 条条目，分布于 ${depthCount} 个深度。最近更新时间：${timeText}`);
  }

  function updateCustomInputState() {
    const isCustom = $worldbookAnchor.val() === WORLD_BOOK_ANCHORS.CUSTOM;
    $worldbookCustom.prop('disabled', !isCustom);
  }

  function renderWorldbookGroup() {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex] || groups[0];
    if (!group) return;

    worldbookInternalUpdate = true;
    $worldbookEnabled.prop('checked', group.enabled !== false);
    $worldbookLabel.val(group.label || `策略${currentWorldbookIndex + 1}`);
    $worldbookOrder.val(Number.isFinite(group.order) ? group.order : currentWorldbookIndex);
    $worldbookModeRange.prop('checked', group.mode !== WORLD_BOOK_GROUP_MODES.GTE);
    $worldbookModeGte.prop('checked', group.mode === WORLD_BOOK_GROUP_MODES.GTE);
    const depth = group.depth || { min: 0, max: 0 };
    $worldbookDepthMin.val(depth.min ?? 0);
    $worldbookDepthMax.val(depth.max ?? depth.min ?? 0);
    const whitelist = group.whitelist || { excludeDepths: [], excludeTitles: [] };
    whitelist.excludeDepths = Array.from(new Set((whitelist.excludeDepths || []).map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
    whitelist.excludeTitles = Array.from(new Set(whitelist.excludeTitles || [])).filter(Boolean);
    group.whitelist = whitelist;
    $worldbookAnchor.val(group.target?.anchor || WORLD_BOOK_ANCHORS.AFTER);
    $worldbookCustom.val(group.target?.customKey || '');
    $worldbookRole.val(group.target?.role || WORLD_BOOK_DEFAULT_ROLE);
    $worldbookTargetOrder.val(
      Number.isFinite(group.target?.order) ? group.target.order : currentWorldbookIndex
    );
    $worldbookCleanOrphan.prop('checked', group.clean_orphan_anchor === true);
    renderWorldbookDepthChips(group);
    refreshWorldbookWhitelistTags(group);
    refreshWorldbookWhitelistOptions();
    updateCustomInputState();
    renderWorldbookSummary(group);
    refreshWorldbookIndexLabel();
    worldbookInternalUpdate = false;
  }

  function commitWorldbookGroup() {
    if (worldbookInternalUpdate) return;
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex] || groups[0];
    if (!group) return;

    group.enabled = $worldbookEnabled.prop('checked');
    const newLabel = $worldbookLabel.val().trim();
    group.label = newLabel || `策略${currentWorldbookIndex + 1}`;

    const orderValue = parseInt($worldbookOrder.val(), 10);
    group.order = Number.isFinite(orderValue) ? orderValue : currentWorldbookIndex;

    const mode = $worldbookModeGte.prop('checked') ? WORLD_BOOK_GROUP_MODES.GTE : WORLD_BOOK_GROUP_MODES.RANGE;
    group.mode = mode;

    const minValue = parseInt($worldbookDepthMin.val(), 10);
    const maxValue = parseInt($worldbookDepthMax.val(), 10);
    const normalizedMin = Number.isFinite(minValue) ? minValue : 0;
    const normalizedMax = Number.isFinite(maxValue) ? maxValue : normalizedMin;

    group.depth =
      mode === WORLD_BOOK_GROUP_MODES.GTE
        ? { min: normalizedMin }
        : { min: normalizedMin, max: normalizedMax };

    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    group.whitelist.excludeDepths = Array.from(
      new Set((group.whitelist.excludeDepths || []).map(Number).filter(Number.isFinite))
    ).sort((a, b) => a - b);
    group.whitelist.excludeTitles = Array.from(
      new Set(group.whitelist.excludeTitles || [])
    ).filter(Boolean);

    group.target ||= { anchor: WORLD_BOOK_ANCHORS.AFTER, customKey: '', role: WORLD_BOOK_DEFAULT_ROLE, order: 0 };
    group.target.anchor = $worldbookAnchor.val() || WORLD_BOOK_ANCHORS.AFTER;
    const roleValue = ($worldbookRole.val() || '').trim();
    group.target.role = roleValue || WORLD_BOOK_DEFAULT_ROLE;
    if (group.target.anchor === WORLD_BOOK_ANCHORS.CUSTOM) {
      group.target.customKey = ($worldbookCustom.val() || '').trim();
    } else {
      group.target.customKey = '';
    }
    const targetOrder = parseInt($worldbookTargetOrder.val(), 10);
    group.target.order = Number.isFinite(targetOrder) ? targetOrder : currentWorldbookIndex;

    group.clean_orphan_anchor = $worldbookCleanOrphan.prop('checked');

    renderWorldbookSummary(group);
  }

  function commitWorldbookGroupAndSave() {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroup();
    saveDebounced();
  }

  function setWorldbookIndex(index, { commit = true, forceRender = false } = {}) {
    if (commit) {
      commitWorldbookGroup();
    }
    const groups = ensureWorldbookGroups();
    currentWorldbookIndex = clampWorldbookIndex(index);
    refreshWorldbookIndexLabel();
    if (forceRender || !worldbookInternalUpdate) {
      renderWorldbookGroup();
    }
  }

  function addWorldbookGroup() {
    const groups = ensureWorldbookGroups();
    const newIndex = groups.length;
    const newGroup = sanitizeWorldbookGroup(createDefaultWorldbookGroup(newIndex), newIndex);
    groups.push(newGroup);
    setWorldbookIndex(newIndex, { commit: true, forceRender: true });
    appendWorldbookLog('新增世界书策略组', { index: newIndex, label: newGroup.label });
    saveDebounced();
  }

  function duplicateWorldbookGroup() {
    const groups = ensureWorldbookGroups();
    const source = groups[currentWorldbookIndex];
    if (!source) return;
    commitWorldbookGroup();
    const clone = sanitizeWorldbookGroup(JSON.parse(JSON.stringify(source)), groups.length);
    clone.label = `${source.label || '策略'}-副本`;
    const insertIndex = currentWorldbookIndex + 1;
    groups.splice(insertIndex, 0, clone);
    setWorldbookIndex(insertIndex, { commit: false, forceRender: true });
    appendWorldbookLog('复制世界书策略组', { from: currentWorldbookIndex, to: insertIndex });
    saveDebounced();
  }

  function removeWorldbookGroup() {
    const groups = ensureWorldbookGroups();
    if (groups.length <= 1) {
      window.alert('至少保留一个世界书策略');
      return;
    }
    const removed = groups.splice(currentWorldbookIndex, 1);
    const nextIndex = currentWorldbookIndex >= groups.length ? groups.length - 1 : currentWorldbookIndex;
    setWorldbookIndex(nextIndex, { commit: false, forceRender: true });
    appendWorldbookLog('删除世界书策略组', { index: currentWorldbookIndex, label: removed[0]?.label });
    saveDebounced();
  }

  function toggleExcludeDepth(depth) {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex];
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    const list = new Set(group.whitelist.excludeDepths || []);
    if (list.has(depth)) {
      list.delete(depth);
    } else {
      list.add(depth);
    }
    group.whitelist.excludeDepths = Array.from(list).sort((a, b) => a - b);
    renderWorldbookDepthChips(group);
    commitWorldbookGroupAndSave();
  }

  function addExcludeDepths(values) {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex];
    if (!group || !Array.isArray(values)) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    const list = new Set(group.whitelist.excludeDepths || []);
    values.forEach(value => {
      if (Number.isInteger(value) && value >= 0) {
        list.add(value);
      }
    });
    group.whitelist.excludeDepths = Array.from(list).sort((a, b) => a - b);
    $worldbookDepthCustom.val('');
    renderWorldbookDepthChips(group);
    commitWorldbookGroupAndSave();
  }

  function addWhitelistTitle(title) {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex];
    if (!group || !title) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    const list = new Set(group.whitelist.excludeTitles || []);
    list.add(title);
    group.whitelist.excludeTitles = Array.from(list);
    refreshWorldbookWhitelistTags(group);
    refreshWorldbookWhitelistOptions();
    commitWorldbookGroupAndSave();
  }

  function removeWhitelistTitle(title) {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex];
    if (!group || !title) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    group.whitelist.excludeTitles = (group.whitelist.excludeTitles || []).filter(item => item !== title);
    refreshWorldbookWhitelistTags(group);
    refreshWorldbookWhitelistOptions();
    commitWorldbookGroupAndSave();
  }

  function clearWhitelistTitles() {
    const groups = ensureWorldbookGroups();
    const group = groups[currentWorldbookIndex];
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    if (!group.whitelist.excludeTitles.length) return;
    group.whitelist.excludeTitles = [];
    refreshWorldbookWhitelistTags(group);
    refreshWorldbookWhitelistOptions();
    commitWorldbookGroupAndSave();
  }

  function parseDepthInput(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[,，\s]+/)
      .map(value => parseInt(value, 10))
      .filter(Number.isInteger)
      .filter(value => value >= 0);
  }
  
  $worldbookDebug.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    const tpl = activeTemplate();
    tpl.debug_worldbook = $worldbookDebug.prop('checked');
    worldbookState.debug = tpl.debug_worldbook === true;
    saveDebounced();
  });
  
  $worldbookPrev.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    setWorldbookIndex(currentWorldbookIndex - 1);
  });
  
  $worldbookNext.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    setWorldbookIndex(currentWorldbookIndex + 1);
  });
  
  $worldbookAdd.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    addWorldbookGroup();
  });
  
  $worldbookDup.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    duplicateWorldbookGroup();
  });
  
  $worldbookDel.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    removeWorldbookGroup();
  });
  
  $worldbookEnabled.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookLabel.off('input.stdiffNoass').on('input.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookOrder.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookModeRange.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookModeGte.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookDepthMin.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookDepthMax.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookDepthChips.off('click.stdiffNoass').on('click.stdiffNoass', 'button', event => {
    const depth = parseInt($(event.currentTarget).attr('data-depth'), 10);
    if (!Number.isInteger(depth)) return;
    toggleExcludeDepth(depth);
  });
  
  $worldbookDepthAdd.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const values = parseDepthInput($worldbookDepthCustom.val());
    addExcludeDepths(values);
  });
  
  $worldbookWhitelistSelect.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    const value = $worldbookWhitelistSelect.val();
    if (value) {
      addWhitelistTitle(value);
      $worldbookWhitelistSelect.val('');
    }
  });
  
  $worldbookWhitelistAdd.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const value = ($worldbookWhitelistInput.val() || '').trim();
    if (!value) return;
    addWhitelistTitle(value);
    $worldbookWhitelistInput.val('');
  });
  
  $worldbookWhitelistClear.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    clearWhitelistTitles();
  });
  
  $worldbookWhitelistTags.off('click.stdiffNoass').on('click.stdiffNoass', 'button', event => {
    const title = $(event.currentTarget).attr('data-title');
    if (!title) return;
    removeWhitelistTitle(title);
  });
  
  $worldbookAnchor.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    updateCustomInputState();
    commitWorldbookGroupAndSave();
  });
  
  $worldbookCustom.off('input.stdiffNoass').on('input.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookRole.off('input.stdiffNoass').on('input.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });

  $worldbookTargetOrder.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });

  $worldbookCleanOrphan.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (worldbookInternalUpdate) return;
    commitWorldbookGroupAndSave();
  });
  
  $worldbookRefresh.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    latestWorldbookSnapshot = exportWorldbookSnapshot();
    updateWorldbookSnapshotView();
    refreshWorldbookWhitelistOptions();
    appendWorldbookLog('手动刷新世界书快照');
  });
  
  $worldbookDryrun.off('click.stdiffNoass').on('click.stdiffNoass', async () => {
    try {
      await runWorldbookDryRun(ctx);
    } catch (error) {
      appendWorldbookLog('Dry Run 触发失败', { error: error?.message || String(error) }, { force: true });
      try {
        (ctx.toastr || window.toastr || { error: () => {} }).error?.('Dry Run 执行失败，请查看控制台。');
      } catch {}
    }
  });
  
  worldbookSnapshotCallback = snapshot => {
    latestWorldbookSnapshot = snapshot;
    updateWorldbookSnapshotView();
    if (!worldbookInternalUpdate) {
      refreshWorldbookWhitelistOptions();
    }
  };
  
  subscribeWorldbookSnapshot(worldbookSnapshotCallback);
  updateWorldbookSnapshotView();
  const $captureEnabled = $box.find('#stdiff-noass-cap-enabled');

  const $rulesContainer = $box.find('#stdiff-noass-rules');
  const $addRule = $box.find('#stdiff-noass-add-rule');
  const $saveRules = $box.find('#stdiff-noass-save-rules');

  const $storageList = $box.find('#stdiff-noass-storage-list');
  const $storageRefresh = $box.find('#stdiff-noass-storage-refresh');
  const $storageClearAll = $box.find('#stdiff-noass-storage-clear');

  let activeName = state.active;
  ensureTemplateDefaults(state.templates[activeName]);

  const saveDebounced = () => saveState(ctx);

  const toggleBody = () => {
    $box.find('#stdiff-noass-body').toggle($enabled.prop('checked'));
  };

  isUpdatingUI = true;
  $enabled.prop('checked', state.enabled !== false);
  isUpdatingUI = false;
  toggleBody();

  $enabled.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (isUpdatingUI) return;
    state.enabled = $enabled.prop('checked');
    toggleBody();
    saveDebounced();
  });

  function activeTemplate() {
    ensureTemplateDefaults(state.templates[activeName]);
    return state.templates[activeName];
  }

  function refreshTemplateOptions() {
    const names = Object.keys(state.templates);
    $tplSelect.empty();
    for (const name of names) {
      $tplSelect.append($('<option></option>').attr('value', name).text(name));
    }
    isUpdatingUI = true;
    $tplSelect.val(activeName);
    isUpdatingUI = false;
  }

  function createLabeledField(label, $element) {
    return $('<label class="stdiff-noass-field"></label>').append(`<span>${label}</span>`).append($element);
  }

  /**
   * renderRules：根据当前模板的 capture_rules 渲染可编辑列表。
   * 监听输入事件以实时更新模板对象，但仅在手动保存或离开时写入。
   */
  function renderRules(rules) {
    $rulesContainer.empty();
    if (!rules.length) {
      $rulesContainer.append('<div class="stdiff-noass-empty">暂无捕获规则</div>');
      return;
    }

    rules.forEach((rule, index) => {
      const $row = $('<div class="stdiff-noass-rule-row"></div>');

      const $enabledCheckbox = $('<input type="checkbox" class="stdiff-noass-rule-enabled">')
        .prop('checked', rule.enabled !== false)
        .on('change', () => {
          rule.enabled = $enabledCheckbox.prop('checked');
          saveDebounced();
        });

      const $regex = $('<input type="text" class="text_pole stdiff-noass-rule-regex" spellcheck="false" placeholder="/pattern/flags">')
        .val(rule.regex)
        .on('input', () => {
          rule.regex = $regex.val();
        });

      const $tag = $('<input type="text" class="text_pole stdiff-noass-rule-tag" spellcheck="false" placeholder="<tag>">')
        .val(rule.tag)
        .on('input', () => {
          rule.tag = $tag.val();
        });

      const $mode = $('<select class="text_pole stdiff-noass-rule-mode"></select>')
        .append('<option value="accumulate">叠加式</option>')
        .append('<option value="replace">替换式</option>')
        .val(rule.updateMode === 'replace' ? 'replace' : 'accumulate')
        .on('change', () => {
          rule.updateMode = $mode.val();
          saveDebounced();
        });

      const $range = $('<input type="text" class="text_pole stdiff-noass-rule-range" spellcheck="false" placeholder="+1,+3~+5,-2">')
        .val(rule.range)
        .on('input', () => {
          rule.range = $range.val();
        });

      const $delete = $('<button type="button" class="menu_button stdiff-noass-rule-delete">删除</button>').on('click', () => {
        rules.splice(index, 1);
        renderRules(rules);
        saveDebounced();
      });

      const $left = $('<div class="stdiff-noass-rule-left"></div>')
        .append($('<label class="checkbox_label"></label>').append($enabledCheckbox).append(' 启用'))
        .append($delete);

      const $right = $('<div class="stdiff-noass-rule-right"></div>')
        .append(createLabeledField('正则', $regex))
        .append(createLabeledField('标记', $tag))
        .append(createLabeledField('模式', $mode))
        .append(createLabeledField('范围', $range));

      $row.append($left).append($right);
      $rulesContainer.append($row);
    });
  }

  /**
   * renderStoredData：展示已捕获的占位符内容，支持编辑、保存与清空操作。
   * 使用 refreshStoredDataView 记录刷新函数，供消息流程结束后调用。
   */
  function renderStoredData(storedData) {
    refreshStoredDataView = () => renderStoredData(activeTemplate().stored_data);
    $storageList.empty();
    const keys = Object.keys(storedData || {}).sort();
    if (!keys.length) {
      $storageList.append('<div class="stdiff-noass-empty">暂无存储数据</div>');
      return;
    }

    keys.forEach(tag => {
      const entries = Array.isArray(storedData[tag]) ? storedData[tag] : [];
      const $item = $('<div class="stdiff-noass-storage-item"></div>');
      const $title = $('<div class="stdiff-noass-storage-title"></div>').text(`标记: ${tag} (${entries.length} 条数据)`);
      const $textarea = $('<textarea class="stdiff-noass-storage-text" spellcheck="false"></textarea>').val(entries.join('\n---\n'));
      const $btnRow = $('<div class="stdiff-noass-btns"></div>');
      const $saveBtn = $('<button class="menu_button">保存编辑</button>');
      const $clearBtn = $('<button class="menu_button">清空此标记</button>');

      $saveBtn.on('click', () => {
        const newContent = $textarea.val().trim();
        if (!newContent) {
          delete storedData[tag];
        } else {
          const newArray = newContent
            .split(/\n---\n|\n-{3,}\n/)
            .map(item => item.trim())
            .filter(Boolean);
          storedData[tag] = newArray;
        }
        saveDebounced();
        renderStoredData(storedData);
      });

      $clearBtn.on('click', () => {
        if (window.confirm(`确定要清空标记「${tag}」的数据吗？`)) {
          delete storedData[tag];
          saveDebounced();
          renderStoredData(storedData);
        }
      });

      $btnRow.append($saveBtn, $clearBtn);
      $item.append($title, $textarea, $btnRow);
      $storageList.append($item);
    });
  }

  /** 将当前激活模板填充到 UI 控件，避免 change 事件被动触发。 */
  function loadTemplateToUI() {
    const tpl = activeTemplate();
    isUpdatingUI = true;
    $user.val(tpl.user);
    $assistant.val(tpl.assistant);
    $exampleUser.val(tpl.example_user);
    $exampleAssistant.val(tpl.example_assistant);
    $system.val(tpl.system);
    $separator.val(tpl.separator);
    $separatorSystem.val(tpl.separator_system);
    $prefill.val(tpl.prefill_user);
    $singleUser.prop('checked', !!tpl.single_user);
    $cleanClewd.prop('checked', !!tpl.clean_clewd);
    $injectPrefill.prop('checked', tpl.inject_prefill !== false);
    $captureEnabled.prop('checked', tpl.capture_enabled !== false);
    renderRules(tpl.capture_rules);
    renderStoredData(tpl.stored_data);
    isUpdatingUI = false;

    worldbookInternalUpdate = true;
    $worldbookDebug.prop('checked', tpl.debug_worldbook === true);
    worldbookState.debug = tpl.debug_worldbook === true;
    worldbookInternalUpdate = false;

    latestWorldbookSnapshot = exportWorldbookSnapshot();
    updateWorldbookSnapshotView();
    worldbookLogBuffer = [];
    $worldbookLog.empty();

    ensureWorldbookGroups();
    setWorldbookIndex(clampWorldbookIndex(currentWorldbookIndex), { commit: false, forceRender: true });
  }

  /** 切换激活模板并立即刷新 UI，确保 state.active 与选择器保持一致。 */
  function setActiveTemplate(name) {
    if (!state.templates[name]) return;
    activeName = name;
    state.active = name;
    refreshTemplateOptions();
    loadTemplateToUI();
    saveDebounced();
  }

  /** 工具函数：监听文本输入并同步到模板字段。 */
  function bindTextInput($input, key) {
    $input.off('input.stdiffNoass').on('input.stdiffNoass', () => {
      if (isUpdatingUI) return;
      const tpl = activeTemplate();
      tpl[key] = $input.val();
      saveDebounced();
    });
  }

  bindTextInput($user, 'user');
  bindTextInput($assistant, 'assistant');
  bindTextInput($exampleUser, 'example_user');
  bindTextInput($exampleAssistant, 'example_assistant');
  bindTextInput($system, 'system');
  bindTextInput($separator, 'separator');
  bindTextInput($separatorSystem, 'separator_system');
  bindTextInput($prefill, 'prefill_user');

  /** 工具函数：绑定布尔开关，提供默认值以兼容旧配置。 */
  function bindCheckbox($checkbox, key, defaultValue = false) {
    $checkbox.off('change.stdiffNoass').on('change.stdiffNoass', () => {
      if (isUpdatingUI) return;
      const tpl = activeTemplate();
      tpl[key] = $checkbox.prop('checked');
      saveDebounced();
    });
    if (typeof activeTemplate()[key] === 'undefined') {
      activeTemplate()[key] = defaultValue;
    }
  }

  bindCheckbox($singleUser, 'single_user', false);
  bindCheckbox($cleanClewd, 'clean_clewd', false);
  bindCheckbox($injectPrefill, 'inject_prefill', true);
  bindCheckbox($captureEnabled, 'capture_enabled', true);

  $tplSelect.off('change.stdiffNoass').on('change.stdiffNoass', () => {
    if (isUpdatingUI) return;
    const name = $tplSelect.val();
    if (name) {
      setActiveTemplate(name);
    }
  });

  $tplNew.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    let idx = Object.keys(state.templates).length + 1;
    let candidate = `配置${idx}`;
    while (state.templates[candidate]) {
      idx += 1;
      candidate = `配置${idx}`;
    }
    const input = window.prompt('请输入新模板名称', candidate);
    if (!input) return;
    if (state.templates[input]) {
      window.alert('模板名称已存在');
      return;
    }
    state.templates[input] = cloneTemplate(defaultTemplate);
    setActiveTemplate(input);
    saveDebounced();
  });

  $tplDup.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const source = activeName;
    const target = window.prompt('复制为新模板名称', `${source}-副本`);
    if (!target) return;
    if (state.templates[target]) {
      window.alert('模板名称已存在');
      return;
    }
    state.templates[target] = cloneTemplate(activeTemplate());
    setActiveTemplate(target);
    saveDebounced();
  });

  $tplRename.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const source = activeName;
    const target = window.prompt('输入新的模板名称', source);
    if (!target || target === source) return;
    if (state.templates[target]) {
      window.alert('模板名称已存在');
      return;
    }
    state.templates[target] = state.templates[source];
    delete state.templates[source];
    activeName = target;
    state.active = target;
    refreshTemplateOptions();
    loadTemplateToUI();
    saveDebounced();
  });

  $tplDelete.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    if (Object.keys(state.templates).length <= 1) {
      window.alert('至少保留一个模板');
      return;
    }
    if (!window.confirm(`确认删除模板「${activeName}」？`)) return;
    delete state.templates[activeName];
    activeName = Object.keys(state.templates)[0];
    state.active = activeName;
    refreshTemplateOptions();
    loadTemplateToUI();
    saveDebounced();
  });

  $tplSave.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    try {
      (ctx.toastr || window.toastr || { info: () => {} }).info('当前模板已保存');
    } catch {}
  });

  $tplExport.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const payload = {
      noass: {
        enabled: state.enabled !== false,
        templates: state.templates,
        active: state.active,
      },
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = state.active.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `ST-diff-noass-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  $tplImport.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    $tplImportFile.trigger('click');
  });

  $tplImportFile.off('change.stdiffNoass').on('change.stdiffNoass', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const text = ev.target?.result;
        const json = JSON.parse(text);
        if (!json || !json.noass) {
          window.alert('无效的配置文件');
          return;
        }
        const imported = json.noass;
        if (typeof imported.enabled !== 'undefined') {
          state.enabled = imported.enabled;
          $enabled.prop('checked', state.enabled !== false);
          toggleBody();
        }
        if (imported.templates && typeof imported.templates === 'object') {
          for (const [name, tpl] of Object.entries(imported.templates)) {
            state.templates[name] = ensureTemplateDefaults(tpl);
          }
        }
        if (imported.active && state.templates[imported.active]) {
          activeName = imported.active;
          state.active = imported.active;
        }
        refreshTemplateOptions();
        loadTemplateToUI();
        saveDebounced();
      } catch (err) {
        console.warn('[ST-Diff][noass] 导入配置失败', err);
        window.alert('导入失败，请检查文件内容');
      } finally {
        $tplImportFile.val('');
      }
    };
    reader.readAsText(file, 'utf-8');
  });

  $addRule.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    const tpl = activeTemplate();
    tpl.capture_rules.push({ ...defaultRule });
    renderRules(tpl.capture_rules);
    saveDebounced();
  });

  $saveRules.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    try {
      (ctx.toastr || window.toastr || { info: () => {} }).info('规则已保存');
    } catch {}
    saveDebounced();
  });

  $storageRefresh.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    renderStoredData(activeTemplate().stored_data);
  });

  $storageClearAll.off('click.stdiffNoass').on('click.stdiffNoass', () => {
    if (!window.confirm('确定要清空所有存储数据吗？')) return;
    activeTemplate().stored_data = {};
    saveDebounced();
    renderStoredData(activeTemplate().stored_data);
  });

  refreshTemplateOptions();
  loadTemplateToUI();
  return true;
}

/**
 * registerCompletionHandler：监听 CHAT_COMPLETION_SETTINGS_READY，
 * 在 OpenAI 流程生成最终请求前改写消息数组。
 */
function registerCompletionHandler(ctx, state) {
  const eventSource = ctx?.eventSource;
  if (!eventSource) return;

  const eventTypes = ctx?.eventTypes || ctx?.event_types || {};
  const eventName =
    eventTypes.CHAT_COMPLETION_SETTINGS_READY ||
    eventTypes.chat_completion_settings_ready ||
    'chat_completion_settings_ready';

  if (!eventName) return;

  completionHandler = completion => {
    try {
      handleCompletion(ctx, state, completion);
    } catch (err) {
      console.warn('[ST-Diff][noass] 处理对话时出错', err);
    }
  };

  if (typeof eventSource.on === 'function') {
    eventSource.on(eventName, completionHandler);
  } else if (typeof eventSource.addListener === 'function') {
    eventSource.addListener(eventName, completionHandler);
  } else if (typeof eventSource.addEventListener === 'function') {
    eventSource.addEventListener(eventName, completionHandler);
  } else {
    return;
  }
  completionEventName = eventName;
}

/**
 * handleCompletion：处理一次api请求。
 * - 按 <|no-trans|> 分块并执行合并；
 * - 重新插入保留消息，执行标签替换；
 * - 若捕获数据发生变化则刷新 UI。
 */
function handleCompletion(ctx, state, completion) {
  if (!state || state.enabled === false) return;
  if (!completion?.messages) return;

  const template =
    state.templates[state.active] || state.templates[Object.keys(state.templates)[0]];
  if (!template) return;

  const mainApi = ctx?.mainApi;
  if (mainApi && mainApi !== 'openai') return;

  const config = buildRuntimeConfig(template);

  const originalMessages = Array.isArray(completion.messages) ? completion.messages : [];
  lastCompletionSnapshot = {
    templateName: state.active,
    template: cloneTemplate(template),
    messages: cloneMessageArray(originalMessages),
    timestamp: Date.now(),
  };
  const finalMessages = [];
  let currentMergeBlock = [];
  let storedChanged = false;

  for (let i = 0; i < originalMessages.length; i++) {
    const message = originalMessages[i];
    if (message?.content && message.content.indexOf(NO_TRANS_TAG) !== -1) {
      storedChanged =
        processAndAddMergeBlock(template, config, currentMergeBlock, finalMessages) || storedChanged;
      currentMergeBlock = [];

      const messageWithoutTag = {
        role: message.role,
        content: message.content.replace(NO_TRANS_TAG, '').trim(),
      };
      if (message.name) messageWithoutTag.name = message.name;

      if (messageWithoutTag.content) {
        processPreservedSystemMessage(config, template, messageWithoutTag, finalMessages);
      }
    } else {
      currentMergeBlock.push(message);
    }
  }

  storedChanged =
    processAndAddMergeBlock(template, config, currentMergeBlock, finalMessages) || storedChanged;

  for (let i = 0; i < finalMessages.length; i++) {
    if (finalMessages[i]?.content) {
      const before = finalMessages[i].content;
      finalMessages[i].content = replaceTagsWithStoredData(
        finalMessages[i].content,
        template,
        config.clean_clewd
      );
      if (before !== finalMessages[i].content) {
        try {
          console.debug('[ST-Diff][noass] 标签替换发生在消息', i);
        } catch {}
      }
    }
  }

  completion.messages = finalMessages;

  if (storedChanged) {
    saveState(ctx);
    refreshStoredDataView?.();
  }
}

/** buildRuntimeConfig：将模板转换为运行时配置，避免直接修改模板原始对象。 */
function buildRuntimeConfig(template) {
  const config = JSON.parse(JSON.stringify(defaultTemplate));
  worldbookState.debug = template.debug_worldbook === true;

  const keys = [
    'user',
    'assistant',
    'example_user',
    'example_assistant',
    'system',
    'separator',
    'separator_system',
    'prefill_user',
  ];
  for (const key of keys) {
    config[key] = template[key];
  }
  config.capture_enabled = template.capture_enabled !== false;
  config.capture_rules = template.capture_rules ? template.capture_rules.map(rule => ({ ...rule })) : [];
  config.stored_data = template.stored_data || (template.stored_data = {});
  config.single_user = !!template.single_user;
  config.inject_prefill = template.inject_prefill !== false;
  config.clean_clewd = !!template.clean_clewd;
  config.worldbook = {
    groups: buildWorldbookRuntimeGroups(template),
    snapshot: exportWorldbookSnapshot(),
  };
  return config;
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
 * 在合并前对世界书条目标记目标标记：
 * 1. 遍历启用的运行时组，按白名单与深度过滤条目；
 * 2. 若命中同一深度的全部条目，则在首条与末条两端插入互不相同的唯一目标标记；
 * 3. 将命中结果写入 group.matches，供调试与后续搬移使用。
 */
function injectWorldbookSentinels(config, blockToMerge) {
  const groups = config?.worldbook?.groups;
  const snapshot = config?.worldbook?.snapshot;
  if (!Array.isArray(groups) || !groups.length || !snapshot?.entriesByDepth || !Array.isArray(blockToMerge)) {
    return;
  }

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;

    if (!group.sentinel || typeof group.sentinel !== 'object') {
      // 首次执行时需要初始化目标标记结构，确保 prefix/开关状态可用。
      group.sentinel = { prefix: generateSentinelPrefix(0), opened: false, moved: false };
    }

    const prefix = group.sentinel.prefix || generateSentinelPrefix(0);
    group.sentinel.prefix = prefix;
    group.sentinel.opened = !!group.sentinel.opened;
    group.sentinel.moved = !!group.sentinel.moved;

    if (group.sentinel.moved) {
      // 已搬移过的组说明在同一 completion 内已完成处理，此轮直接跳过。
      warnWorldbookIssue('worldbook group already dispatched, skipping sentinel injection', {
        group: group.id,
      });
      continue;
    }

    if (!(group.matches instanceof Map)) {
      // matches 记录每个 depth 的详细命中情况（messageIndex/offset），便于(日志)检查。
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

      const filteredEntries = (entries || []).filter(entry => {
        // 仅处理已启用、且未被标题白名单排除的条目。
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

            const entryKey = makeDryRunEntryKey(
              entry,
              depth,
              entry?.order ?? null,
              messageIndex
            );

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
            candidates: entryCandidates.map(candidate => ({
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
        // 按消息索引与偏移排序，确保插入目标标记时遵循原生顺序。
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

      const updatedFirst = insertBeforeFirstOccurrence(
        originalFirstContent,
        beginNeedle,
        beginMarker,
      );

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
      const updatedLast = insertAfterLastOccurrence(
        lastBaseContent,
        endNeedle,
        endMarker,
      );

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
        entries: matchesForDepth.map(match => ({
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
      // 抽取成功才标记 opened，避免未命中的组被误判为待搬移状态。
      group.sentinel = group.sentinel || {};
      group.sentinel.opened = true;
      group.sentinel.moved = false;
      debugWorldbookLog('sentinel markers injected', { group: group.id, matches: matchesSummary });
    }
  }
}
 
/**
 * 统一世界书片段换行符与空行，保证表现一致。
 */
function normalizeWorldbookFragment(fragment) {
  if (typeof fragment !== 'string') return '';
  const unified = fragment.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = unified.trim();
  return trimmed.replace(/\n{3,}/g, '\n\n');
}
 
/**
 * 对完整文本执行换行规范化，移除多余空行并应用 trim，避免 clewd 输出出现额外空白。
 */
function normalizeWorldbookContent(text) {
  if (typeof text !== 'string') return '';
  const unified = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const collapsed = unified.replace(/\n{3,}/g, '\n\n');
  return collapsed.trim();
}
 
/**
 * 将提取出的世界书段落按目标锚点写入：
 * - before/after：新增消息插入队列；
 * - header/memory：写回合并文本头尾；
 * - custom：尝试替换自定义锚点，失败则回退至 after。
 */
function applyWorldbookSegmentDispatch(group, segments, contentHolder, beforeMessages, afterMessages) {
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

  // 构建搬运后段落的简要摘要，写入 Dry Run 报告时便于快速辨别目标位置与内容
  const summarizePreview = (snippet, location = anchor) => ({
    location,
    snippet: summarizeTextForDiagnostics(snippet ?? '', 160),
  });

  // 针对 header/memory/custom 等直接写回合并文本的场景，额外截取上下文作为调试用预览
  const buildContextPreview = (location = anchor) => {
    const context = captureContextPreview(contentHolder.value, payload, { before: 80, after: 80 });
    return {
      location,
      snippet: context || summarizeTextForDiagnostics(payload, 160),
    };
  };

  const message = { role, content: payload };
  let preview = null;

  switch (anchor) {
    case WORLD_BOOK_ANCHORS.BEFORE:
      beforeMessages.push(message);
      preview = summarizePreview(message.content, WORLD_BOOK_ANCHORS.BEFORE);
      pushDryRunDispatch(group, 'before', message);
      break;
    case WORLD_BOOK_ANCHORS.AFTER:
      afterMessages.push(message);
      preview = summarizePreview(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'after', message);
      break;
    case WORLD_BOOK_ANCHORS.HEADER:
      contentHolder.value = normalizeWorldbookContent(`${payload}\n\n${contentHolder.value}`);
      preview = buildContextPreview(WORLD_BOOK_ANCHORS.HEADER);
      pushDryRunDispatch(group, 'header', payload);
      break;
    case WORLD_BOOK_ANCHORS.MEMORY:
      contentHolder.value = normalizeWorldbookContent(`${contentHolder.value}\n\n${payload}`);
      preview = buildContextPreview(WORLD_BOOK_ANCHORS.MEMORY);
      pushDryRunDispatch(group, 'memory', payload);
      break;
    case WORLD_BOOK_ANCHORS.CUSTOM: {
      const key = (group?.target?.customKey || '').trim();
      if (key) {
        const anchorIndex = contentHolder.value.indexOf(key);
        if (anchorIndex !== -1) {
          const beforeAnchor = contentHolder.value.slice(0, anchorIndex);
          const afterAnchor = contentHolder.value.slice(anchorIndex + key.length);
          contentHolder.value = `${beforeAnchor}${payload}${afterAnchor}`;
          preview = buildContextPreview(`${WORLD_BOOK_ANCHORS.CUSTOM}:${key}`);
          debugWorldbookLog('worldbook segment injected at custom anchor', { group: group?.id, key });
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
      preview = summarizePreview(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'custom', message, { fallback: true });
      debugWorldbookLog('custom anchor fallback to after', { group: group?.id, key });
      break;
    }
    default:
      afterMessages.push(message);
      preview = summarizePreview(message.content, WORLD_BOOK_ANCHORS.AFTER);
      pushDryRunDispatch(group, 'after', message);
      break;
  }

  resultInfo.preview = preview;
  // 统一记录搬运结果（锚点/角色/段落数/预览），Dry Run 侧即可完整展示调试数据

  debugWorldbookLog('worldbook segment dispatched', {
    // 记录搬移摘要，方便在 debug 模式下确认段落去向。
    group: group?.id,
    anchor: resultInfo.anchor,
    role: resultInfo.role,
    segments: segments.length,
    status: resultInfo.status,
    reason: resultInfo.reason || undefined,
    preview: preview?.snippet,
  });

  return resultInfo;
}
 
/**
 * 从 clewd 合并结果中抽取目标标记内容并搬移：
 * 1. 遍历所有启用组，使用正则匹配目标标记包裹的内容；
 * 2. 清理未配对目标标记并输出警告；
 * 3. 调用 applyWorldbookSegmentDispatch 完成实际搬运；
 * 4. 最终重写 mergedAssistantMessage.content。
 */
function dispatchWorldbookSegments(config, mergedAssistantMessage) {
  const result = { before: [], after: [] };
  const groups = config?.worldbook?.groups;
  if (!Array.isArray(groups) || !groups.length || !mergedAssistantMessage?.content) {
    return result;
  }
 
  const contentHolder = { value: mergedAssistantMessage.content };
 
  for (const group of groups) {
    // prefix 缺失说明组配置异常或未初始化，直接跳过避免误删正文。
    if (!group || typeof group !== 'object') continue;
    const prefix = group.sentinel?.prefix;
    if (!prefix) continue;
 
    const beginMarker = `${prefix}BEGIN`;
    const endMarker = `${prefix}END`;
    const pattern = new RegExp(`${regexEscape(beginMarker)}([\\s\\S]*?)${regexEscape(endMarker)}`, 'g');
    const segments = [];
    const matchedEntryKeys = collectGroupMatchedEntries(group);
    // 记录当前搬运组目标锚点/角色，后续在 Dry Run 中作为条目状态更新的默认值
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
        // 未抓取到任何片段，说明哨兵被清除或宏未命中，直接将命中的条目标记为 fallback
        matchedEntryKeys.forEach(entryKey =>
          updateDryRunEntryStatus(group, entryKey, DRY_RUN_STATUS.FALLBACK, {
            anchor: defaultAnchor,
            role: defaultRole,
            reason: 'no worldbook segments extracted between sentinels',
            preview: null,
          })
        );
      }
      if (
        group.target?.anchor === WORLD_BOOK_ANCHORS.CUSTOM &&
        group.clean_orphan_anchor === true
      ) {
        const orphanKey = (group.target.customKey || '').trim();
        if (orphanKey && contentHolder.value.includes(orphanKey)) {
          contentHolder.value = contentHolder.value.split(orphanKey).join('');
          debugWorldbookLog('orphan custom anchor removed', { group: group.id, key: orphanKey });
        }
        appendDryRunSegments(group, segments);
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
      // 记录每个 depth 命中的数量，便于后续排查遗漏或多次搬移。
      debugWorldbookLog('worldbook segments extracted', {
        group: group.id,
        depths: Array.from(group.matches.keys()),
        count: segments.length,
      });
      group.matches.clear();
    } else {
      debugWorldbookLog('worldbook segments extracted', {
        group: group.id,
        count: segments.length,
      });
    }

    appendDryRunSegments(group, segments);

    group.sentinel = group.sentinel || {};
    // 本轮搬运逻辑完成后复位 opened 状态，避免残留标志影响下一次请求
    group.sentinel.opened = false;

    let resultInfo = null;
    try {
      // 调用搬运函数并接收返回状态，成功时 resultInfo 会携带 标记/注入角色/预览 等信息
      // 搬运过程中可能因目标锚点缺失抛错，此处捕获并记录，以免影响后续消息流水。
      resultInfo = applyWorldbookSegmentDispatch(group, segments, contentHolder, result.before, result.after);
      group.sentinel.moved = true;
    } catch (error) {
      warnWorldbookIssue('failed to dispatch worldbook segments', { group: group.id, error });
      resultInfo = {
        status: DRY_RUN_STATUS.FAILED,
        anchor: defaultAnchor,
        role: defaultRole,
        reason: error?.message || 'worldbook dispatch failed',
        preview: null,
      };
    }

    if (!resultInfo) {
      // 安全兜底：即便搬运异常不中断，也要回写默认的成功状态以防 Dry Run 崩溃
      resultInfo = {
        status: DRY_RUN_STATUS.SUCCESS,
        anchor: defaultAnchor,
        role: defaultRole,
        reason: null,
        preview: null,
      };
    }

    if (matchedEntryKeys.length) {
      const extra = {
        // 展示搬运结果的锚点/角色/原因/预览，条目层级的 Dry Run 报告呈现上下文
        anchor: resultInfo.anchor ?? defaultAnchor,
        role: resultInfo.role ?? defaultRole,
        reason: resultInfo.reason ?? null,
        preview: resultInfo.preview ?? null,
      };
      const statusValue = resultInfo.status || DRY_RUN_STATUS.SUCCESS;
      matchedEntryKeys.forEach(entryKey => updateDryRunEntryStatus(group, entryKey, statusValue, extra));
    }
  }
 
  contentHolder.value = normalizeWorldbookContent(contentHolder.value);
  mergedAssistantMessage.content = contentHolder.value;
 
  return result;
}
 
/**
 * processAndAddMergeBlock：
 * 1. 对连续消息块执行数据捕获；
 * 2. 调用 clewd `process` 得到合并文本；
 * 3. 处理 system 截断、预填消息与角色替换。
 * 返回值用于提示外层是否需要刷新存储。
 */
/**
 * 整体合并流程入口（按 noass 逻辑“低层块合并”）：
 * 1. 捕获规则 → 世界书目标标记插入；
 * 2. 调用 clewd process 合并文本；
 * 3. 调用 dispatchWorldbookSegments 完成世界书的二次搬运；
 * 4. 维护 system 消息/预填充信息并推入最终队列。
 */
function processAndAddMergeBlock(template, config, blockToMerge, targetArray) {
  if (!blockToMerge || !blockToMerge.length) {
    return false;
  }

  let storedChanged = false;

  if (config.capture_enabled && config.capture_rules?.length) {
    let combinedContent = '';
    for (const message of blockToMerge) {
      if (message?.content) {
        combinedContent += (combinedContent ? '\n\n' : '') + message.content;
      }
    }
    if (combinedContent) {
      storedChanged = captureAndStoreData(template, combinedContent) || storedChanged;
    }
  }

  injectWorldbookSentinels(config, blockToMerge);

  const runtimeGroups = Array.isArray(config?.worldbook?.groups) ? config.worldbook.groups : [];
  const customAnchors = [];
  for (const group of runtimeGroups) {
    if (group?.target?.anchor === WORLD_BOOK_ANCHORS.CUSTOM) {
      const key = (group.target.customKey || '').trim();
      if (key && !customAnchors.includes(key)) {
        customAnchors.push(key);
      }
    }
  }

  const placeholderMap = new Map();
  let blockForProcess = blockToMerge;

  if (customAnchors.length) {
    blockForProcess = blockToMerge.map(message => {
      if (!message || typeof message !== 'object') return message;
      const cloned = { ...message };
      if (typeof cloned.content === 'string' && cloned.content) {
        let updated = cloned.content;
        customAnchors.forEach((key, index) => {
          let placeholder = placeholderMap.get(key);
          if (!placeholder) {
            placeholder = `${WORLD_BOOK_SENTINEL_PREFIX}ANCHOR${index}__`;
            placeholderMap.set(key, placeholder);
          }
          if (updated.includes(key)) {
            updated = updated.split(key).join(placeholder);
          }
        });
        cloned.content = updated;
      }
      return cloned;
    });
  }

  const mergedAssistantMessage = process(config, blockForProcess);

  if (placeholderMap.size && mergedAssistantMessage?.content) {
    placeholderMap.forEach((placeholder, key) => {
      if (mergedAssistantMessage.content.includes(placeholder)) {
        mergedAssistantMessage.content = mergedAssistantMessage.content.split(placeholder).join(key);
      }
    });
  }

  const worldbookDispatch = dispatchWorldbookSegments(config, mergedAssistantMessage);

  if (mergedAssistantMessage?.content) {
    // 先在合并结果上执行 tag 替换，保持历史行为。
    const beforeContent = mergedAssistantMessage.content;
    mergedAssistantMessage.content = replaceTagsWithStoredData(
      mergedAssistantMessage.content,
      template,
      config.clean_clewd
    );
    if (beforeContent !== mergedAssistantMessage.content) {
      try {
        console.debug('[ST-Diff][noass] 合并内容发生标签替换');
      } catch {}
    }
  }

  if (Array.isArray(worldbookDispatch?.before)) {
    for (const message of worldbookDispatch.before) {
      if (message?.content) {
        message.content = replaceTagsWithStoredData(message.content, template, config.clean_clewd);
      }
    }
  }

  if (Array.isArray(worldbookDispatch?.after)) {
    // after 队列会在主消息之后附加，用于模拟“额外系统指令”或“延迟搬移”。
    for (const message of worldbookDispatch.after) {
      if (message?.content) {
        message.content = replaceTagsWithStoredData(message.content, template, config.clean_clewd);
      }
    }
  }

  let systemMessage = null;
  if (config.separator_system) {
    const systemIndex = mergedAssistantMessage.content.indexOf(config.separator_system);
    if (systemIndex > 0) {
      const systemContent = mergedAssistantMessage.content.slice(
        0,
        systemIndex + config.separator_system.length
      );
      mergedAssistantMessage.content = mergedAssistantMessage.content.slice(
        systemIndex + config.separator_system.length
      );
      systemMessage = { role: 'system', content: systemContent };
    }
  }

  if (systemMessage) {
    targetArray.push(systemMessage);
  }

  if (worldbookDispatch?.before?.length) {
    for (const message of worldbookDispatch.before) {
      targetArray.push(message);
    }
  }

  const prefill = config.prefill_user || defaultTemplate.prefill_user;
  if (config.inject_prefill !== false && prefill && prefill.trim()) {
    targetArray.push({
      role: 'user',
      content: prefill,
    });
  }

  mergedAssistantMessage.role = config.single_user ? 'user' : 'assistant';
  if (mergedAssistantMessage.content && mergedAssistantMessage.content.trim()) {
    targetArray.push(mergedAssistantMessage);
  }

  if (worldbookDispatch?.after?.length) {
    for (const message of worldbookDispatch.after) {
      targetArray.push(message);
    }
  }

  return storedChanged;
}

/**
 * processPreservedSystemMessage：对含有 <|no-trans|> 的原始消息做最小化处理，
 * 保留 system 部分，同时执行占位符替换以维持上下文一致。
 */
function processPreservedSystemMessage(config, template, message, targetArray) {
  let systemMessage = null;
  let remainingContent = message.content;

  if (config.separator_system && message.role === 'system') {
    const systemIndex = remainingContent.indexOf(config.separator_system);
    if (systemIndex > 0) {
      const systemContent = remainingContent.slice(0, systemIndex + config.separator_system.length);
      remainingContent = remainingContent.slice(systemIndex + config.separator_system.length).trim();
      systemMessage = { role: 'system', content: systemContent };
    }
  }

  if (systemMessage) {
    targetArray.push(systemMessage);
  }

  if (remainingContent) {
    const replaced = replaceTagsWithStoredData(remainingContent, template, config.clean_clewd);
    const preservedMessage = {
      role: message.role,
      content: replaced,
    };
    if (message.name) preservedMessage.name = message.name;
    targetArray.push(preservedMessage);
  } else if (!systemMessage) {
    targetArray.push(message);
  }
}

/**
 * captureAndStoreData：遍历捕获规则匹配文本并写入 stored_data。
 * 支持叠加/替换模式、范围过滤，返回值表示数据是否发生变化。
 */
function captureAndStoreData(template, content) {
  const rules = template.capture_rules || [];
  if (!template.capture_enabled || !rules.length) {
    return false;
  }

  const storedData = template.stored_data || (template.stored_data = {});
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
        storedData[tag] = storedData[tag] || [];
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

/** filterByRange：解析 "+1,-2,+3~+5" 等片段，提取匹配结果中的子集。 */
function filterByRange(array, rangeStr) {
  try {
    const result = [];
    const segments = rangeStr.split(',');

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i].
        trim();
      if (!segment) continue;

      if (segment.includes('~')) {
        const parts = segment.split('~');
        let startIndex = parseRangeIndex(parts[0], array.length);
        let endIndex = parseRangeIndex(parts[1], array.length);
        if (startIndex > endIndex) {
          const tmp = startIndex;
          startIndex = endIndex;
          endIndex = tmp;
        }
        for (let j = startIndex; j <= endIndex && j < array.length; j++) {
          if (j >= 0 && !result.includes(array[j])) {
            result.push(array[j]);
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

/** parseRangeIndex：将范围字符串转换为零基索引，兼容正负向两种写法。 */
function parseRangeIndex(indexStr, arrayLength) {
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
 * replaceTagsWithStoredData：用 stored_data 中的内容替换占位符。
 * 当 cleanEmpty 为真时会同时清理未命中规则的占位符，避免残留。
 */
function replaceTagsWithStoredData(content, template, cleanEmpty) {
  const storedData = template.stored_data || {};
  const tags = new Set(Object.keys(storedData));
  if (cleanEmpty) {
    (template.capture_rules || [])
      .filter(rule => rule?.tag)
      .forEach(rule => tags.add(rule.tag));
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

/* ======================= clewd 处理逻辑 ======================= */

/**
 * process：负责执行全量正则与合并逻辑。
 * - HyperProcess 会三轮解析 <regex> 指令；
 * - hyperMerge 控制角色前缀合并；
 * - 最终生成合并后的消息文本供 downstream 使用。
 */
function process(prefixs, messages) {
  prefixs = prefixs || defaultTemplate;

  const HyperProcess = function (system, messages, claudeMode) {
    const hyperMerge = function (content, mergeDisable) {
      let splitContent = content.split(
        new RegExp(`\\n\\n(${prefixs.assistant}|${prefixs.user}|${prefixs.system}):`, 'g')
      );
      content =
        splitContent[0] +
        splitContent.slice(1).reduce(function (acc, current, index, array) {
          const merge =
            index > 1 &&
            current === array[index - 2] &&
            ((current === prefixs.user && !mergeDisable.user) ||
              (current === prefixs.assistant && !mergeDisable.assistant) ||
              (current === prefixs.system && !mergeDisable.system));
          return acc + (index % 2 !== 0 ? current.trim() : `\n\n${merge ? '' : `${current}: `}`);
        }, '');
      return content;
    };

    const hyperRegex = function (content, order) {
      let regexLog = '';
      const regexPattern = `<regex(?: +order *= *${order})${order === 2 ? '?' : ''}> *"(/?)(.*)\\1(.*?)" *: *"(.*?)" *</regex>`;
      let matches = content.match(new RegExp(regexPattern, 'gm'));

      if (matches) {
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          try {
            const reg = /<regex(?: +order *= *\d)?> *"(\/?)(.*)\1(.*?)" *: *"(.*?)" *<\/regex>/.exec(match);
            regexLog += `${match}\n`;
            const replacePattern = new RegExp(reg[2], reg[3]);
            const replacement = JSON.parse(`"${reg[4].replace(/\\?"/g, '\\"')}"`);
            content = content.replace(replacePattern, replacement);
          } catch (e) {
            console.warn('[ST-Diff][noass] Regex processing error:', e);
          }
        }
      }
      return [content, regexLog];
    };

    const HyperPmtProcess = function (content) {
      const regex1 = hyperRegex(content, 1);
      content = regex1[0];
      regexLogs += regex1[1];

      const mergeDisable = {
        all: content.indexOf('<|Merge Disable|>') !== -1,
        system: content.indexOf('<|Merge System Disable|>') !== -1,
        user: content.indexOf('<|Merge Human Disable|>') !== -1,
        assistant: content.indexOf('<|Merge Assistant Disable|>') !== -1,
      };

      const systemPattern1 = new RegExp(
        `(\\n\\n|^\\s*)(?<!\\n\\n(${prefixs.user}|${prefixs.assistant}):.*?)${prefixs.system}:\\s*`,
        'gs'
      );
      const systemPattern2 = new RegExp(`(\\n\\n|^\\s*)${prefixs.system}: *`, 'g');

      content = content
        .replace(systemPattern1, '$1')
        .replace(
          systemPattern2,
          mergeDisable.all || mergeDisable.user || mergeDisable.system ? '$1' : `\n\n${prefixs.user}: `
        );
      content = hyperMerge(content, mergeDisable);

      const splitPattern = new RegExp(`\\n\\n(?=${prefixs.assistant}:|${prefixs.user}:)`, 'g');
      let splitContent = content.split(splitPattern);

      let match;
      const atPattern = /<@(\d+)>(.*?)<\/@\1>/gs;
      while ((match = atPattern.exec(content)) !== null) {
        let index = splitContent.length - parseInt(match[1]) - 1;
        if (index >= 0) {
          splitContent[index] += `\n\n${match[2]}`;
        }
        content = content.replace(match[0], '');
      }

      content = splitContent.join('\n\n').replace(/<@(\d+)>.*?<\/@\1>/gs, '');

      const regex2 = hyperRegex(content, 2);
      content = regex2[0];
      regexLogs += regex2[1];
      content = hyperMerge(content, mergeDisable);

      const regex3 = hyperRegex(content, 3);
      content = regex3[0];
      regexLogs += regex3[1];

      content = content
        .replace(/<regex( +order *= *\d)?>.*?<\/regex>/gm, '')
        .replace(/\r\n|\r/gm, '\n')
        .replace(/\s*<\|curtail\|>\s*/g, '\n')
        .replace(/\s*<\|join\|>\s*/g, '')
        .replace(/\s*<\|space\|>\s*/g, ' ')
        .replace(/<\|(\\.*?)\|>/g, function (match, p1) {
          try {
            return JSON.parse(`"${p1}"`);
          } catch {
            return match;
          }
        });

      return content
        .replace(/\s*<\|.*?\|>\s*/g, '\n\n')
        .trim()
        .replace(/^.+:/, '\n\n$&')
        .replace(/(?<=\n)\n(?=\n)/g, '');
    };

    let prompt = system || '';
    let regexLogs = '';

    if (!messages || messages.length === 0) {
      return { prompt: '', log: '' };
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message && message.content) {
        const role = message.role || 'user';
        const name = message.name;
        const prefixLookup = prefixs[name] || prefixs[role] || role;
        const prefix = `\n\n${prefixLookup}${name ? `: ${name}` : ''}: `;
        prompt += prefix + message.content.trim();
      } else {
        console.warn('[ST-Diff][noass] 跳过无效消息对象:', message);
      }
    }

    prompt = HyperPmtProcess(prompt);
    if (!claudeMode && prompt) {
      prompt += `\n\n${prefixs.assistant}:`;
    }
    return { prompt: prompt, log: `\n####### Regex:\n${regexLogs}` };
  };

  let separator = '';
  if (prefixs.separator) {
    try {
      if (logHandler) {
        logHandler('hyperRegex:match', { order, match });
      }
      separator = JSON.parse(`"${prefixs.separator}"`);
    } catch (e) {
      console.error('[ST-Diff][noass] separator 解析失败', e);
    }
  }

  const youPmtProcess = function (prompt, sep) {
    if (typeof prompt !== 'string' || !prompt) return '';
    const splitPattern = new RegExp(`\\n\\n(?=${prefixs.assistant}:|${prefixs.user}:)`, 'g');
    return prompt.split(splitPattern).join(`\n${sep}\n`);
  };

  const result = HyperProcess('', messages, true);
  const prompt = result.prompt;

  const youPrompt = prompt.split(/\s*\[-youFileTag-\]\s*/);
  const filePrompt = youPrompt.length > 0 ? youPrompt.pop().trim() : '';

  return {
    role: 'assistant',
    content: youPmtProcess(filePrompt, separator),
  };
}