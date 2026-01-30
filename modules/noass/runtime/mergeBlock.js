import { NO_TRANS_TAG, WORLD_BOOK_SENTINEL_PREFIX } from './clewd/constants.js';
import { defaultTemplate } from '../state/defaults.js';
import { ensureTemplateDefaults, cloneTemplate } from '../state/state.js';
import { process } from './clewd/processor.js';
import { applyClewdTagTransferRules } from './clewd/tagTransfer.js';
import { captureAndStoreData, replaceTagsWithStoredData } from './capture/capture.js';
import { injectWorldbookSentinels, attachDryRunHelpers } from './wibridge/sentinel.js';
import { dispatchWorldbookSegments, normalizeWorldbookContent } from './wibridge/dispatch.js';
import { buildWorldbookRuntimeGroups } from './wibridge/normalize.js';
import { exportWorldbookSnapshot } from './wibridge/cache.js';
import {
  setWorldbookDebug,
  createDryRunContext,
  finalizeDryRunContext,
  cloneMessageArray,
  summarizeTextForDiagnostics,
  getWorldbookLogAdapter,
  DRY_RUN_STATUS,
} from './wibridge/state.js';

let refreshStoredDataView = null;
let lastCompletionSnapshot = null;

/**
 * 注入 UI 层提供的存储数据刷新回调。
 *
 * @param {(() => void) | null | undefined} callback 当捕获内容变化时触发的刷新函数
 */
export function setRefreshStoredDataView(callback) {
  refreshStoredDataView = typeof callback === 'function' ? callback : null;
}

/**
 * 获取最近一次 completion 触发时的快照，用于 Dry-Run 或调试。
 *
 * @returns {{ templateName: string, template: object, messages: Array, timestamp: number } | null}
 */
export function getLastCompletionSnapshot() {
  return lastCompletionSnapshot;
}

function buildRuntimeConfig(template) {
  const config = JSON.parse(JSON.stringify(defaultTemplate));
  setWorldbookDebug(template.debug_worldbook === true);

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
  config.capture_rules = template.capture_rules ? template.capture_rules.map((rule) => ({ ...rule })) : [];
  config.stored_data = template.stored_data || (template.stored_data = {});
  config.single_user = !!template.single_user;
  config.inject_prefill = template.inject_prefill !== false;
  config.clean_clewd = !!template.clean_clewd;
  config.worldbook = {
    groups: buildWorldbookRuntimeGroups(template),
    snapshot: exportWorldbookSnapshot(),
  };
  // 在同一轮 completion 中只注入一次 prefill（即使因 NO_TRANS_TAG 拆分为多个合并块）
  config.__prefillInjected = false;
 
  attachDryRunHelpers(config);
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
 * 判断消息内容是否包含 NO_TRANS_TAG，兼容字符串与多模态数组（{type:'text', text:'...'}）
 * @param {string|Array<any>} content
 * @returns {boolean}
 */
function contentHasNoTrans(content) {
  if (typeof content === 'string') {
    return content.indexOf(NO_TRANS_TAG) !== -1;
  }
  if (Array.isArray(content)) {
    return content.some((part) => part && typeof part.text === 'string' && part.text.indexOf(NO_TRANS_TAG) !== -1);
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    // 兼容单对象形态：{ type: 'text', text: '...' }
    return content.text.indexOf(NO_TRANS_TAG) !== -1;
  }
  return false;
}

/**
 * 从内容中移除 NO_TRANS_TAG；字符串直接替换，数组则替换各 text，空白项会被剔除
 * @param {string|Array<any>} content
 * @returns {string|Array<any>}
 */
function stripNoTrans(content) {
  if (typeof content === 'string') {
    return content.split(NO_TRANS_TAG).join('').trim();
  }
  if (Array.isArray(content)) {
    const next = [];
    for (const part of content) {
      if (part && typeof part.text === 'string') {
        const t = part.text.split(NO_TRANS_TAG).join('').trim();
        if (t) {
          next.push({ ...part, text: t });
        }
      } else if (part != null) {
        next.push(part);
      }
    }
    return next;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    // 兼容单对象形态：{ type: 'text', text: '...' }
    const t = content.text.split(NO_TRANS_TAG).join('').trim();
    return t ? { ...content, text: t } : '';
  }
  return content;
}

/**
 * 将来自宿主的非标准角色（如 'model'）规范化为合并兼容的角色
 * @param {string} role
 * @returns {'user'|'assistant'|'system'}
 */
function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'user' || r === 'assistant' || r === 'system') return /** @type any */(r);
  // 非标准角色（例如 model）一律按 assistant 处理，避免被 clewd 前缀误归为 user
  return 'assistant';
}

