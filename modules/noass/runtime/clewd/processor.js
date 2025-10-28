/**
 * @file 基于 clewd 迁移实现的对话合并核心，负责解析 `<regex>` 指令与角色前缀。
 */
import { defaultTemplate } from '../../state/defaults.js';

/**
 * clewd 合并流程核心实现。
 * @param {object} prefixs - 模板前缀配置
 * @param {Array} messages - 待合并的消息数组
 * @param {object} [options]
 * @param {Function} [options.logHandler] - 可选的日志回调，接收 (event, payload)
 * @returns {{ role: string, content: string }}
 */
/**
 * 执行 clewd 风格的消息合并，返回合并后的ass消息。
 *
 * @param {object} prefixs 模板前缀配置
 * @param {Array<{ role: string, content: string, name?: string }>} messages 待合并消息列表
 * @param {{ logHandler?: (event: string, payload?: Record<string, unknown>) => void }} [options] 可选日志钩子
 * @returns {{ role: string, content: string }} 供后续处理的合并结果
 */
export function process(prefixs, messages, options = {}) {
  const { logHandler } = options;
  prefixs = prefixs || defaultTemplate;

  const HyperProcess = function (system, messages, claudeMode) {
    const hyperMerge = function (content, mergeDisable) {
      let splitContent = content.split(
        new RegExp(`\\n\\n(${prefixs.assistant}|${prefixs.user}|${prefixs.system}):`, 'g'),
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
        for (const match of matches) {
          try {
            const reg = /<regex(?: +order *= *\d)?> *"(\/?)(.*)\1(.*?)" *: *"(.*?)" *<\/regex>/.exec(match);
            regexLog += `${match}\n`;
            const replacePattern = new RegExp(reg[2], reg[3]);
            const replacement = JSON.parse(`"${reg[4].replace(/\\?"/g, '\\"')}"`);
            content = content.replace(replacePattern, replacement);
            if (typeof logHandler === 'function') {
              logHandler('hyperRegex:match', { order, match });
            }
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
        'gs',
      );
      const systemPattern2 = new RegExp(`(\\n\\n|^\\s*)${prefixs.system}: *`, 'g');

      content = content
        .replace(systemPattern1, '$1')
        .replace(
          systemPattern2,
          mergeDisable.all || mergeDisable.user || mergeDisable.system ? '$1' : `\n\n${prefixs.user}: `,
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
        .replace(/<\|(\\.*?)\|>/g, function (innerMatch, p1) {
          try {
            return JSON.parse(`"${p1}"`);
          } catch {
            return innerMatch;
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

    for (const message of messages) {
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