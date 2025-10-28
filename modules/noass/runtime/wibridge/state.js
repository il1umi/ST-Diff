/**
 * @file 维护世界书runtime缓存以及 Dry-Run 报告结构，供 runtime 与 UI 共用。
 */
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

export const DRY_RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  SUCCESS: 'success',
  FALLBACK: 'fallback',
  FAILED: 'failed',
});

let worldbookLogAdapter = { append: null, reset: null };
let worldbookDryRunWarnings = null;
let worldbookDryRunContext = null;

/**
 * 设置世界书日志适配器，供 UI 与 Dry-Run 使用。
 */
export function setWorldbookLogAdapter(adapter = {}) {
  const previousAdapter = worldbookLogAdapter;
  worldbookLogAdapter = {
    append: typeof adapter.append === 'function' ? adapter.append : null,
    reset: typeof adapter.reset === 'function' ? adapter.reset : null,
  };

  const shouldResetPrevious =
    previousAdapter &&
    typeof previousAdapter.reset === 'function' &&
    previousAdapter.reset !== worldbookLogAdapter.reset;

  if (shouldResetPrevious) {
    try {
      previousAdapter.reset();
    } catch (error) {
      debugWorldbookLog('failed to reset previous log adapter', {
        message: error?.message || String(error),
      });
    }
  }
}

export function getWorldbookLogAdapter() {
  return worldbookLogAdapter;
}

/**
 * 更新调试开关，由 UI 设置模板时调用。
 */
export function setWorldbookDebug(enabled) {
  worldbookState.debug = !!enabled;
}

export function debugWorldbookLog(...args) {
  if (!worldbookState.debug) return;
  try {
    console.debug('[ST-Diff][noass][worldbook]', ...args);
  } catch {
    // ignore
  }
}

export function warnWorldbookIssue(message, context = {}) {
  try {
    console.warn('[ST-Diff][noass][worldbook warning]', message, context);
  } catch {
    // ignore
  }

  if (Array.isArray(worldbookDryRunWarnings)) {
    worldbookDryRunWarnings.push({ message, context });
  }
}

export function isDryRunActive() {
  return !!worldbookDryRunContext;
}

export function createDryRunContext() {
  worldbookDryRunWarnings = [];
  worldbookDryRunContext = {
    startedAt: Date.now(),
    groups: new Map(),
  };
}

export function finalizeDryRunContext() {
  const context = worldbookDryRunContext;
  const warnings = Array.isArray(worldbookDryRunWarnings) ? [...worldbookDryRunWarnings] : [];
  worldbookDryRunContext = null;
  worldbookDryRunWarnings = null;
  return { context, warnings };
}

export function makeDryRunEntryKey(entry, depth, order, messageIndex) {
  if (entry?.uid !== undefined && entry?.uid !== null) {
    return String(entry.uid);
  }
  const depthPart = Number.isFinite(depth) ? depth : 'na';
  const orderPart = Number.isFinite(order) ? order : 'na';
  const messagePart = Number.isInteger(messageIndex) ? messageIndex : 'na';
  return `depth${depthPart}-order${orderPart}-msg${messagePart}`;
}

export function ensureDryRunGroupReport(group) {
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

export function updateDryRunEntryStatus(group, entryKey, status, extra = {}) {
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

export function collectGroupMatchedEntries(group) {
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

export function registerDryRunDepthSummary(group, depth, entries) {
  const report = ensureDryRunGroupReport(group);
  if (!report) return;

  const summaryEntries = entries.map((item) => {
    const entryKey =
      item.entryKey ||
      makeDryRunEntryKey(item.entry, depth, item.entry?.order ?? null, item.messageIndex);

    const preview = {
      location: item.source || group?.target?.anchor,
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
        targetAnchor: group?.target?.anchor,
        targetRole: group?.target?.role,
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
      targetAnchor: group?.target?.anchor,
      targetRole: group?.target?.role,
      preview,
    };
  });

  report.depths.push({
    depth,
    count: entries.length,
    entries: summaryEntries,
  });
}

export function appendDryRunSegments(group, segments) {
  const report = ensureDryRunGroupReport(group);
  if (!report || !segments?.length) return;
  report.segments.push(
    ...segments.map((segment) => (typeof segment === 'string' ? segment : String(segment))),
  );
}

export function pushDryRunDispatch(group, anchor, payload, { fallback = false } = {}) {
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

export function summarizeTextForDiagnostics(text, length = 80) {
  if (typeof text !== 'string') {
    return '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}

export function cloneDryRunMessage(message) {
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

export function cloneMessageArray(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(cloneDryRunMessage);
}

export { worldbookState };