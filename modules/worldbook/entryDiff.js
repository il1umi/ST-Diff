// 渲染“条目详细 DIFF 弹窗”：参数对比 + 内容摘要 + 打开内容代码Diff

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function pickParams(raw){
  // 提取除 key/value/category/character 常见字段外的其它参数，用于“其它参数”区
  const omit = new Set(['key','value','category','character','text','content']);
  const out = {};
  if (raw && typeof raw==='object'){
    Object.keys(raw).forEach(k=>{ if(!omit.has(k)){ out[k]=raw[k]; } });
  }
  return out;
}

export async function openEntryDiffDialog(ctx, aSnap, bSnap, keySig){
  // keySig: { key, category?, character? }
  const $ = window.jQuery || window.$;
  const html = await ctx.renderExtensionTemplateAsync('third-party/ST-Diff/modules/worldbook/templates','entry_diff');
  const $dlg = $(html);
  // 让弹窗尽可能宽
  try { $dlg.css({ width:'100%', maxWidth:'none' }); } catch{}

  const aEntry = (aSnap?.entries||[]).find(e=> e.key===keySig.key && (keySig.category?e.category===keySig.category:true) && (keySig.character?e.character===keySig.character:true));
  const bEntry = (bSnap?.entries||[]).find(e=> e.key===keySig.key && (keySig.category?e.category===keySig.category:true) && (keySig.character?e.character===keySig.character:true));

  const title = keySig.label || keySig.key;
  const meta = [keySig.category?`[${esc(keySig.category)}]`:'', keySig.character?`@${esc(keySig.character)}`:''].filter(Boolean).join(' ');
  $dlg.find('.stdiff-entry-title').text(title);
  $dlg.find('.stdiff-entry-meta').html(meta);

  const renderParams = (entry)=>{
    if (!entry) return '<div style="color:#999;">（无）</div>';
    const extras = pickParams(entry);
    const rows = [];
    // 常见参数展示
    rows.push(`<div>分类：${esc(entry.category||'')}</div>`);
    rows.push(`<div>角色：${esc(entry.character||'')}</div>`);
    // 其它参数（自动）
    Object.keys(extras).forEach(k=>{
      const v = typeof extras[k]==='object' ? JSON.stringify(extras[k]) : String(extras[k]);
      rows.push(`<div>${esc(k)}：${esc(v)}</div>`);
    });
    return rows.join('');
  };

  const renderContentBrief = (entry)=>{
    if (!entry) return '<div style="color:#999;">（无）</div>';
    const val = (entry.value||'').toString();
    const isJson = /^\?\s*[\[{]/.test(val.trim()) || val.trim().startsWith('{') || val.trim().startsWith('[');
    const brief = val.length>120 ? (val.slice(0,120)+'…') : val;
    return `<div>内容（${isJson?'JSON?':'文本'}）：<span style="opacity:.85">${esc(brief)}</span> <button class="menu_button stdiff-open-code" style="white-space:nowrap; word-break:keep-all;">展开对比</button></div>`;
  };

  const cols = $dlg.find('.stdiff-grid > div');
  $(cols[0]).find('.stdiff-col-params').html(renderParams(aEntry));
  $(cols[1]).find('.stdiff-col-params').html(renderParams(bEntry));
  $(cols[0]).find('.stdiff-col-content').html(renderContentBrief(aEntry));
  $(cols[1]).find('.stdiff-col-content').html(renderContentBrief(bEntry));

  // 绑定“展开内容对比”
  $dlg.on('click', '.stdiff-open-code', async (ev)=>{
    ev.preventDefault();
    const root = ctx.extensionSettings || window.extension_settings;
    const ui = root?.['st-diff']?.ui || {};
    let aVal = aEntry?.value||'';
    let bVal = bEntry?.value||'';
    try {
      const { createWorldbookRepo } = await import('./repo.js');
      const repo = createWorldbookRepo(ctx);
      // 重新拉取世界书的最新内容，确保基线使用实时数据
      const aLive = aSnap?.name ? await repo.toComparable(aSnap.name, ui) : null;
      const bLive = bSnap?.name ? await repo.toComparable(bSnap.name, ui) : null;
      const match = (snap)=> (snap?.entries||[]).find(e=> e.key===keySig.key && (keySig.category?e.category===keySig.category:true) && (keySig.character?e.character===keySig.character:true));
      const aLiveEntry = match(aLive);
      const bLiveEntry = match(bLive);
      if (aLiveEntry) aVal = aLiveEntry.value;
      if (bLiveEntry) bVal = bLiveEntry.value;
    } catch (e) { /* 拉取失败则退回用当前弹窗快照 */ }

    const opts = { ...ui, meta: { bookAName: aSnap?.name || '', bookBName: bSnap?.name || '', entryKey: keySig.key } };
    const { openCodeDiffDialog } = await import('./codeDiff.js');
    await openCodeDiffDialog(ctx, aVal, bVal, opts);
  });

  await ctx.callGenericPopup($dlg, '条目详细对比', undefined, { wide: true });
}

