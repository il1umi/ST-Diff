// worldbook 数据仓库
// 提供：list() / get(name) / snapshot(name, opts) / toComparable(book, opts)
// 说明：
// - 首选使用 ctx（getContext()）提供的数据/方法；
// - 其次尝试从页面现有 DOM 的世界书下拉读取（只读标题）；
// - 最后兜底使用可能存在的全局变量（如 window.world_names / window.world_info 等）。

function stableStringify(obj) {
  const seen = new WeakSet();
  const sorter = (value) => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      if (Array.isArray(value)) return value.map(sorter);
      const out = {};
      Object.keys(value).sort().forEach(k => { out[k] = sorter(value[k]); });
      return out;
    }
    return value;
  };
  try { return JSON.stringify(sorter(obj), null, 2); } catch { try { return JSON.stringify(obj); } catch { return String(obj); } }
}

function normalizeString(s, { ignoreWhitespace = true, ignoreCase = false } = {}) {
  let out = (s ?? '').toString();
  if (ignoreWhitespace) out = out.replace(/\s+/g, ' ').trim();
  if (ignoreCase) out = out.toLowerCase();
  return out;
}

function findSourceSelect() {
  // 优先寻找带“--- 选择以编辑 ---”占位项的下拉
  const candidates = Array.from(document.querySelectorAll('select'));
  for (const sel of candidates) {
    const first = sel.options && sel.options.length ? (sel.options[0].textContent || '').trim() : '';
    if (/选择以编辑|Select\s*to\s*edit/i.test(first)) return sel;
  }
  // 回退：常见选择器
  const selectors = ['#worlds_select', '#world_editor_select_list', '#world_editor_select', 'select[name="world"]', '.worldbook-select select'];
  for (const s of selectors) { const el = document.querySelector(s); if (el) return el; }
  return null;
}

function listFromDom() {
  const set = new Set(); const list = [];
  const src = findSourceSelect();
  if (src && src.options) {
    for (let i = 0; i < src.options.length; i++) {
      const text = (src.options[i].textContent || '').trim();
      if (!text) continue;
      if (/^[-—\s]*选择以编辑[-—\s]*$/i.test(text)) continue;
      if (/^[-—\s]*Select\s*to\s*edit[-—\s]*$/i.test(text)) continue;
      if (!set.has(text)) { set.add(text); list.push(text); }
    }
  }
  return list;
}

