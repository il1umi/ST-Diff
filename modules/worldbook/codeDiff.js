// 内容代码Diff 弹窗：行级 + 词级
import { groupIntoHunks } from './actions/hunks.js';
import { applyHunkToA, applyHunkToB } from './actions/sessionPatch.js';


function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function normalizeForOpts(text, opts){
  let t = String(text ?? '');
  if (opts?.jsonNormalize){
    try {
      const parsed = JSON.parse(t);
      const stable = JSON.stringify(parsed, (k,v)=> (v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k2=>[k2,v[k2]])) : v), 2);
      t = stable; // 回写稳定 JSON
    } catch {}
  }
  if (opts?.ignoreWhitespace) t = t.replace(/\s+/g, ' ').trim();
  if (opts?.ignoreCase) t = t.toLowerCase();
  return t;
}

function lcsMatrix(a, b){
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},()=> Array(n+1).fill(0));
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp;
}

function diffLines(aText, bText){
  const a = aText.split('\n');
  const b = bText.split('\n');
  const dp = lcsMatrix(a,b);
  const ops = [];
  let i=a.length, j=b.length;
  while(i>0 || j>0){
    if (i>0 && j>0 && a[i-1]===b[j-1]){ ops.push(['=', a[i-1], b[j-1]]); i--; j--; }
    else if (j>0 && (i===0 || dp[i][j-1] >= dp[i-1][j])){ ops.push(['+', null, b[j-1]]); j--; }
    else { ops.push(['-', a[i-1], null]); i--; }
  }
  return ops.reverse();
}

// 词级拆分结果缓存（会话级/全局级），避免重复计算
const WORD_DIFF_CACHE = new Map();
const WORD_DIFF_CACHE_LIMIT = 400; // 简单的LRU上限

function inlineWordDiff(aLine, bLine){
  // 以“词字符+非词字符”捕获，确保中文/全角标点也能分段
  const splitter = /([^\p{L}\p{N}_]+)/u; // 支持Unicode特性
  const a = aLine.split(splitter);
  const b = bLine.split(splitter);
  const dp = lcsMatrix(a,b);
  const parts = [];
  let i=a.length, j=b.length;
  while(i>0 || j>0){
    if (i>0 && j>0 && a[i-1]===b[j-1]){ parts.push(['=', a[i-1]]); i--; j--; }
    else if (j>0 && (i===0 || dp[i][j-1] >= dp[i-1][j])){ parts.push(['+', b[j-1]]); j--; }
    else { parts.push(['-', a[i-1]]); i--; }
  }
  return parts.reverse();
}
// 根据上下文行数生成折叠视图ops：返回元素为
// ['line', op, aLine, bLine] 或 ['skip', count]
function windowOpsWithSkips(ops, context, expandedSet){
  // 把连续的 '=' 片段聚合
  const blocks = [];
  let buf = [];
  const flushBuf = ()=>{ if (buf.length){ blocks.push(['eq', buf.slice()]); buf.length=0; } };
  for (const item of ops){
    const [op, al, bl] = item;
    if (op==='=') { buf.push(item); }
    else { flushBuf(); blocks.push(['chg', [item]]); }
  }
  flushBuf();

  const out = [];
  for (let i=0;i<blocks.length;i++){
    const [kind, arr] = blocks[i];
    if (kind==='chg'){
      // 变更块：保留，并在其前后按照上下文行数附带相邻相同行
      const prev = blocks[i-1];
      const next = blocks[i+1];
      // 先输出前置上下文（prev 尾部）
      if (prev && prev[0]==='eq'){
        const take = Math.min(context, prev[1].length);
        for (let k=prev[1].length - take; k<prev[1].length; k++){
          const [op, al, bl] = prev[1][k]; out.push(['line', op, al, bl]);
        }
      }
      // 再输出变更块本身
      for (const [op, al, bl] of arr){ out.push(['line', op, al, bl]); }
      // 最后输出后置上下文（next 头部）
      if (next && next[0]==='eq'){
        const take = Math.min(context, next[1].length);
        for (let k=0; k<take; k++){
          const [op, al, bl] = next[1][k]; out.push(['line', op, al, bl]);
        }
      }
    } else {
      // '=' 块：按是否在两侧被取用决定折叠
      // 若前一块或下一块是 chg，则其中一侧已取出 context 行
      // 剩余中间部分折叠
      const prevIsChg = i>0 && blocks[i-1][0]==='chg';
      const nextIsChg = i<blocks.length-1 && blocks[i+1][0]==='chg';
      if (prevIsChg || nextIsChg){
        const usedHead = nextIsChg ? Math.min(context, arr.length) : 0;
        const usedTail = prevIsChg ? Math.min(context, arr.length) : 0;
        const middle = arr.length - usedHead - usedTail;
        if (middle>0){
          const key = `skip-${i}`;
          if (expandedSet && expandedSet.has(key)){
            for (let k=usedTail; k<arr.length-usedHead; k++){
              const [op, al, bl] = arr[k]; out.push(['line', op, al, bl]);
            }
          } else {
            out.push(['skip', middle, key]);
          }
        }
      } else {
        // 文件开始或结尾的 '='：当 context===0（全折叠模式）时也折叠，否则全部显示
        if (context === 0){
          const key = `skip-edge-${i}`;
          if (expandedSet && expandedSet.has(key)){
            for (const [op, al, bl] of arr){ out.push(['line', op, al, bl]); }
          } else {
            out.push(['skip', arr.length, key]);
          }
        } else {
          for (const [op, al, bl] of arr){ out.push(['line', op, al, bl]); }
        }
      }
    }
  }
  return out;
}


