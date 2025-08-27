// hunk 分组（基于 ops: ['=',a,b] ['+',null,b] ['-',a,null]）
export function groupIntoHunks(ops){
  const hunks = [];
  let cur = null;
  let aLine = 1, bLine = 1;
  for (const [op, al, bl] of ops){
    if (op==='='){
      // 推进行号
      if (al!=null) aLine++;
      if (bl!=null) bLine++;
      // 结束当前hunk
      cur = null;
      continue;
    }
    const type = op; // '+' or '-'
    const lineTextA = al ?? '';
    const lineTextB = bl ?? '';
    if (!cur || cur.type!==type){
      cur = { id: `h${hunks.length+1}` , type, aStart: aLine, bStart: bLine, aText: [], bText: [], aCount:0, bCount:0 };
      hunks.push(cur);
    }
    cur.aText.push(lineTextA);
    cur.bText.push(lineTextB);
    if (op!=='+' ) cur.aCount++;
    if (op!=='-' ) cur.bCount++;
    if (al!=null) aLine++;
    if (bl!=null) bLine++;
  }
  return hunks;
}

