// 对比算法：基于已归一化的 snapshot { name, entries:[{key,value,category,character}] }
// 返回 { added, removed, changed, same, stats }

function entryKey(e){
  // 按“标题（备忘）”进行匹配：用 label + 分类 + 角色 作为主键
  const c = (e.category||'').toString();
  const h = (e.character||'').toString();
  const label = (e.label || e.key || '').toString();
  return `${label}||${c}||${h}`;
}

export function diffSnapshots(a, b){
  const aMap = new Map();
  const bMap = new Map();
  (a?.entries||[]).forEach(e=> aMap.set(entryKey(e), e));
  (b?.entries||[]).forEach(e=> bMap.set(entryKey(e), e));

  const added = [];    // 仅在 B
  const removed = [];  // 仅在 A
  const changed = [];  // A,B都有，但 value 不同
  const same = [];     // A,B都有，且 value 相同

  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  for (const k of keys){
    const ea = aMap.get(k);
    const eb = bMap.get(k);
    if (ea && !eb) { removed.push(ea); continue; }
    if (!ea && eb) { added.push(eb); continue; }
    if (ea && eb){
      if ((ea.value||'') === (eb.value||'')){
        same.push({ a:ea, b:eb });
      } else {
        changed.push({ a:ea, b:eb });
      }
    }
  }

  return {
    added, removed, changed, same,
    stats: { aCount: a?.entries?.length||0, bCount: b?.entries?.length||0, added: added.length, removed: removed.length, changed: changed.length, same: same.length }
  };
}

export function formatPreviewHtml(a, b, diff){
  const esc = (s)=> String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const renderLink = (e)=> {
    const cat = e.category?` data-category="${esc(e.category)}"`:'';
    const chr = e.character?` data-character="${esc(e.character)}"`:'';
    const label = e.label || e.key;
    return `<li><a href="#" class="stdiff-entry-link" data-key="${esc(e.key)}"${cat}${chr} data-label="${esc(label)}">${esc(label)}</a>${e.category?` <i>[${esc(e.category)}]</i>`:''}${e.character?` <i>@${esc(e.character)}</i>`:''}</li>`;
  };
  return (
    `<div>`+
      `<div style="margin:4px 0;">`+
        `A: <b>${esc(a?.name||'')}</b>（${a?.entries?.length||0}条） vs B: <b>${esc(b?.name||'')}</b>（${b?.entries?.length||0}条）`+
        `；变更条目：修改 ${diff.changed.length}，新增 ${diff.added.length}，删除 ${diff.removed.length}`+
      `</div>`+
      `<details open><summary>修改（${diff.changed.length}）</summary><ol>${diff.changed.map(p=> renderLink(p.a)).join('')}</ol></details>`+
      `<details><summary>新增（仅B，${diff.added.length}）</summary><ol>${diff.added.map(renderLink).join('')}</ol></details>`+
      `<details><summary>删除（仅A，${diff.removed.length}）</summary><ol>${diff.removed.map(renderLink).join('')}</ol></details>`+
    `</div>`
  );
}

