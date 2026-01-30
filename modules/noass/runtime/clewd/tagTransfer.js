/**
 * @file clewd 标签搬运：把start..end（含标签）搬运到target处
 */

function normalizeTag(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 将第一个startTag..endTag片段（包含标签）从原位置移除，并替换到第一个targetTag 处。
 *
 * - 若找不到startTag：不修改
 * - 若找不到endTag（在startTag之后）：不修改并警告
 * - 若找不到targetTag：不修改并警告
 * - 若 targetTag 落在被搬运片段内部：不修改并警告
 *
 * @param {string} content
 * @param {string} startTag
 * @param {string} endTag
 * @param {string} targetTag
 * @param {{ label?: string }} [options]
 * @returns {string}
 */
export function transferFirstTaggedBlock(content, startTag, endTag, targetTag, options = {}) {
  if (typeof content !== 'string' || !content) return content;

  const normalizedStart = normalizeTag(startTag);
  const normalizedEnd = normalizeTag(endTag);
  const normalizedTarget = normalizeTag(targetTag);
  if (!normalizedStart || !normalizedEnd || !normalizedTarget) return content;

  const startIndex = content.indexOf(normalizedStart);
  if (startIndex === -1) return content;

  const endIndex = content.indexOf(normalizedEnd, startIndex + normalizedStart.length);
  if (endIndex === -1) {
    console.warn('[ST-Diff][noass][transfer] 未找到 endTag，跳过本次搬运', {
      label: options?.label || null,
      startTag: normalizedStart,
      endTag: normalizedEnd,
      targetTag: normalizedTarget,
    });
    return content;
  }

  const segmentEnd = endIndex + normalizedEnd.length;
  const targetIndexInOriginal = content.indexOf(normalizedTarget);
  if (targetIndexInOriginal === -1) {
    console.warn('[ST-Diff][noass][transfer] 未找到 targetTag，跳过本次搬运', {
      label: options?.label || null,
      startTag: normalizedStart,
      endTag: normalizedEnd,
      targetTag: normalizedTarget,
    });
    return content;
  }

  if (targetIndexInOriginal >= startIndex && targetIndexInOriginal < segmentEnd) {
    console.warn('[ST-Diff][noass][transfer] targetTag 位于 start..end 片段内部，跳过本次搬运', {
      label: options?.label || null,
      startTag: normalizedStart,
      endTag: normalizedEnd,
      targetTag: normalizedTarget,
    });
    return content;
  }

  const segment = content.slice(startIndex, segmentEnd);
  const remaining = content.slice(0, startIndex) + content.slice(segmentEnd);

  const targetIndex = remaining.indexOf(normalizedTarget);
  if (targetIndex === -1) {
    console.warn('[ST-Diff][noass][transfer] targetTag 在移除片段后消失，跳过本次搬运', {
      label: options?.label || null,
      startTag: normalizedStart,
      endTag: normalizedEnd,
      targetTag: normalizedTarget,
    });
    return content;
  }

  return (
    remaining.slice(0, targetIndex) +
    segment +
    remaining.slice(targetIndex + normalizedTarget.length)
  );
}

/**
 * 按规则数组顺序，逐条应用标签搬运。
 *
 * @param {string} content
 * @param {Array<{ enabled?: boolean, label?: string, startTag?: string, endTag?: string, targetTag?: string }>} rules
 * @returns {string}
 */
export function applyClewdTagTransferRules(content, rules) {
  if (typeof content !== 'string' || !content) return content;
  if (!Array.isArray(rules) || rules.length === 0) return content;

  let next = content;
  rules.forEach((rule, index) => {
    if (!rule || rule.enabled === false) return;
    const startTag = normalizeTag(rule.startTag);
    const endTag = normalizeTag(rule.endTag);
    const targetTag = normalizeTag(rule.targetTag);
    if (!startTag || !endTag || !targetTag) return;

    next = transferFirstTaggedBlock(next, startTag, endTag, targetTag, {
      label: typeof rule.label === 'string' && rule.label.trim() ? rule.label.trim() : `规则${index + 1}`,
    });
  });

  return next;
}