/**
 * 判断内容是否为空（字符串全空白，或数组中没有非空白 text）
 * @param {string|Array<any>} content
 * @returns {boolean}
 */
function isEmptyContent(content) {
  if (typeof content === 'string') {
    return content.trim().length === 0;
  }
  if (Array.isArray(content)) {
    return content.every((part) => !part || typeof part.text !== 'string' || part.text.trim().length === 0);
  }
  return !content;
}

/**
 * 按 clewd 规则处理一段消息块，执行捕获、世界书提取与标签替换，并将结果推入最终消息数组。
 *
 * @param {object} template 当前激活模板
 * @param {object} config 运行时配置（由 {@link buildRuntimeConfig} 生成）
 * @param {Array} blockToMerge 需要合并的原始消息块
 * @param {Array} targetArray 输出消息数组
 * @returns {boolean} 是否发生了 stored_data 变化
 */
export function processAndAddMergeBlock(template, config, blockToMerge, targetArray) {
  if (!blockToMerge || !blockToMerge.length) {
    return false;
  }

  let storedChanged = false;

  if (config.capture_enabled && config.capture_rules?.length) {
    let combinedContent = '';
    for (const message of blockToMerge) {
      if (message?.content && typeof message.content === 'string') {
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
    if (group?.target?.anchor === 'custom') {
      const key = (group.target.customKey || '').trim();
      if (key && !customAnchors.includes(key)) {
        customAnchors.push(key);
      }
    }
  }

  const placeholderMap = new Map();
  let blockForProcess = blockToMerge;

  if (customAnchors.length) {
    blockForProcess = blockToMerge.map((message) => {
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

  const logAdapter = getWorldbookLogAdapter();
  const shouldLogRegex =
    template?.debug_worldbook === true && logAdapter && typeof logAdapter.append === 'function';
  const processOptions =
    shouldLogRegex
      ? {
          logHandler: (event, payload = {}) => {
            if (event !== 'hyperRegex:match') return;
            try {
              const order = Number.isFinite(payload.order) ? payload.order : null;
              let preview = summarizeTextForDiagnostics(payload.match || '', 160);
              if (!preview && typeof payload.match === 'string') {
                preview = payload.match.slice(0, 160);
              }
              if (!preview) return;
              const info = order !== null ? { order, preview } : { preview };
              logAdapter.append('clewd 正则命中', info);
            } catch {
              // 忽略日志写入失败，避免影响主流程
            }
          },
        }
      : undefined;

  const mergedAssistantMessage = process(config, blockForProcess, processOptions);

  if (placeholderMap.size && mergedAssistantMessage?.content) {
    placeholderMap.forEach((placeholder, key) => {
      if (mergedAssistantMessage.content.includes(placeholder)) {
        mergedAssistantMessage.content = mergedAssistantMessage.content.split(placeholder).join(key);
      }
    });
  }

  const worldbookDispatch = dispatchWorldbookSegments(config, mergedAssistantMessage);

  if (typeof mergedAssistantMessage?.content === 'string' && mergedAssistantMessage.content) {
    mergedAssistantMessage.content = applyClewdTagTransferRules(
      mergedAssistantMessage.content,
      template?.clewd_tag_transfer_rules,
    );
  }

  if (mergedAssistantMessage?.content) {
    const beforeContent = mergedAssistantMessage.content;
    mergedAssistantMessage.content = replaceTagsWithStoredData(
      mergedAssistantMessage.content,
      template,
      config.clean_clewd,
    );
    if (beforeContent !== mergedAssistantMessage.content) {
      try {
        console.debug('[ST-Diff][noass] 合并内容发生标签替换');
      } catch {
        // ignore
      }
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
    for (const message of worldbookDispatch.after) {
      if (message?.content) {
        message.content = replaceTagsWithStoredData(message.content, template, config.clean_clewd);
      }
    }
  }

  let systemMessage = null;
  if (config.separator_system && mergedAssistantMessage.content) {
    const systemIndex = mergedAssistantMessage.content.indexOf(config.separator_system);
    if (systemIndex > 0) {
      const systemContent = mergedAssistantMessage.content.slice(
        0,
        systemIndex + config.separator_system.length,
      );
      mergedAssistantMessage.content = mergedAssistantMessage.content.slice(
        systemIndex + config.separator_system.length,
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
  // 仅在第一次合并块前注入 prefill；之后即便因 NO_TRANS_TAG 产生新块也不再重复注入
  if (config.inject_prefill !== false && prefill && prefill.trim() && !config.__prefillInjected) {
    try {
      console.debug('[ST-Diff][noass] inject prefill before merged block', {
        inject_prefill: config.inject_prefill !== false,
        has_prefill: !!prefill,
      });
    } catch {}
    targetArray.push({
      role: 'user',
      content: prefill,
    });
    config.__prefillInjected = true;
  }

  const assignedRole = config.single_user ? 'user' : 'assistant';
  mergedAssistantMessage.role = assignedRole;
  try {
    const preview = typeof summarizeTextForDiagnostics === 'function'
      ? summarizeTextForDiagnostics(mergedAssistantMessage.content || '', 80)
      : (mergedAssistantMessage?.content || '').slice(0, 80);
    console.debug('[ST-Diff][noass] merged block role assigned', {
      single_user: !!config.single_user,
      assignedRole,
      contentPreview: preview,
    });
  } catch {}
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
 * 在不破坏原顺序的前提下处理保留消息，将system片段拆分并执行占位符替换。
 *
 * @param {object} config 运行时配置
 * @param {object} template 当前模板
 * @param {{ role: string, content: string, name?: string }} message 原始消息
 * @param {Array} targetArray 输出消息数组
 */
export function processPreservedSystemMessage(config, template, message, targetArray) {
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
 * completion 事件处理入口：拆分消息块、触发合并流程并回写最终消息。
 *
 * @param {object} ctx 扩展上下文
 * @param {object} state noass 设置状态
 * @param {{ messages: Array }} completion SillyTavern 提供的 completion payload
 */
export function handleCompletion(ctx, state, completion) {
  if (!state || state.enabled === false) return;
  if (!completion?.messages) return;

  const template =
    state.templates[state.active] || state.templates[Object.keys(state.templates)[0]];
  if (!template) return;


  const sanitizedTemplate = ensureTemplateDefaults(template);
  const config = buildRuntimeConfig(sanitizedTemplate);

  const originalMessages = Array.isArray(completion.messages) ? completion.messages : [];
  lastCompletionSnapshot = {
    templateName: state.active,
    template: cloneTemplate(sanitizedTemplate),
    messages: cloneMessageArray(originalMessages),
    timestamp: Date.now(),
    source: completion?.chat_completion_source ?? null,
  };

  const finalMessages = [];
  let currentMergeBlock = [];
  let storedChanged = false;

  for (const message of originalMessages) {
    if (contentHasNoTrans(message?.content)) {
      // 命中 notrans：先冲洗当前合并块，再将本条去标记后按原角色保留
      storedChanged =
        processAndAddMergeBlock(sanitizedTemplate, config, currentMergeBlock, finalMessages) ||
        storedChanged;
      currentMergeBlock = [];

      const messageWithoutTag = {
        role: message.role,
        content: stripNoTrans(message.content),
      };
      if (message.name) messageWithoutTag.name = message.name;

      if (!isEmptyContent(messageWithoutTag.content)) {
        if (typeof messageWithoutTag.content === 'string') {
          processPreservedSystemMessage(config, sanitizedTemplate, messageWithoutTag, finalMessages);
        } else {
          // 非字符串内容保留原样（仅移除 notrans），不做字符串替换与系统分割
          finalMessages.push(messageWithoutTag);
        }
      }
    } else {
      currentMergeBlock.push(message);
    }
  }

  storedChanged =
    processAndAddMergeBlock(sanitizedTemplate, config, currentMergeBlock, finalMessages) ||
    storedChanged;

  for (let i = 0; i < finalMessages.length; i++) {
    if (finalMessages[i]?.content) {
      const before = finalMessages[i].content;
      finalMessages[i].content = replaceTagsWithStoredData(
        finalMessages[i].content,
        sanitizedTemplate,
        config.clean_clewd,
      );
      if (before !== finalMessages[i].content) {
        try {
          console.debug('[ST-Diff][noass] 标签替换发生在消息', i);
        } catch {
          // ignore
        }
      }
    }
  }

  completion.messages = finalMessages;

  if (storedChanged) {
    if (typeof ctx?.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    } else if (typeof ctx?.saveSettings === 'function') {
      ctx.saveSettings();
    } else if (typeof window.saveSettingsDebounced === 'function') {
      window.saveSettingsDebounced();
    } else if (typeof window.saveSettings === 'function') {
      window.saveSettings();
    }
    refreshStoredDataView?.();
  }
}

/**
 * 对最近一次 completion 快照执行 Dry-Run，生成世界书抽取与搬运的详细日志。
 *
 * @param {object} ctx 扩展上下文
 * @returns {Promise<void>}
 */
export async function runWorldbookDryRun(ctx) {
  const logAdapter = getWorldbookLogAdapter();
  if (!logAdapter || typeof logAdapter.reset !== 'function') {
    console.warn('[ST-Diff][noass] Dry Run log adapter not ready');
    return;
  }

  logAdapter.reset();
  logAdapter.append('Dry Run 开始', { timestamp: new Date().toISOString() }, { force: true });

  if (!lastCompletionSnapshot || !Array.isArray(lastCompletionSnapshot.messages)) {
    logAdapter.append('Dry Run 失败：暂无可用对话快照', null, { force: true });
    try {
      (ctx?.toastr || window.toastr || { warning: () => {} }).warning?.('暂无可用上下文，请先发送一轮消息。');
    } catch {
      // ignore
    }
    return;
  }

  const snapshot = lastCompletionSnapshot;
  logAdapter.append('上下文源', { source: snapshot?.source || null }, { force: true });
  const templateClone = ensureTemplateDefaults(cloneTemplate(snapshot.template || defaultTemplate));
  const config = buildRuntimeConfig(templateClone);
  const messagesClone = cloneMessageArray(snapshot.messages || []);
  const finalMessages = [];
  let currentMergeBlock = [];
  let storedChanged = false;

  const flushMergeBlock = () => {
    if (!currentMergeBlock.length) return;
    storedChanged =
      processAndAddMergeBlock(templateClone, config, currentMergeBlock, finalMessages) ||
      storedChanged;
    currentMergeBlock = [];
  };

  const summarizeText = (text, length = 160) => {
    if (typeof text !== 'string') return '';
    return text.length > length ? `${text.slice(0, length)}…` : text;
  };

  let dryRunResult = null;
  let runError = null;

  try {
    createDryRunContext();

    for (const message of messagesClone) {
      if (contentHasNoTrans(message?.content)) {
        flushMergeBlock();

        const messageWithoutTag = {
          role: message.role,
          content: stripNoTrans(message.content),
        };
        if (message.name) {
          messageWithoutTag.name = message.name;
        }

        if (!isEmptyContent(messageWithoutTag.content)) {
          if (typeof messageWithoutTag.content === 'string') {
            processPreservedSystemMessage(config, templateClone, messageWithoutTag, finalMessages);
          } else {
            finalMessages.push(messageWithoutTag);
          }
        }
      } else {
        currentMergeBlock.push(message);
      }
    }

    flushMergeBlock();
    dryRunResult = finalizeDryRunContext();
  } catch (error) {
    runError = error;
    if (typeof finalizeDryRunContext === 'function') {
      dryRunResult = finalizeDryRunContext();
    }
    console.error('[ST-Diff][noass] Dry Run 执行失败', error);
    try {
      logAdapter.append(
        'Dry Run 异常',
        {
          message: error?.message || String(error),
          stack: error?.stack || null,
        },
        { force: true },
      );
    } catch (logError) {
      console.warn('[ST-Diff][noass] Dry Run 错误日志写入失败', logError);
    }
  }

  const warnings = Array.isArray(dryRunResult?.warnings) ? dryRunResult.warnings : [];
  const groupReports =
    dryRunResult?.context?.groups instanceof Map ? Array.from(dryRunResult.context.groups.values()) : [];

  if (runError) {
    logAdapter.append(
      'Dry Run 失败',
      { error: runError?.message || String(runError), warnings: warnings.length },
      { force: true },
    );
    try {
      (ctx?.toastr || window.toastr || { error: () => {} }).error?.('Dry Run 执行失败，请查看控制台日志。');
    } catch {
      // ignore
    }
    return;
  }

  logAdapter.append(
    'Dry Run 完成',
    {
      groups: groupReports.length,
      warnings: warnings.length,
      storedChanged: storedChanged === true,
    },
    { force: true },
  );

  if (!groupReports.length) {
    logAdapter.append('未命中任何启用的世界书条目', null, { force: true });
  } else {
    groupReports.forEach((report) => {
      const depths = (report.depths || []).map((item) => ({ depth: item.depth, count: item.count }));
      const dispatchSummary = {};
      Object.entries(report.dispatch || {}).forEach(([anchor, payloads]) => {
        if (Array.isArray(payloads) && payloads.length) {
          dispatchSummary[anchor] = {
            count: payloads.length,
            samples: payloads.slice(0, 2).map((payload) =>
              typeof payload === 'string'
                ? summarizeText(payload)
                : `${payload.role || 'unknown'}: ${summarizeText(payload.content || '')}`,
            ),
          };
        }
      });

      const entrySummaries = (report.entries || []).map((entry) => {
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

      logAdapter.append(
        `组 ${report.label || report.id}`,
        {
          target: report.target,
          depths,
          entries: entrySummaries,
          segmentsPreview: (report.segments || []).slice(0, 3).map((segment) => summarizeText(segment)),
          dispatch: dispatchSummary,
        },
        { force: true },
      );
    });
  }

  if (warnings.length) {
    warnings.forEach((warning, index) => {
      logAdapter.append(
        `警告 ${index + 1}`,
        { message: warning?.message, context: warning?.context || null },
        { force: true },
      );
    });
  }

  if (finalMessages.length) {
    const preview = finalMessages.map((message, index) => ({
      index,
      role: message?.role,
      preview: summarizeText(message?.content || ''),
    }));
    logAdapter.append('合并结果预览', { messages: preview }, { force: true });
  }

  try {
    (ctx?.toastr || window.toastr || { success: () => {} }).success?.('Dry Run 完成，请查看日志。');
  } catch {
    // ignore
  }
}