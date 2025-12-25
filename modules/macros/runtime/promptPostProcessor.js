const TAG = '[ST-Diff][macros][prompt-post]';

function escapeRegExp(source) {
  return String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTagName(rawTagName) {
  const fallback = 'framework';
  if (typeof rawTagName !== 'string') return fallback;
  const token = rawTagName.trim().split(/\s+/)[0];
  if (!token) return fallback;
  return token.slice(0, 64);
}

function collectCascadePrefixes(state) {
  const groups = state?.cascade?.groups;
  if (!groups || typeof groups !== 'object') return [];

  const set = new Set();
  for (const group of Object.values(groups)) {
    const prefix = typeof group?.prefix === 'string' ? group.prefix.trim() : '';
    if (!prefix) continue;
    set.add(prefix.slice(0, 64));
  }

  return Array.from(set);
}

function renumberPrefixLinesInBlock(text, prefixToken) {
  if (typeof text !== 'string' || !text) return text;
  if (typeof prefixToken !== 'string' || !prefixToken) return text;

  const escapedPrefix = escapeRegExp(prefixToken);
  let counter = 0;

  // 行首匹配：允许prefix与数字之间存在空白，兼容输入了空格的情况
  const pattern = new RegExp(`^(\\s*)(${escapedPrefix})(\\s*)(\\d+)([:：])`, 'gm');

  return text.replace(pattern, (_match, leading, prefix, between, _num, colon) => {
    counter += 1;
    return `${leading}${prefix}${between}${counter}${colon}`;
  });
}

function processFrameworkBlocks(prompt, tagName, prefixes) {
  if (typeof prompt !== 'string' || !prompt) return prompt;
  if (!Array.isArray(prefixes) || prefixes.length === 0) return prompt;

  const normalizedTag = normalizeTagName(tagName);
  const escapedTag = escapeRegExp(normalizedTag);

  // 支持：<framework> 与 </framework>类的xml标签
  const openRe = new RegExp(`<${escapedTag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${escapedTag}>`, 'gi');

  let cursor = 0;
  let out = '';

  while (true) {
    openRe.lastIndex = cursor;
    const openMatch = openRe.exec(prompt);
    if (!openMatch) break;

    const openStart = openMatch.index;
    const openEnd = openRe.lastIndex;

    closeRe.lastIndex = openEnd;
    const closeMatch = closeRe.exec(prompt);
    if (!closeMatch) {
      // 找不到闭合标签时保留后续原文
      break;
    }

    const closeStart = closeMatch.index;
    const closeEnd = closeRe.lastIndex;

    const inner = prompt.slice(openEnd, closeStart);
    let processed = inner;

    for (const prefixToken of prefixes) {
      processed = renumberPrefixLinesInBlock(processed, prefixToken);
    }

    out += prompt.slice(cursor, openEnd);
    out += processed;
    out += prompt.slice(closeStart, closeEnd);

    cursor = closeEnd;
  }

  if (cursor === 0) {
    return prompt;
  }

  out += prompt.slice(cursor);
  return out;
}

/**
 * 提示词后处理：仅在聊天补全API下的发送阶段生效，不影响聊天窗口渲染。
 * - 监听CHAT_COMPLETION_PROMPT_READY，处理 eventData.chat[*].content
 * - 在 <framework>...</framework> 类的 xml 块内对 prefix+数字+冒号做连续编号
 *
 * @param {any} ctx
 * @param {{ getState?: () => any }} stateBridge
 * @returns {() => void} cleanup
 */
export function mountPromptPostProcessor(ctx, stateBridge = {}) {
  const eventSource = ctx?.eventSource;
  const eventTypes = ctx?.eventTypes || ctx?.event_types;
  const chatPromptReadyEvent = eventTypes?.CHAT_COMPLETION_PROMPT_READY;

  if (
    !eventSource
    || typeof eventSource.on !== 'function'
    || !chatPromptReadyEvent
  ) {
    console.warn(`${TAG} 未找到酒馆的 eventSource 或 CHAT_COMPLETION_PROMPT_READY，跳过提示词后处理。`);
    return () => {};
  }

  const detach = (eventName, handler) => {
    if (!eventName) return;
    try { eventSource.off?.(eventName, handler); } catch {}
    try { eventSource.removeListener?.(eventName, handler); } catch {}
    try { eventSource.removeEventListener?.(eventName, handler); } catch {}
  };

  const shouldProcess = (state) => {
    if (!state || state.enabled !== true) return false;
    if (state?.cascade?.enabled === false) return false;
    if (state?.cascade?.renumber?.enabled === false) return false;
    return true;
  };

  const buildProcessor = (state) => {
    const tagName = state?.cascade?.renumber?.tagName;
    const prefixes = collectCascadePrefixes(state);
    if (!Array.isArray(prefixes) || prefixes.length === 0) return null;
    return (text) => processFrameworkBlocks(text, tagName, prefixes);
  };

  const handleChatPrompt = (eventData) => {
    try {
      const state = stateBridge?.getState?.();
      if (!shouldProcess(state)) return;

      const chat = eventData?.chat;
      if (!Array.isArray(chat) || chat.length === 0) return;

      const processor = buildProcessor(state);
      if (!processor) return;

      for (const message of chat) {
        if (!message || typeof message !== 'object') continue;

        // 仅处理常见三类role
        const role = message.role;
        if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;

        const content = message.content;

        if (typeof content === 'string' && content) {
          const next = processor(content);
          if (typeof next === 'string' && next !== content) {
            message.content = next; // 原地修改，保持宿主引用不变
          }
          continue;
        }

        // 多模态：content为对象时，尽量只处理文本字段
        if (content && typeof content === 'object' && !Array.isArray(content)) {
          if (typeof content.text === 'string' && content.text) {
            const nextText = processor(content.text);
            if (typeof nextText === 'string' && nextText !== content.text) {
              content.text = nextText;
            }
          } else if (typeof content.content === 'string' && content.content) {
            const nextText = processor(content.content);
            if (typeof nextText === 'string' && nextText !== content.content) {
              content.content = nextText;
            }
          }
          continue;
        }

        // 多模态：content为数组时，只处理 text part
        if (Array.isArray(content)) {
          for (let i = 0; i < content.length; i += 1) {
            const part = content[i];

            if (typeof part === 'string' && part) {
              const nextText = processor(part);
              if (typeof nextText === 'string' && nextText !== part) {
                content[i] = nextText;
              }
              continue;
            }

            if (!part || typeof part !== 'object') continue;

            if (typeof part.text === 'string' && part.text) {
              const nextText = processor(part.text);
              if (typeof nextText === 'string' && nextText !== part.text) {
                part.text = nextText;
              }
            } else if (typeof part.content === 'string' && part.content) {
              const nextText = processor(part.content);
              if (typeof nextText === 'string' && nextText !== part.content) {
                part.content = nextText;
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`${TAG} Chat prompt 后处理失败`, error);
    }
  };

  eventSource.on(chatPromptReadyEvent, handleChatPrompt);

  return () => {
    detach(chatPromptReadyEvent, handleChatPrompt);
  };
}