export function createWorldbookRepo(ctx) {
  const getRoot = () => ctx?.extensionSettings || window.extension_settings || {};

  async function list() {
    // 优先 ctx.world_names（标题列表）
    const names = Array.isArray(ctx?.world_names) ? ctx.world_names : (window.world_names || []);
    const fromCtx = names.map(v => (v || '').toString().trim()).filter(Boolean);
    if (fromCtx && fromCtx.length) return Array.from(new Set(fromCtx));
    // 回退 DOM
    const fromDom = listFromDom();
    if (fromDom.length) return fromDom;
    // 兜底：尝试从可能的全局结构里提取标题
    try {
      const wi = window.world_info || [];
      const set = new Set(); const out = [];
      wi.forEach(e => { const t = (e?.book || e?.title || e?.name || '').toString().trim(); if (t && !set.has(t)) { set.add(t); out.push(t); } });
      if (out.length) return out;
    } catch {}
    return [];
  }

  async function get(name) {
    if (!name) return null;
    // 1) ctx 方法优先
    try {
      if (typeof ctx?.loadWorldInfo === 'function') {
        const book = await ctx.loadWorldInfo(name);
        if (book) return book;
      }
    } catch {}
    // 兼容其他构建的可能方法
    try {
      if (typeof ctx?.loadWorldInfo === 'function') {
        const book = await ctx.loadWorldInfo({ name });
        if (book) return book;
      }
    } catch {}
    try {
      if (typeof ctx?.worldInfo?.getBookByTitle === 'function') {
        const book = await ctx.worldInfo.getBookByTitle(name);
        if (book) return book;
      }
    } catch {}
    try {
      if (typeof ctx?.api?.world?.getByName === 'function') {
        const book = await ctx.api.world.getByName(name);
        if (book) return book;
      }
    } catch {}

    // 2) 全局对象兜底
    try {
      // 应对某些构建里会把当前加载的世界书挂到全局 map 上
      if (window.worlds && typeof window.worlds === 'object') {
        const keys = Object.keys(window.worlds);
        for (const k of keys) {
          const b = window.worlds[k];
          const title = (b?.title || b?.name || b?.book || '').toString().trim();
          if (title === name) return b;
        }
      }
    } catch {}

    // 3) DOM 无法直接获取结构化内容（只读标题），返回 null
    return null;
  }

  async function toComparable(bookOrName, opts = {}) {
    let book = bookOrName;
    if (!book || typeof book !== 'object') {
      book = await get(bookOrName);
    }
    const { ignoreWhitespace = true, ignoreCase = false, jsonNormalize = true } = opts;

    if (!book) {
      return { name: typeof bookOrName === 'string' ? bookOrName : (book?.title || book?.name || ''), entries: [], meta: { missing: true } };
    }

    // 名称尽量从多个字段判断
    const name = (book.title || book.name || book.book || book?.originalData?.title || book?.originalData?.name || '').toString();

    // 收集候选 entries（兼容数组/对象多种形态）
    const toArrayFromPossible = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object') {
        if (Array.isArray(v.entries)) return v.entries;
        if (Array.isArray(v.items)) return v.items;
        if (Array.isArray(v.list)) return v.list;
        return Object.values(v).filter(x => x && typeof x === 'object');
      }
      return [];
    };

    let rawEntries = [];
    rawEntries = rawEntries.concat(toArrayFromPossible(book.entries));
    rawEntries = rawEntries.concat(toArrayFromPossible(book.worldEntries));
    rawEntries = rawEntries.concat(toArrayFromPossible(book.data));
    rawEntries = rawEntries.concat(toArrayFromPossible(book?.originalData?.entries));
    rawEntries = rawEntries.concat(toArrayFromPossible(book?.originalData?.lorebook?.entries));

    // 去重（按 key+value 粗略去重，避免不同来源重复）
    const seen = new Set();
    const uniq = [];
    for (const e of rawEntries) {
      const k = (e?.key ?? e?.entry ?? e?.name ?? e?.title ?? '').toString();
      const v = (e?.value ?? e?.content ?? e?.text ?? '').toString();
      const sig = k + '|' + v;
      if (!seen.has(sig)) { seen.add(sig); uniq.push(e); }
    }

    const entries = uniq.map((e, idx) => {
      // 区分“显示标签(label)”与“匹配键(key)”：
      // - label 优先使用“标题（备忘）”类字段（title/comment/memo/notes/name...）；
      // - key 优先使用“主要关键字/触发词”类字段（key/entry/keys[0]/name 作为兜底）。
      const firstKey = Array.isArray(e.keys) && e.keys.length ? e.keys[0] : '';
      const labelRaw = (e.title ?? e.comment ?? e.memo ?? e.notes ?? e.displayName ?? e.name ?? '').toString().trim();
      const idLike = (e.id ?? e.uid ?? e._id ?? '').toString().trim();
      const displayLabel = labelRaw || (idLike ? `#${idLike}` : `#${idx+1}`);

      let rawKey = (e.key ?? e.entry ?? firstKey ?? e.name ?? '').toString().trim();
      if (!rawKey) rawKey = displayLabel; // 若未设置触发词，退回用可读标题以保证可点击/可匹配
      const key = normalizeString(rawKey, { ignoreWhitespace, ignoreCase });

      let value = e.value ?? e.content ?? e.text ?? '';
      if (jsonNormalize) {
        // 如果值是 JSON，进行排序 stringify
        try {
          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (parsed && typeof parsed === 'object') {
            value = stableStringify(parsed);
          }
        } catch { /* 非 JSON 文本，按字符串规则处理 */ }
      }
      const valueStr = normalizeString(String(value), { ignoreWhitespace, ignoreCase });
      const cat = (e.category || e.group || e.class || '').toString().trim();
      const chr = (e.character || e.speaker || '').toString().trim();
      return { key, label: displayLabel, value: valueStr, category: cat, character: chr };
    });

    return { name, entries };
  }

  async function snapshot(name, opts = {}) {
    return toComparable(name, opts);
  }

  async function saveBook(name, data){
    if (!name || !data) return { ok:false, reason:'invalid_params' };
    // 1) 首选 ctx.saveWorldInfo
    try {
      if (typeof ctx?.saveWorldInfo === 'function'){
        await ctx.saveWorldInfo(name, data, true);
        return { ok:true };
      }
    } catch(e){ /* 继续尝试其它方式 */ }
    // 2) 兼容 ctx.api.world.edit
    try {
      if (typeof ctx?.api?.world?.edit === 'function'){
        const r = await ctx.api.world.edit({ name, data });
        return { ok: !!r };
      }
    } catch(e){ /* 继续尝试 */ }
    // 3) 直接调用后端接口（同源环境下cookie会自动带上）
    try {
      const res = await fetch('/api/worldinfo/edit', {
        method:'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ name, data }),
        credentials: 'include',
      });
      if (res.ok) return { ok:true };
      return { ok:false, reason: 'http_'+res.status };
    } catch(e){ return { ok:false, reason: e?.message || 'fetch_failed' }; }
  }

  function normalizeKeyForMatch(raw, opts){
    const { ignoreWhitespace=true, ignoreCase=false } = opts || {};
    let s = (raw ?? '').toString();
    if (ignoreWhitespace) s = s.replace(/\s+/g, ' ').trim();
    if (ignoreCase) s = s.toLowerCase();
    return s;
  }

  async function writeEntryValue(bookName, entryKey, newValue, opts={}){
    if (!bookName || !entryKey) return { ok:false, reason:'invalid_params' };
    // 加载完整数据结构
    let book = await get(bookName);
    let data = (book?.originalData && typeof book.originalData==='object') ? book.originalData : book;
    if (!data || typeof data!=='object') return { ok:false, reason:'book_not_found' };
    // 兼容数组形式 -> 转换为对象
    if (Array.isArray(data.entries)){
      const obj = {};
      for (const it of data.entries){ const uid = (it?.uid ?? it?.id ?? it?._id ?? '').toString(); if (uid) obj[uid]=it; }
      data.entries = obj;
    }
    if (!data.entries || typeof data.entries!=='object') data.entries = {};

    const targetKeyNorm = normalizeKeyForMatch(entryKey, opts);
    let targetUid = null; let targetEntry = null;
    for (const [uid, e] of Object.entries(data.entries)){
      const cands = [];
      const pushStr = (v)=>{ if (v!=null) cands.push(String(v)); };
      pushStr(e?.key); pushStr(e?.entry); pushStr(e?.name); pushStr(e?.title); pushStr(e?.comment); pushStr(e?.memo); pushStr(e?.notes); pushStr(e?.displayName);
      if (Array.isArray(e?.keys)) { e.keys.forEach(k=> pushStr(k)); }
      // 逐个候选进行标准化匹配
      const hit = cands.some(s => normalizeKeyForMatch(s, opts) === targetKeyNorm
        || normalizeKeyForMatch(`[${e?.category||''}] ${s}`, opts) === targetKeyNorm
        || normalizeKeyForMatch(`${s} @${e?.character||''}`, opts) === targetKeyNorm
      );
      if (hit){ targetUid = uid; targetEntry = e; break; }
    }
    if (!targetUid){ return { ok:false, reason:'entry_not_found' }; }

    // 写入内容字段：优先已有字段名
    if ('value' in targetEntry) targetEntry.value = newValue;
    else if ('content' in targetEntry) targetEntry.content = newValue;
    else if ('text' in targetEntry) targetEntry.text = newValue;
    else targetEntry.value = newValue;

    const res = await saveBook(bookName, data);
    if (!res?.ok) return res;

    // 保存成功后：刷新编辑器与列表（若可用），并回读验证
    try { if (typeof ctx?.reloadWorldInfoEditor==='function') await ctx.reloadWorldInfoEditor(bookName); } catch{}
    try { if (typeof ctx?.updateWorldInfoList==='function') await ctx.updateWorldInfoList(); } catch{}

    // 回读验证
    try {
      const after = await get(bookName);
      let afterData = (after?.originalData && typeof after.originalData==='object') ? after.originalData : after;
      let entriesObj = afterData?.entries;
      if (Array.isArray(entriesObj)){
        const obj = {}; for (const it of entriesObj){ const uid = (it?.uid ?? it?.id ?? it?._id ?? '').toString(); if (uid) obj[uid]=it; } entriesObj = obj;
      }
      const norm = (s)=> normalizeKeyForMatch(s, opts);
      let verified = false;
      for (const e of Object.values(entriesObj||{})){
        const cands = []; const pushStr = (v)=>{ if (v!=null) cands.push(String(v)); };
        pushStr(e?.key); pushStr(e?.entry); pushStr(e?.name); pushStr(e?.title); pushStr(e?.comment); pushStr(e?.memo); pushStr(e?.notes); pushStr(e?.displayName);
        if (Array.isArray(e?.keys)) { e.keys.forEach(k=> pushStr(k)); }
        const hit = cands.some(s => norm(s)===norm(entryKey) || norm(`[${e?.category||''}] ${s}`)===norm(entryKey) || norm(`${s} @${e?.character||''}`)===norm(entryKey));
        if (hit){
          const v = ('value' in e) ? e.value : (('content' in e)? e.content : (('text' in e)? e.text : ''));
          verified = String(v) === String(newValue);
          break;
        }
      }
      return { ok:true, verified };
    } catch{
      return { ok:true, verified:false };
    }
  }

  return { list, get, snapshot, toComparable, getRoot, saveBook, writeEntryValue };
}

