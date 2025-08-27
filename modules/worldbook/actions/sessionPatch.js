// 会话内应用/回退：仅操作内存文本，暂不进行实际写入世界书
// textA/textB 为原始文本字符串，hunk 为 groupIntoHunks 的元素

export function applyHunkToA(textA, textB, hunk){
  // 将“+”块（来自B的新增）插入到A；若传入“-”则无操作
  if (!hunk || hunk.type !== '+') return { textA, textB };
  const insert = hunk.bText.join('\n');
  return { textA: insertAtA(textA, hunk.aStart, insert), textB };
}

export function applyHunkToB(textA, textB, hunk){
  if (!hunk || hunk.type !== '-') return { textA, textB };
  const insert = hunk.aText.join('\n');
  return { textA, textB: insertAtB(textB, hunk.bStart, insert) };
}

// 简化：按行号在目标文本前插入（aStart/bStart 为首行行号）
function insertAtA(textA, aStart, insert){
  const lines = String(textA ?? '').split('\n');
  const idx = Math.max(0, Math.min(lines.length, aStart-1));
  lines.splice(idx, 0, insert);
  return lines.join('\n');
}
function insertAtB(textB, bStart, insert){
  const lines = String(textB ?? '').split('\n');
  const idx = Math.max(0, Math.min(lines.length, bStart-1));
  lines.splice(idx, 0, insert);
  return lines.join('\n');
}