function renderSideBySide(ops, { context=3, wrap=true, lineNumber=true, collapse=true }={}, expanded, hunksParam=[]){
  // S1：左右各自滚动的两列布局
  const rowsLeft = [];
  const rowsRight = [];
  let aIdx=1, bIdx=1;
  const cssWrap = wrap ? 'white-space:pre-wrap;word-break:break-word;' : 'white-space:pre;overflow-x:auto;';
  const items = collapse ? windowOpsWithSkips(ops, context, expanded) : ops.map(([op,al,bl])=>['line', op, al, bl]);
  // 统一依赖预计算的 hunks

  // 基于 hunks 渲染：先生成一个 Map 标记首行
  const hunkHeadByAB = new Map(); // key: `${aIdx}|${bIdx}`
  const hunksLocal = Array.isArray(hunksParam) ? hunksParam : [];
  for (const h of hunksLocal){
    const key = `${h.aStart}|${h.bStart}`;
    hunkHeadByAB.set(key, h);
  }

  for (const item of items){
    if (item[0]==='skip'){
      const count = item[1]; const key = item[2];
      rowsLeft.push(`<tr class="skip"><td colspan="${lineNumber?2:1}" style="text-align:center; color:var(--SmartThemeBorderColor,#777); cursor:pointer;" data-skip-key="${key}">… 展开${count}行 …</td></tr>`);
      rowsRight.push(`<tr class="skip"><td colspan="${lineNumber?2:1}" style="text-align:center; color:var(--SmartThemeBorderColor,#777); cursor:pointer;" data-skip-key="${key}">… 展开${count}行 …</td></tr>`);
      // 跳过的都是 '=' 行，A/B 两侧行号同步前进
      aIdx += count; bIdx += count;
      continue;
    }
    const [, op, al, bl] = item;
    const cls = op==='='? '' : (op==='+'? 'added':'removed');
    // 并列模式词级（仅文字着色，针对变更行）
    let left = esc(al ?? '');
    let right = esc(bl ?? '');
    if (cls){
      const parts = (function(a,b){
        const key = `${a}\n→\n${b}`;
        if (WORD_DIFF_CACHE.has(key)) return WORD_DIFF_CACHE.get(key);
        const p = inlineWordDiff(a,b);
        try { if (WORD_DIFF_CACHE.size >= WORD_DIFF_CACHE_LIMIT) { const firstKey = WORD_DIFF_CACHE.keys().next().value; WORD_DIFF_CACHE.delete(firstKey); } } catch{}
        WORD_DIFF_CACHE.set(key, p);
        return p;
      })(al||'', bl||'');
      // 左侧展示“删减”
      left = parts.map(([k,t])=> k==='-' ? `<span class="w-removed" style="color: var(--stdiff-word-color-removed,#ff4d4f) !important; font-weight:600;">${esc(t)}</span>` : esc(t)).join('');
      // 右侧展示“新增”
      right = parts.map(([k,t])=> k==='+' ? `<span class="w-added" style="color: var(--stdiff-word-color-added,#2ecc71) !important; font-weight:600;">${esc(t)}</span>` : esc(t)).join('');
    }
    const bgStyle = cls==='added' ? 'background-color: var(--stdiff-bg-added, rgba(26,127,55,0.18)) !important; background-clip:padding-box;' : (cls==='removed' ? 'background-color: var(--stdiff-bg-removed, rgba(180,35,24,0.18)) !important; background-clip:padding-box;' : '');
    // hunk 首行才渲染按钮：仅在变更行(op!=='=')时判定
    const hHead = (cls ? hunkHeadByAB.get(`${aIdx}|${bIdx}`) : null);
    const showToA = !!(cls && hHead && hHead.type==='+' );
    const showToB = !!(cls && hHead && hHead.type==='-' );
    if (lineNumber){
      const lnA = (op==='+'? '' : aIdx);
      const lnB = (op==='-'? '' : bIdx);
      rowsLeft.push(`<tr class="${cls}"><td class="ln a" style="width:40px; text-align:right; color:var(--SmartThemeBorderColor,#777); padding-right:8px; white-space:nowrap; vertical-align:top;">${lnA}</td><td class="code ${cls}" style="${bgStyle}${cssWrap} position:relative; vertical-align:top; min-height:1.4em; ${showToA? 'padding-right:56px;' : ''}">${left}${showToA? `<div class=\"stdiff-hunk-action toA\" data-hunk-id=\"row${aIdx}_${bIdx}\" title=\"将此新增段落插入到世界书A（本会话暂存）\" style=\"position:absolute; top:2px; right:6px; z-index:3; background: var(--stdiff-bg-added, rgba(26,127,55,0.18)); color: var(--green-4,#1a7f37); border:1px dashed var(--SmartThemeBorderColor,#555); border-radius:4px; padding:2px 6px; cursor:pointer;\">应用</div>`:''}</td></tr>`);
      rowsRight.push(`<tr class="${cls}"><td class="ln b" style="width:40px; text-align:right; color:var(--SmartThemeBorderColor,#777); padding-right:8px; white-space:nowrap; vertical-align:top;">${lnB}</td><td class="code ${cls}" style="${bgStyle}${cssWrap} position:relative; vertical-align:top; min-height:1.4em; ${showToB? 'padding-right:56px;' : ''}">${right}${showToB? `<div class=\"stdiff-hunk-action toB\" data-hunk-id=\"row${aIdx}_${bIdx}\" title=\"将此缺失段落插入到世界书B（本会话暂存）\" style=\"position:absolute; top:2px; right:6px; z-index:3; background: var(--stdiff-bg-removed, rgba(180,35,24,0.18)); color: var(--red-4,#b42318); border:1px dashed var(--SmartThemeBorderColor,#555); border-radius:4px; padding:2px 6px; cursor:pointer;\">应用</div>`:''}</td></tr>`);
    } else {
      rowsLeft.push(`<tr class="${cls}"><td class="code ${cls}" style="${bgStyle}${cssWrap} position:relative; min-height:1.4em; ${showToA? 'padding-right:56px;' : ''}">${left}${showToA? `<div class=\"stdiff-hunk-action toA\" data-hunk-id=\"row${aIdx}_${bIdx}\" title=\"将此新增段落插入到世界书A（本会话暂存）\" style=\"position:absolute; top:2px; right:6px; z-index:3; background: var(--stdiff-bg-added, rgba(26,127,55,0.18)); color: var(--green-4,#1a7f37); border:1px dashed var(--SmartThemeBorderColor,#555); border-radius:4px; padding:2px 6px; cursor:pointer;\">应用</div>`:''}</td></tr>`);
      rowsRight.push(`<tr class="${cls}"><td class="code ${cls}" style="${bgStyle}${cssWrap} position:relative; min-height:1.4em; ${showToB? 'padding-right:56px;' : ''}">${right}${showToB? `<div class=\"stdiff-hunk-action toB\" data-hunk-id=\"row${aIdx}_${bIdx}\" title=\"将此缺失段落插入到世界书B（本会话暂存）\" style=\"position:absolute; top:2px; right:6px; z-index:3; background: var(--stdiff-bg-removed, rgba(180,35,24,0.18)); color: var(--red-4,#b42318); border:1px dashed var(--SmartThemeBorderColor,#555); border-radius:4px; padding:2px 6px; cursor:pointer;\">应用</div>`:''}</td></tr>`);
    }
    if (op!=='+' ) aIdx++;
    if (op!=='-' ) bIdx++;
  }

  const colgroup = lineNumber
    ? '<col style="width:40px"><col style="width:auto">'
    : '<col style="width:auto">';

  // 使用包裹容器，给每侧独立滚动条
  return `
  <div class="stdiff-side-wrapper" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; height: calc(var(--stdiff-code-height,70vh));">
    <div class="pane left" style="overflow:auto; height:100%;">
      <table class="stdiff-code side left" style="width:100%; table-layout:fixed; border-collapse:collapse;">
        <colgroup>${colgroup}</colgroup>
        <tbody>${rowsLeft.join('')}</tbody>
      </table>
    </div>
    <div class="pane right" style="overflow:auto; height:100%;">
      <table class="stdiff-code side right" style="width:100%; table-layout:fixed; border-collapse:collapse;">
        <colgroup>${colgroup}</colgroup>
        <tbody>${rowsRight.join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function renderInline(ops, { context=3, wrap=true, lineNumber=true, collapse=true, wordEnable=true, wordLongThreshold=2000, wordStyle='color' }={}, expanded){
  const rows = [];
  let aIdx=1, bIdx=1;
  const cssWrap = wrap ? 'white-space:pre-wrap;word-break:break-word;' : 'white-space:pre;overflow-x:auto;';
  const items = collapse ? windowOpsWithSkips(ops, context, expanded) : ops.map(([op,al,bl])=>['line', op, al, bl]);
  for (const item of items){
    if (item[0]==='skip'){
      const count = item[1]; const key = item[2];
      rows.push(`<div class=\"row skip\" data-skip-key=\"${key}\" style=\"text-align:center; color:var(--SmartThemeBorderColor,#777); cursor:pointer;\">… 展开${count}行 …</div>`);
      continue;
    }
    const [, op, al, bl] = item;
    const cls = op==='='? '' : (op==='+'? 'added' : 'removed');
    const ln = op==='+' ? bIdx : aIdx;
    // 内联模式：可选词级高亮（仅针对变更行）
    let content = op==='+' ? esc(bl||'') : esc(al||'');
    // 在内联模式上，对变更行做词级高亮（仅在开启且非超长行时）
    if (wordEnable && cls && Math.max((al||'').length, (bl||'').length) <= wordLongThreshold){
      const parts = (function(a,b){
        const key = `${a}\n→\n${b}`;
        if (WORD_DIFF_CACHE.has(key)) return WORD_DIFF_CACHE.get(key);
        const p = inlineWordDiff(a,b);
        try { if (WORD_DIFF_CACHE.size >= WORD_DIFF_CACHE_LIMIT) { const firstKey = WORD_DIFF_CACHE.keys().next().value; WORD_DIFF_CACHE.delete(firstKey); } } catch{}
        WORD_DIFF_CACHE.set(key, p);
        return p;
      })(al||'', bl||'');
      // 根据本行的角色（+/-）重建内容
      if (op==='-'){
        content = parts.map(([k,t])=> {
          if (k!=='-') return esc(t);
          if (wordStyle==='color') return `<span class="w-removed" style="color: var(--stdiff-word-color-removed,#ff4d4f) !important; font-weight:600;">${esc(t)}</span>`;
          return `<span class="w-removed">${esc(t)}</span>`;
        }).join('');
      } else if (op==='+'){
        content = parts.map(([k,t])=> {
          if (k!=='+' ) return esc(t);
          if (wordStyle==='color') return `<span class="w-added" style="color: var(--stdiff-word-color-added,#2ecc71) !important; font-weight:600;">${esc(t)}</span>`;
          return `<span class="w-added">${esc(t)}</span>`;
        }).join('');
      }
    }

    if (lineNumber){
      const sign = op==='+' ? '&plus;' : (op==='-' ? '&minus;' : '&nbsp;');
      const signColor = op==='+' ? 'var(--green-4,#1a7f37)' : (op==='-' ? 'var(--red-4,#b42318)' : 'inherit');
      const bgStyle = cls==='added' ? 'background-color: var(--stdiff-bg-added, rgba(26,127,55,0.18)) !important; background-clip:padding-box;' : (cls==='removed' ? 'background-color: var(--stdiff-bg-removed, rgba(180,35,24,0.18)) !important; background-clip:padding-box;' : '');
      rows.push(`<div class="row ${cls}" style="display:grid; grid-template-columns: max-content 1fr; column-gap:8px; align-items:start;">
        <span class="ln" style="display:flex; justify-content:space-between; align-items:baseline; padding:0 4px; color:var(--SmartThemeBorderColor,#777); white-space:nowrap;"><span class="sign" style="color:${signColor}; min-width:14px; text-align:left; font-weight:600;">${sign}</span><span class="num">${ln}</span></span>
        <div class="code ${cls}" style="${bgStyle}${cssWrap}">${content}</div>
      </div>`);
    } else {
      const prefix = op==='+' ? '<span style="color:var(--green-4,#1a7f37)">+</span> ' : (op==='-' ? '<span style="color:var(--red-4,#b42318)">-</span> ' : '');
      rows.push(`<div class="row ${cls}" style="${cssWrap}">${prefix}${content}</div>`);
    }
    if (op!=='+' ) aIdx++;
    if (op!=='-' ) bIdx++;
  }
  return `<div class="stdiff-code inline">${rows.join('')}</div>`;
}

export async function openCodeDiffDialog(ctx, aValue, bValue, opts){
  const $ = window.jQuery || window.$;
  const html = await ctx.renderExtensionTemplateAsync('third-party/ST-Diff/modules/worldbook/templates','code_diff');
  const $dlg = $(html);
  const $container = $dlg.find('.stdiff-code-container');
  // 让内层容器填满弹窗可用宽度
  try { $dlg.css({ width:'100%', maxWidth:'none' }); $container.css({ width:'100%' }); } catch{}

  // 读取并应用用户自定义样式（高度/字体/颜色方案）
  try {
    const settings = (ctx.extensionSettings || window.extension_settings || {} )['st-diff'] || {};
    let heightPref = settings?.ui?.codeHeight || '70vh';
    if (!['70vh','85vh'].includes(heightPref)) { heightPref = '70vh'; try { settings.ui = settings.ui || {}; settings.ui.codeHeight = heightPref; } catch{} }
    const fontPref = settings?.ui?.codeFontSize || '12px';
    const scheme = settings?.ui?.codeScheme || 'classic';
    const colAdded = settings?.ui?.codeColorAdded || '#1a7f37';
    const colRemoved = settings?.ui?.codeColorRemoved || '#b42318';
    const wordColAdded = settings?.ui?.wordColorAdded || '#2ecc71';
    const wordColRemoved = settings?.ui?.wordColorRemoved || '#ff4d4f';
    $container[0]?.style?.setProperty('--stdiff-code-height', heightPref);
    $container[0]?.style?.setProperty('--stdiff-code-fontsize', fontPref);
    // 经典方案用透明度背景，custom 方案用用户色（带透明度）
    const toRGBA = (hex, alpha=0.18)=>{ try { const v=hex.replace('#',''); const r=parseInt(v.slice(0,2),16); const g=parseInt(v.slice(2,4),16); const b=parseInt(v.slice(4,6),16); return `rgba(${r},${g},${b},${alpha})`; } catch{return hex;} };
    const bgAdded = scheme==='classic' ? 'rgba(26,127,55,0.18)' : toRGBA(colAdded, 0.18);
    const bgRemoved = scheme==='classic' ? 'rgba(180,35,24,0.18)' : toRGBA(colRemoved, 0.18);
    $container[0]?.style?.setProperty('--stdiff-bg-added', bgAdded);
    $container[0]?.style?.setProperty('--stdiff-bg-removed', bgRemoved);
    // 词级样式变量
    const wordBgAdded = toRGBA(wordColAdded, 0.22);
    const wordBgRemoved = toRGBA(wordColRemoved, 0.22);
  // 为了确保 makeOps 在 render 闭包可见，这里定义在 openCodeDiffDialog 作用域顶层

    // 唯一风格：文字着色
    $container.removeClass('underline bg').addClass('color');
    $container[0]?.style?.setProperty('--stdiff-word-bg-added', wordBgAdded);

    $container[0]?.style?.setProperty('--stdiff-word-bg-removed', wordBgRemoved);
    $container[0]?.style?.setProperty('--stdiff-word-underline-added', wordColAdded);
    $container[0]?.style?.setProperty('--stdiff-word-underline-removed', wordColRemoved);
    $container[0]?.style?.setProperty('--stdiff-word-color-added', wordColAdded);
    $container[0]?.style?.setProperty('--stdiff-word-color-removed', wordColRemoved);
  } catch {}

  const aNorm = normalizeForOpts(aValue, opts);
  // 会话内状态（仅正处理的弹窗存活期间有效）
  const sessionState = { meta: opts?.meta || {}, originalA: aValue, originalB: bValue, textA: aValue, textB: bValue, applied: new Map(), history: {A:[], B:[]} };
  // 计算 ops/hunks：确保在 render 可见
  const makeOps = (A,B)=> diffLines(normalizeForOpts(A, opts), normalizeForOpts(B, opts));
  let currentHunks = [];


  const bNorm = normalizeForOpts(bValue, opts);
  // 基线diff：始终以原始文本为基线渲染（会话内应用不影响对比色）
  const baseOps = makeOps(aValue, bValue);
  const baseHunks = groupIntoHunks(baseOps);
  // 应用记录：使用 Map 记录 key->side以及动作栈用于撤销上一步
  sessionState.applied = new Map();
  sessionState.actionStack = [];

  // 折叠展开状态（仅正处理的弹窗会话内生效）
  let expandedSet = new Set();

  const render = ()=>{
  // 工具栏：撤销上一步/全部 与计数（定义在外层作用域，供点击回调使用）
  const refreshToolbar = ()=>{
    try {
      const aN = sessionState.history.A.length;
      const bN = sessionState.history.B.length;
      const total = aN + bN;
      $dlg.find('#stdiff-applied-count').text(String(total));
      $dlg.find('#stdiff-undo-last').prop('disabled', total===0);
      $dlg.find('#stdiff-undo-all').prop('disabled', total===0);
    } catch{}
  };

    const mode = $dlg.find('input[name="stdiff-code-view"]:checked').val();
    const context = Math.max(0, parseInt($dlg.find('#stdiff-code-context').val(),10)||0);
    const wrap = true; // 仅支持自动换行
    const lineNumber = $dlg.find('#stdiff-code-linenum').prop('checked');
    const sync = $dlg.find('#stdiff-code-sync').prop('checked');
    const collapse = $dlg.find('#stdiff-code-collapse').prop('checked');
    // 记忆上下文行数
    try {
      const root = ctx.extensionSettings || window.extension_settings || {};
      root['st-diff'] = root['st-diff'] || { ui:{} };
      root['st-diff'].ui = root['st-diff'].ui || {};
      root['st-diff'].ui.codeContext = context;
      (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
    // 使用会话中的最新文本重新计算 diff 与 hunks
    const aNow = sessionState.textA;
    const bNow = sessionState.textB;
    const ops = makeOps(aNow, bNow);
    currentHunks = groupIntoHunks(ops);

    } catch{}

    // 渲染（带折叠/展开状态）
    const s = (ctx.extensionSettings || window.extension_settings || {})['st-diff']?.ui || {};
    // 词级开关以UI即时状态为准，避免等待持久化导致不同步
    const wordEnable = $dlg.find('#stdiff-word-enable').prop('checked');
    const wordLongThreshold = s.wordLongThreshold || 2000;
    // 渲染始终基于基线差异（避免会话内暂存影响对比色）
    const html = mode==='inline' ? renderInline(baseOps, { context, wrap, lineNumber, collapse, wordEnable, wordLongThreshold }, expandedSet)
                                 : renderSideBySide(baseOps, { context, wrap, lineNumber, collapse }, expandedSet, baseHunks);
    $container.html(html);

    // 初始化与绑定撤销按钮（每次渲染刷新绑定）
    refreshToolbar();
    $dlg.off('click.stdUndoLast').on('click.stdUndoLast','#stdiff-undo-last', function(){
      const last = sessionState.actionStack.pop();
      if (!last) return;
      if (last.side==='A'){
        const stack = sessionState.history.A;
        if (stack && stack.length){ sessionState.textA = stack.pop(); }
      } else {
        const stack = sessionState.history.B;
        if (stack && stack.length){ sessionState.textB = stack.pop(); }
      }
      render();
    });
    $dlg.off('click.stdUndoAll').on('click.stdUndoAll','#stdiff-undo-all', function(){
      if (sessionState.history.A.length){ sessionState.textA = sessionState.history.A[0]; }
      if (sessionState.history.B.length){ sessionState.textB = sessionState.history.B[0]; }
      sessionState.history.A = [];
      sessionState.history.B = [];
      render();
    });

    // 点击展开占位（仅正处理的弹窗会话有效）
    $container.off('click.stdifffold').on('click.stdifffold','[data-skip-key]', function(){
      const key = $(this).attr('data-skip-key');
      expandedSet.add(key);
      render();
    });

    // 并列模式下绑定/解绑同步滚动
    if (mode==='side'){
      try {
        const left = $container.find('.stdiff-side-wrapper .pane.left')[0];
        const right = $container.find('.stdiff-side-wrapper .pane.right')[0];
        if (left && right){
          left._syncing = right._syncing = false;
          const handler = (src, dst)=>{
            if (!sync) return;
            return ()=>{
              if (src._syncing) return;
              src._syncing = true;
              const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
              dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
              src._syncing = false;

            };
          };
          left.addEventListener('scroll', handler(left, right));
          right.addEventListener('scroll', handler(right, left));
        }
      } catch{}
    }
    // 绑定“应用/回退”（会话内暂存）
    $container.off('click.stdiffapply').on('click.stdiffapply', '.stdiff-hunk-action', function(){
      const $btn = $(this);
      const to = $btn.hasClass('toA') ? 'A' : ($btn.hasClass('toB') ? 'B' : null);
      if (!to) return;
      // 从 data-hunk-id 解析 hunk 行锚（row{aIdx}_{bIdx}）并定位 hunk 头
      const id = $btn.attr('data-hunk-id') || '';
      const m = id.match(/^row(\d+)_([\d]+)/);
      const aStart = m ? parseInt(m[1],10) : 1;
      const bStart = m ? parseInt(m[2],10) : 1;
      const keyStr = `${aStart}|${bStart}`;
    // 初始化与绑定撤销按钮

    $dlg.off('click.stdUndoAll').on('click.stdUndoAll','#stdiff-undo-all', function(){
      if (sessionState.history.A.length){ sessionState.textA = sessionState.history.A[0]; }
      if (sessionState.history.B.length){ sessionState.textB = sessionState.history.B[0]; }
      sessionState.history.A = [];
      sessionState.history.B = [];
      render();
    });

      const headHunk = currentHunks.find(h => (h.aStart===aStart) || (typeof bStart!=='undefined' && h.bStart===bStart));
      if ($btn.hasClass('applied')){
        // 回退
        const stack = sessionState.history[to];
        if (stack && stack.length){
          const prev = stack.pop();
          if (to==='A') sessionState.textA = prev; else sessionState.textB = prev;
        }
        $btn.removeClass('applied').text('应用');
        try { sessionState.applied.delete(keyStr); } catch{}
        refreshToolbar();
      } else {
        // 应用（基于 hunk 文本而非 DOM 遍历）
        if (!headHunk) return;
        if (to==='A'){
          sessionState.history.A.push(sessionState.textA);
          const r = applyHunkToA(sessionState.textA, sessionState.textB, headHunk);
          sessionState.textA = r.textA;
        } else {
          sessionState.history.B.push(sessionState.textB);
          const r = applyHunkToB(sessionState.textA, sessionState.textB, headHunk);
          sessionState.textB = r.textB;
        }
        try { sessionState.applied.set(keyStr, to); sessionState.actionStack.push({ side: to, hunk: headHunk, key: keyStr }); } catch{}
        $btn.addClass('applied').text('回退');
        refreshToolbar();
      }
      // 避免立即重渲染导致按钮与色块闪烁/消失，这里不进行刷新视图；需要时可通过顶部“撤销上一步/全部”触发视图刷新
    });
  };

  // 高度/字号/同步设置：监听并写回设置
  try {
    $dlg.on('change', '#stdiff-code-height', function(){
      const v = $(this).val();
      $container[0]?.style?.setProperty('--stdiff-code-height', v);
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeHeight = v;
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
    });

    // 调色板开关按钮（旧绑定移除，改用下方带日志的实现）
    $dlg.off('click', '#stdiff-toggle-palette');
    // 词级设置变更（仅开关）
    $dlg.on('change', '#stdiff-word-enable', function(){
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.wordEnable = $dlg.find('#stdiff-word-enable').prop('checked');
        // 固定风格：文字着色，无需保存 wordStyle
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      // 仅根据开关切换类（风格固定为color）
      $container.addClass('color');
      // 直接重新渲染以应用风格
      render();
    });
    $dlg.on('input', '#stdiff-word-color-removed,#stdiff-word-color-added', function(){
      const ca = $dlg.find('#stdiff-word-color-added').val();
      const cr = $dlg.find('#stdiff-word-color-removed').val();
      $dlg.find('#swatch-word-added').css('background', ca);
      $dlg.find('#swatch-word-removed').css('background', cr);
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.wordColorAdded = ca;
        root['st-diff'].ui.wordColorRemoved = cr;
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      // 更新CSS变量以便立即生效
      const toRGBA = (hex, alpha=0.22)=>{ try { const v=hex.replace('#',''); const r=parseInt(v.slice(0,2),16); const g=parseInt(v.slice(2,4),16); const b=parseInt(v.slice(4,6),16); return `rgba(${r},${g},${b},${alpha})`; } catch{return hex;} };
      $container[0]?.style?.setProperty('--stdiff-word-bg-added', toRGBA(ca,0.22));
      $container[0]?.style?.setProperty('--stdiff-word-bg-removed', toRGBA(cr,0.22));
      $container[0]?.style?.setProperty('--stdiff-word-underline-added', ca);
      $container[0]?.style?.setProperty('--stdiff-word-underline-removed', cr);
    });

    // 初始化调色板
    try {
      const s = (ctx.extensionSettings || window.extension_settings || {})['st-diff']?.ui || {};
      $dlg.find('#stdiff-word-enable').prop('checked', s.wordEnable !== false);
      // 固定风格：文字着色
      const ca = s.wordColorAdded || '#2ecc71';
      const cr = s.wordColorRemoved || '#ff4d4f';
      $dlg.find('#stdiff-word-color-added').val(ca);
      $dlg.find('#stdiff-word-color-removed').val(cr);
      $dlg.find('#swatch-word-added').css('background', ca);
      $dlg.find('#swatch-word-removed').css('background', cr);
    } catch{}
    $dlg.on('change', '#stdiff-code-fontsize', function(){
      const v = $(this).val();
      $container[0]?.style?.setProperty('--stdiff-code-fontsize', v);
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeFontSize = v;
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
    });
    $dlg.on('click', '#stdiff-toggle-palette', function(ev){
      try {
        console.log('[ST-Diff] toggle palette clicked', { target: ev.currentTarget });
        const $p = $dlg.find('#stdiff-palette');
        console.log('[ST-Diff] palette node exists?', !!$p.length, $p[0]);
        if ($p && $p.length) {
          const visCss = $p.css('display');
          const vis = visCss !== 'none';
          console.log('[ST-Diff] palette current display:', visCss, '->', vis ? 'none' : 'block');
          $p.css('display', vis ? 'none' : 'block');
          console.log('[ST-Diff] palette new display:', $p.css('display'));
        } else {
          console.warn('[ST-Diff] palette element not found');
        }
      } catch (e) { try { console.warn('[ST-Diff] palette toggle failed', e); } catch{} }
    });
    // 词级设置变更（仅开关）
    // 词级设置变更（仅开关）
    $dlg.on('change', '#stdiff-word-enable', function(){
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.wordEnable = $dlg.find('#stdiff-word-enable').prop('checked');
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      render();
    });

    // 监听视图模式切换（并列/内联）
    $dlg.on('change', 'input[name="stdiff-code-view"]', function(){
      render();
    });


    $dlg.on('change', '#stdiff-code-fontsize', function(){
      const v = $(this).val();
      $container[0]?.style?.setProperty('--stdiff-code-fontsize', v);
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeFontSize = v;
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
    });
    $dlg.on('change', '#stdiff-code-sync', function(){
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeSync = $(this).prop('checked');
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
    });
    $dlg.on('change', '#stdiff-code-scheme', function(){
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeScheme = $(this).val();
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      // 切换显示自定义色控件
      const useCustom = $(this).val()==='custom';
      $dlg.find('#stdiff-custom-colors').toggle(useCustom);
      // 立即应用颜色
      $dlg.find('#stdiff-color-removed').trigger('input');
      $dlg.find('#stdiff-color-added').trigger('input');
    });
    $dlg.on('input', '#stdiff-color-removed, #stdiff-color-added', function(){
      const colAdded = $dlg.find('#stdiff-color-added').val();
      const colRemoved = $dlg.find('#stdiff-color-removed').val();
      // 更新示意色块
      $dlg.find('#swatch-added').css('background', colAdded);
      $dlg.find('#swatch-removed').css('background', colRemoved);
      // 写设置
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeColorAdded = colAdded;
        root['st-diff'].ui.codeColorRemoved = colRemoved;
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      // 应用到容器背景变量
      const toRGBA = (hex, alpha=0.18)=>{ try { const v=hex.replace('#',''); const r=parseInt(v.slice(0,2),16); const g=parseInt(v.slice(2,4),16); const b=parseInt(v.slice(4,6),16); return `rgba(${r},${g},${b},${alpha})`; } catch{return hex;} };
      $container[0]?.style?.setProperty('--stdiff-bg-added', toRGBA(colAdded, 0.18));
      $container[0]?.style?.setProperty('--stdiff-bg-removed', toRGBA(colRemoved, 0.18));
    });
    $dlg.on('change', '#stdiff-code-collapse', function(){
      try {
        const root = ctx.extensionSettings || window.extension_settings || {};
        root['st-diff'] = root['st-diff'] || { ui:{} };
        root['st-diff'].ui = root['st-diff'].ui || {};
        root['st-diff'].ui.codeCollapse = $(this).prop('checked');
        (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
      } catch {}
      // 切换为“折叠”时清空本会话的展开集合，强制全部重新折叠
      expandedSet = new Set();
      render();
    });

    // 初始化控件值
    const curH = getComputedStyle($container[0]).getPropertyValue('--stdiff-code-height')?.trim() || '70vh';
    const curF = getComputedStyle($container[0]).getPropertyValue('--stdiff-code-fontsize')?.trim() || '12px';
    const s = (ctx.extensionSettings || window.extension_settings || {})['st-diff'] || {};
    $dlg.find('#stdiff-code-height').val(curH);
    $dlg.find('#stdiff-code-fontsize').val(curF);
    $dlg.find('#stdiff-code-sync').prop('checked', s?.ui?.codeSync !== false); // 默认开启
    $dlg.find('#stdiff-code-collapse').prop('checked', s?.ui?.codeCollapse !== false); // 默认折叠
    $dlg.find('#stdiff-code-scheme').val(s?.ui?.codeScheme || 'classic');
    const useCustom = (s?.ui?.codeScheme || 'classic')==='custom';
    $dlg.find('#stdiff-custom-colors').toggle(useCustom);
    if (useCustom){
      const ca = s?.ui?.codeColorAdded || '#1a7f37';
      const cr = s?.ui?.codeColorRemoved || '#b42318';
      $dlg.find('#stdiff-color-added').val(ca);
      $dlg.find('#stdiff-color-removed').val(cr);
      $dlg.find('#swatch-added').css('background', ca);
      $dlg.find('#swatch-removed').css('background', cr);
    }
  } catch{}

  $dlg.off('change input', 'input,select');
  $dlg.on('change', 'input,select', render);
  render();

  // 绑定“清除缓存”按钮：清理词级缓存与B侧预取快照
  try {
    $dlg.on('click', '#stdiff-clear-cache', function(){
      try {
        // 1) 词级缓存
        if (typeof WORD_DIFF_CACHE?.clear === 'function') WORD_DIFF_CACHE.clear();
      } catch{}
      try {
        // 2) 预取快照（B）
        const root = ctx.extensionSettings || window.extension_settings || {};
        if (root['st-diff']){
          root['st-diff'].worldinfo = root['st-diff'].worldinfo || {};
          delete root['st-diff'].worldinfo.cachedB;
          root['st-diff'].worldinfo.cacheBustedAt = Date.now();
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
        }
      } catch{}
      try { if (window.STDiff && window.STDiff.cachedB) delete window.STDiff.cachedB; } catch{}
      try {
        alert('缓存已清除：\n- 词级差异缓存\n- 预取快照（B）\n\n请关闭本弹窗并重新点击“展开对比”以从最新数据重算。');
      } catch{}
    });
  } catch{}

  // 绑定“保存A/B/全部”
  try {
    async function doSave({ only }={}){
      const meta = sessionState.meta || {};
      const inferA = ()=>{
        try{
          const all = Array.from(document.querySelectorAll('select'));
          for (const s of all){ const t = s.options?.[0]?.textContent?.trim()||''; if (/选择以编辑|Select\s*to\s*edit/i.test(t)) { const txt = s.options?.[s.selectedIndex]?.textContent?.trim()||''; return txt || s.value || ''; } }
          const s = document.querySelector('#world_editor_select');
          if (s){ const txt = s.options?.[s.selectedIndex]?.textContent?.trim()||''; return txt || s.value || ''; }
        } catch{}
        return '';
      };
      const inferB = ()=>{
        try{ const v = document.querySelector('#stdiff-worldbook-b')?.value || ''; if (v) return v; } catch{}
        try{ const root = ctx.extensionSettings || window.extension_settings || {}; const v = root?.['st-diff']?.worldinfo?.lastSelectedB || ''; if (v) return v; } catch{}
        try{ const v = window.STDiff?.cachedB?.name || ''; if (v) return v; } catch{}
        return '';
      };

      const bookA = meta.bookAName || inferA();
      const bookB = meta.bookBName || inferB();
      const key = meta.entryKey || '';
      const curA = sessionState.textA;
      const curB = sessionState.textB;
      const origA = sessionState.originalA;
      const origB = sessionState.originalB;
      let savedA=false, savedB=false, errA='', errB='';
      try {
        const repo = await import('./repo.js');
        const api = repo.createWorldbookRepo(ctx);
        if (only!=='B' && bookA && key && curA!==origA){
          const r = await api.writeEntryValue(bookA, key, curA, (ctx.extensionSettings||window.extension_settings||{})['st-diff']?.ui || {});
          savedA = !!r?.ok; errA = r?.reason||''; if (r?.verified===false) errA = errA || 'verify_failed';
        }
        if (only!=='A' && bookB && key && curB!==origB){
          const r2 = await api.writeEntryValue(bookB, key, curB, (ctx.extensionSettings||window.extension_settings||{})['st-diff']?.ui || {});
          savedB = !!r2?.ok; errB = r2?.reason||''; if (r2?.verified===false) errB = errB || 'verify_failed';
        }
      } catch(e){ errA = errA || e?.message; errB = errB || e?.message; }

      const msgs = [];
      if (only!=='B' && curA!==origA) msgs.push(savedA? `A已保存并验证(${bookA||'未知世界书'})` : `A保存失败(${bookA||'未知世界书'}): ${errA||'未知错误'}`);
      if (only!=='A' && curB!==origB) msgs.push(savedB? `B已保存并验证(${bookB||'未知世界书'})` : `B保存失败(${bookB||'未知世界书'}): ${errB||'未知错误'}`);
      if (!msgs.length) msgs.push('没有改动需要保存，或受only参数限制未执行。');

      // 持久化“已保存”标记（按 A|B 组合 + entryKey）
      try {
        if ((savedA && curA!==origA) || (savedB && curB!==origB)){
          const root = ctx.extensionSettings || window.extension_settings || {};
          root['st-diff'] = root['st-diff'] || { ui:{}, worldinfo:{} };
          root['st-diff'].worldinfo = root['st-diff'].worldinfo || {};
          const pair = `${bookA||''}||${bookB||''}`;
          const arr = Array.isArray(root['st-diff'].worldinfo.savedMarks?.[pair]) ? root['st-diff'].worldinfo.savedMarks[pair] : [];
          if (!root['st-diff'].worldinfo.savedMarks) root['st-diff'].worldinfo.savedMarks = {};
          if (!arr.includes(key)) arr.push(key);
          root['st-diff'].worldinfo.savedMarks[pair] = arr;
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
        }
      } catch{}

      try { alert(msgs.join('\n')); } catch{}
    }

    $dlg.on('click', '#stdiff-save-all', async function(){ await doSave({}); });
    $dlg.on('click', '#stdiff-save-A', async function(){ await doSave({ only:'A' }); });
    $dlg.on('click', '#stdiff-save-B', async function(){ await doSave({ only:'B' }); });

  } catch{}

  // 弹窗：先触发显示，再在下一事件循环中扩展外层弹窗宽度
  const popupPromise = ctx.callGenericPopup($dlg, '内容代码对比', undefined, { wide: true });
  try {
    setTimeout(() => {
      try {
        // SillyTavern 经典弹窗容器
        const $dp = $('#dialogue_popup .popup:visible');
        if ($dp && $dp.length) {
          $dp.css({ width: '95vw', maxWidth: 'none' });
          $('#dialogue_popup .dialogue_popup_text:visible').css({ width: '100%' });
        }
        // SweetAlert2 等可能的弹窗容器
        const $swal = $('.swal2-container .swal2-popup:visible');
        if ($swal && $swal.length) {
          $swal.css({ width: '95vw', maxWidth: 'none' });
        }
      } catch (e) { /* 忽略样式适配异常 */ }
    }, 0);
  } catch (e) { /* 忽略 */ }
  await popupPromise;
}

