// noass 模块：提供对话合并、clewd正则与数据捕获/占位替换功能

let teardown = null; // 卸载函数引用

function ensureConfig(ctx){
  const root = ctx.extensionSettings || window.extension_settings || {};
  root['st-diff'] = root['st-diff'] || {};
  const slot = (root['st-diff'].noass = root['st-diff'].noass || {});
  // 默认配置
  const defaults = {
    enabled: true,
    user: 'Human',
    assistant: 'Assistant',
    example_user: 'H',
    example_assistant: 'A',
    system: 'SYSTEM',
    separator: '',
    separator_system: '',
    prefill_user: 'Continue the conversation.',

    // 行为配置默认值
    // 是否将合并输出作为单条 user 消息
    single_user_enabled: false,
    // 标签替换策略：'config_tags_clean'（按 capture_rules 清理未命中标签）或 'stored_only'（仅替换已存数据标签）
    replace_strategy: 'config_tags_clean',
    // 是否在合并块前注入预填充 user 消息（acheron=true；单user模式下忽略）
    inject_prefill_message: true,

    capture_enabled: true,
    capture_rules: [],
    stored_data: {},
    // 世界书提取与传递
    wi_extract_enabled: false,
    wi_depth_mode: 'threshold', // 'threshold' | 'pick'
    wi_depth_threshold: 2, // 当 mode=threshold 时表示 ≥N
    wi_depth_picks: [2,3,4], // 当 mode=pick 时的多选数组
    wi_target_tag: '<A_TRANS>',
    wi_strategy: 'extract_only', // 'extract_only' | 'extract_and_strip'
    // 模板与白名单（白名单按模板名分组，index.js负责维护UI；此处仅读取）
    templates: {},
    active: '默认',
    whitelists: {}, // { [templateName: string]: Array<{ depth: number|null, order: number|null, content: string }> }
  };
  for (const k of Object.keys(defaults)){
    if (!(k in slot)) slot[k] = defaults[k];
  }
  return slot;
}

function getStoredData(ctx){
  return ensureConfig(ctx).stored_data || {};
}

function saveStoredData(ctx, data){
  const cfg = ensureConfig(ctx);
  cfg.stored_data = data || {};
  try { (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))(); } catch{}
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filterByRange(array, rangeStr){
  try {
    const result = [];
    const segments = String(rangeStr||'').split(',');
    for (const segRaw of segments){
      const segment = segRaw.trim(); if (!segment) continue;
      if (segment.includes('~')){
        const [a,b] = segment.split('~');
        const A = parseRangeIndex(a, array.length);
        const B = parseRangeIndex(b, array.length);
        let start = Math.min(A,B), end = Math.max(A,B);
        for (let j=start; j<=end && j<array.length; j++){
          if (j>=0 && !result.includes(array[j])) result.push(array[j]);
        }
      } else {
        const idx = parseRangeIndex(segment, array.length);
        if (idx>=0 && idx<array.length && !result.includes(array[idx])) result.push(array[idx]);
      }
    }
    return result;
  } catch { return array; }
}

function parseRangeIndex(indexStr, len){
  const s = String(indexStr||'').trim();
  if (s.startsWith('+')) return parseInt(s.slice(1),10)-1;
  if (s.startsWith('-')) return len + parseInt(s,10);
  const n = parseInt(s,10); return isNaN(n)? -1 : n-1;
}

function captureAndStoreData(ctx, content, rules, globalEnabled){
  if (!globalEnabled) return;
  let stored = getStoredData(ctx);
  let changed = false;
  for (const rule of (rules||[])){
    try{
      if (rule.enabled === false) continue;
      const m = String(rule.regex||'').match(/^\/(.+)\/([gimsu]*)$/);
      if (!m) continue;
      const pattern = m[1]; const flags = m[2];
      const re = new RegExp(pattern, flags);
      re.lastIndex = 0;
      const matches = [];
      if (flags.includes('g')){
        let x; while((x = re.exec(content))!==null){ matches.push(x[0]); if (x.index===re.lastIndex) re.lastIndex++; }
      } else {
        const x = re.exec(content); if (x) matches.push(x[0]);
      }
      if (!matches.length) continue;
      const filtered = rule.range ? filterByRange(matches, rule.range) : matches;
      if (!filtered.length) continue;
      if (rule.updateMode === 'replace'){
        stored[rule.tag] = filtered.slice(); changed = true;
      } else {
        const arr = stored[rule.tag] || (stored[rule.tag]=[]);
        for (const it of filtered) if (!arr.includes(it)) { arr.push(it); changed = true; }
      }
    }catch{}
  }
  if (changed) saveStoredData(ctx, stored);
}

function replaceTagsWithStoredData(ctx, content, cfg, extraMap){
  const stored = getStoredData(ctx);
  const tags = [];
  if (cfg && Array.isArray(cfg.capture_rules)){
    for (const r of cfg.capture_rules){ if (r?.tag && !tags.includes(r.tag)) tags.push(r.tag); }
  }
  if (extraMap && typeof extraMap === 'object'){
    for (const k of Object.keys(extraMap)){ if (!tags.includes(k)) tags.push(k); }
  }
  let out = String(content||'');
  for (const tag of tags){
    if (out.indexOf(tag) === -1) continue;
    let repl = '';
    if (extraMap && Object.prototype.hasOwnProperty.call(extraMap, tag)){
      repl = String(extraMap[tag]||'');
    } else if (stored[tag] && stored[tag].length){
      repl = stored[tag].join('\n');
    }
    out = out.replace(new RegExp(escapeRegExp(tag), 'g'), repl);
  }
  return out;
}

/**
* 仅按 stored_data 与 extraMap 替换标签，不清理未命中标签
* @param {*} ctx
* @param {string} content
* @param {Record<string,string>=} extraMap 额外替换映射（世界书插入等）
* @returns {string}
*/
function replaceTagsStoredOnly(ctx, content, extraMap){
 const stored = getStoredData(ctx);
 let out = String(content || '');
 // 先替换 stored_data 的 key
 Object.keys(stored || {}).forEach(tag => {
   if (!tag) return;
   const arr = stored[tag];
   if (!Array.isArray(arr) || !arr.length) return;
   const repl = arr.join('\n');
   out = out.replace(new RegExp(escapeRegExp(tag), 'g'), repl);
 });
 // 再替换 extraMap（若提供）
 if (extraMap && typeof extraMap === 'object'){
   for (const k of Object.keys(extraMap)){
     const v = String(extraMap[k] ?? '');
     out = out.replace(new RegExp(escapeRegExp(k), 'g'), v);
   }
 }
 return out;
}

/**
* 策略分发：config_tags_clean（按 capture_rules 清理未命中标签）或 stored_only（仅替换已存数据标签）
* @param {*} ctx
* @param {string} content
* @param {*} cfg
* @param {'config_tags_clean'|'stored_only'} strategy
* @param {Record<string,string>=} extraMap
* @returns {string}
*/
function replaceByStrategy(ctx, content, cfg, strategy, extraMap){
 const s = (strategy || 'config_tags_clean');
 if (s === 'stored_only'){
   return replaceTagsStoredOnly(ctx, content, extraMap);
 }
 // 默认：沿用现有行为（按 capture_rules 清理未命中标签；支持 extraMap）
 return replaceTagsWithStoredData(ctx, content, cfg, extraMap);
}

// ============= 文本处理 =============
function processMessages(prefixs, messages){
  prefixs = prefixs || {};
  const defaults = ensureDefaults();
  const px = Object.assign({}, defaults, prefixs);

  function hyperRegex(content, order){
    let regexLog = '';
    const regexPattern = "<regex(?: +order *= *" + order + ")" + (order === 2 ? '?' : '') + "> *\"(/?)(.*)\\1(.*?)\" *: *\"(.*?)\" *</regex>";
    const matches = String(content||'').match(new RegExp(regexPattern, 'gm'));
    let out = String(content||'');
    if (matches){
      for (const m of matches){
        try{
          const reg = /<regex(?: +order *= *\d)?> *"(\/?.*?)" *: *"(.*?)" *<\/regex>/.exec(m);
          const reg2 = /<regex(?: +order *= *\d)?> *"(\/?)(.*)\1(.*?)" *: *"(.*?)" *<\/regex>/.exec(m) || reg;
          const replacePattern = new RegExp(reg2[2], reg2[3]);
          const replacement = JSON.parse('"' + String(reg2[4]).replace(/\\?"/g, '\\"') + '"');
          out = out.replace(replacePattern, replacement);
          regexLog += m + '\n';
        }catch{}
      }
    }
    return [out, regexLog];
  }

  function hyperMerge(content, mergeDisable){
    const re = new RegExp("\\n\\n("+px['assistant']+"|"+px['user']+"|"+px['system']+"):", 'g');
    let parts = String(content||'').split(re);
    let acc = parts[0];
    for (let i=1;i<parts.length;i+=2){
      const role = parts[i];
      const text = parts[i+1];
      const prevRole = parts[i-1];
      const canMerge = (role===prevRole) && (
        (role===px['user'] && !mergeDisable.user) ||
        (role===px['assistant'] && !mergeDisable.assistant) ||
        (role===px['system'] && !mergeDisable.system)
      );
      acc += (canMerge? '' : "\n\n"+role+": ") + String(text||'').trim();
    }
    return acc;
  }

  function HyperPmtProcess(content){
    let regexLogs = '';
    const r1 = hyperRegex(content, 1); content = r1[0]; regexLogs += r1[1];
    const mergeDisable = {
      all: content.indexOf('<|Merge Disable|>') !== -1,
      system: content.indexOf('<|Merge System Disable|>') !== -1,
      user: content.indexOf('<|Merge Human Disable|>') !== -1,
      assistant: content.indexOf('<|Merge Assistant Disable|>') !== -1,
    };
    const systemPattern1 = new RegExp("(\\n\\n|^\\s*)(?<!\\n\\n("+px['user']+"|"+px['assistant']+"):.*?)"+px['system']+":\\s*", 'gs');
    const systemPattern2 = new RegExp("(\\n\\n|^\\s*)"+px['system']+": *", 'g');
    content = String(content||'')
      .replace(systemPattern1, '$1')
      .replace(systemPattern2, mergeDisable.all || mergeDisable.user || mergeDisable.system ? '$1' : "\n\n" + px['user'] + ": ");
    content = hyperMerge(content, mergeDisable);
    const splitPattern = new RegExp("\\n\\n(?="+px['assistant']+":|"+px['user']+":)", 'g');
    let splitContent = String(content||'').split(splitPattern);
    let match; const atPattern = /<@(\d+)>(.*?)<\/\@\1>/gs;
    while((match = atPattern.exec(content))!==null){
      let index = splitContent.length - parseInt(match[1],10) - 1;
      if (index>=0) splitContent[index] += '\n\n'+ match[2];
      content = content.replace(match[0], '');
    }
    content = splitContent.join('\n\n').replace(/<@(\d+)>.*?<\/\@\1>/gs,'');
    const r2 = hyperRegex(content, 2); content = r2[0]; regexLogs += r2[1];
    content = hyperMerge(content, mergeDisable);
    const r3 = hyperRegex(content, 3); content = r3[0]; regexLogs += r3[1];
    content = String(content||'')
      .replace(/<regex( +order *= *\d)?>.*?<\/regex>/gm, '')
      .replace(/\r\n|\r/gm, '\n')
      .replace(/\s*<\|curtail\|>\s*/g, '\n')
      .replace(/\s*<\|join\|>\s*/g, '')
      .replace(/\s*<\|space\|>\s*/g, ' ')
      .replace(/<\|(\\.*?)\|>/g, (m,p1)=>{ try{ return JSON.parse('"'+p1+'"'); }catch{ return m; } });
    return String(content||'')
      .replace(/\s*<\|.*?\|>\s*/g, '\n\n')
      .trim()
      .replace(/^.+:/, '\n\n$&')
      .replace(/(?<=\n)\n(?=\n)/g, '');
  }

  function process(prefixs, messages){
    function youPmtProcess(prompt, sep){
      if (typeof prompt !== 'string' || !prompt) return '';
      const splitPattern = new RegExp("\\n\\n(?="+px['assistant']+":|"+px['user']+":)", 'g');
      return prompt.split(splitPattern).join("\n" + (sep||'') + "\n");
    }
    let prompt = '';
    if (!messages || !messages.length) return { role:'assistant', content:'' };
    for (const m of messages){
      if (m && m.content){
        const role = m.role || 'user'; const name = m.name; const lookup = px[name] || px[role] || role;
        const prefix = '\n\n' + lookup + (name ? ': ' + name : '') + ': ';
        prompt += prefix + String(m.content).trim();
      }
    }
    prompt = HyperPmtProcess(prompt);
    if (prompt) prompt += "\n\n" + px['assistant'] + ':';
    const youPrompt = prompt.split(/\s*\[-youFileTag-\]\s*/);
    const filePrompt = youPrompt.length>0 ? youPrompt.pop().trim() : '';
    // 解析 separator 的转义
    let separator = '';
    if (px.separator) {
      try { separator = JSON.parse('"' + px.separator + '"'); } catch (e) { try { console.error(e); } catch {} }
    }
    return { role:'assistant', content: youPmtProcess(filePrompt, separator) };
  }

  function ensureDefaults(){
    return { user:'Human', assistant:'Assistant', example_user:'H', example_assistant:'A', system:'SYSTEM', separator:'', separator_system:'', prefill_user:'Continue the conversation.' };
  }

  return process(prefixs, messages);
}

function processExact(prefixs, messages) {
  prefixs = prefixs || ensureDefaults();

  const HyperProcess = function(system, messages, claudeMode) {
      const hyperMerge = function(content, mergeDisable) {
          let splitContent = content.split(new RegExp("\\n\\n(" + prefixs['assistant'] + "|" + prefixs['user'] + "|" + prefixs['system'] + "):", 'g'));
          content = splitContent[0] + splitContent.slice(1).reduce(function(acc, current, index, array) {
              const merge = index > 1 && current === array[index - 2] && (
                  current === prefixs['user'] && !mergeDisable.user ||
                  current === prefixs['assistant'] && !mergeDisable.assistant ||
                  current === prefixs['system'] && !mergeDisable.system
              );
              return acc + (index % 2 !== 0 ? current.trim() : "\n\n" + (merge ? '' : current + ": "));
          }, '');
          return content;
      };
      
      const hyperRegex = function(content, order) {
          let regexLog = '';
          const regexPattern = "<regex(?: +order *= *" + order + ")" + (order === 2 ? '?' : '') + "> *\"(/?)(.*)\\1(.*?)\" *: *\"(.*?)\" *</regex>";
          let matches = content.match(new RegExp(regexPattern, 'gm'));
          
          if (matches) {
              for (let i = 0; i < matches.length; i++) {
                  const match = matches[i];
                  try {
                      const reg = /<regex(?: +order *= *\d)?> *"(\/?)(.*)\1(.*?)" *: *"(.*?)" *<\/regex>/.exec(match);
                      regexLog += match + '\n';
                      const replacePattern = new RegExp(reg[2], reg[3]);
                      const replacement = JSON.parse('"' + reg[4].replace(/\\?"/g, '\\"') + '"');
                      content = content.replace(replacePattern, replacement);
                  } catch(e) {
                      try { console.warn("Regex processing error:", e); } catch {}
                  }
              }
          }
          return [content, regexLog];
      };
      
      const HyperPmtProcess = function(content) {
          const regex1 = hyperRegex(content, 1);
          content = regex1[0];
          regexLogs += regex1[1];
          
          const mergeDisable = {
              all: content.indexOf('<|Merge Disable|>') !== -1,
              system: content.indexOf('<|Merge System Disable|>') !== -1,
              user: content.indexOf('<|Merge Human Disable|>') !== -1,
              assistant: content.indexOf('<|Merge Assistant Disable|>') !== -1
          };
          
          const systemPattern1 = new RegExp("(\\n\\n|^\\s*)(?<!\\n\\n(" + prefixs['user'] + "|" + prefixs['assistant'] + "):.*?)" + prefixs['system'] + ":\\s*", 'gs');
          const systemPattern2 = new RegExp("(\\n\\n|^\\s*)" + prefixs['system'] + ": *", 'g');
          
          content = content.replace(systemPattern1, '$1')
              .replace(systemPattern2, mergeDisable.all || mergeDisable.user || mergeDisable.system ? '$1' : "\n\n" + prefixs['user'] + ": ");
          content = hyperMerge(content, mergeDisable);
          
          const splitPattern = new RegExp("\\n\\n(?=" + prefixs['assistant'] + ":|" + prefixs['user'] + ":)", 'g');
          let splitContent = content.split(splitPattern);
          
          let match;
          const atPattern = /<@(\d+)>(.*?)<\/@\1>/gs;
          while ((match = atPattern.exec(content)) !== null) {
              let index = splitContent.length - parseInt(match[1]) - 1;
              if (index >= 0) {
                  splitContent[index] += '\n\n' + match[2];
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
          
          content = content.replace(/<regex( +order *= *\d)?>.*?<\/regex>/gm, '')
              .replace(/\r\n|\r/gm, '\n')
              .replace(/\s*<\|curtail\|>\s*/g, '\n')
              .replace(/\s*<\|join\|>\s*/g, '')
              .replace(/\s*<\|space\|>\s*/g, ' ')
              .replace(/<\|(\\.*?)\|>/g, function(match, p1) { 
                  try { 
                      return JSON.parse('"' + p1 + '"');
                  } catch { 
                      return match;
                  } 
              });
              
          return content.replace(/\s*<\|.*?\|>\s*/g, '\n\n')
              .trim().replace(/^.+:/, '\n\n$&')
              .replace(/(?<=\n)\n(?=\n)/g, '');
      };
      
      let prompt = system || '';
      let regexLogs = '';

      if (!messages || messages.length === 0) {
          return { prompt: '', log: ''};
      }
      
      for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          if (message && message.content) {
              const role = message.role || 'user';
              const name = message.name;
              const prefixLookup = prefixs[name] || prefixs[role] || role;
              const prefix = '\n\n' + prefixLookup + (name ? ': ' + name : '') + ': ';
              prompt += prefix + message.content.trim();
          } else {
              try { console.warn("Skipping invalid message object:", message); } catch {}
          }
      }
      
      prompt = HyperPmtProcess(prompt);
      if (!claudeMode && prompt) {
           prompt += "\n\n" + prefixs['assistant'] + ":";
      }
      return {prompt: prompt, log: "\n####### Regex:\n" + regexLogs};
  };

  let separator = "";
  if (prefixs.separator) {
      try { 
          separator = JSON.parse('"' + prefixs.separator + '"');
      } catch(e) { 
          try { console.error(e); } catch{}
      }
  }

  const youPmtProcess = function(prompt, sep) {
      if (typeof prompt !== 'string' || !prompt) return '';
      const splitPattern = new RegExp("\\n\\n(?=" + prefixs['assistant'] + ":|" + prefixs['user'] + ":)", 'g');
      return prompt.split(splitPattern).join("\n" + sep + "\n");
  };

  const result = HyperProcess("", messages, true);
  const prompt = result.prompt;
  const youPrompt = prompt.split(/\s*\[-youFileTag-\]\s*/);
  const filePrompt = youPrompt.length > 0 ? youPrompt.pop().trim() : '';
  return {
      role: 'assistant',
      content: youPmtProcess(filePrompt, separator)
  };
}

export async function mount(ctx){
  const es = ctx.eventSource; const et = ctx.eventTypes || ctx.event_types;
  const settings = ensureConfig(ctx);
  // 仅在主扩展开关启用且 noass.enabled=true 且 OpenAI 后端时启用
  const shouldEnable = () => {
    try {
      const selfEnabled = settings.enabled !== false;
      const apiOk = String(ctx.mainApi||'').toLowerCase() === 'openai';
      return selfEnabled && apiOk;
    } catch { return false; }
  };

  const handler = async (completion)=>{
    try{
      if (!shouldEnable()) return;
      const cfg = ensureConfig(ctx);
      const originalMessages = completion?.messages || [];
      const finalMessages = [];
      let currentBlock = [];
      const NO_TRANS_TAG = '<|no-trans|>';

      // 世界书提取并传递
      let sessionTagMap = null; // { tag: text }
      const activeName = cfg.active || '默认';
      const tpl = (cfg.templates && cfg.templates[activeName]) ? cfg.templates[activeName] : {};
      // 读取模板中的多组设置；不存在则回退到单组配置
      /** @type {Array<{name?:string,extract_enabled?:boolean,depth_mode?:string,depth_threshold?:number,depth_picks?:number[],target_tag?:string,strategy?:string,whitelist?:Array}>} */
      let wiGroups = Array.isArray(tpl.wi_groups) ? tpl.wi_groups : [];
      if (!wiGroups.length){
        wiGroups = [{
          name: '默认组',
          extract_enabled: tpl.wi_extract_enabled ?? cfg.wi_extract_enabled ?? false,
          depth_mode: tpl.wi_depth_mode || cfg.wi_depth_mode || 'threshold',
          depth_threshold: tpl.wi_depth_threshold ?? cfg.wi_depth_threshold ?? 2,
          depth_picks: Array.isArray(tpl.wi_depth_picks) ? tpl.wi_depth_picks : (Array.isArray(cfg.wi_depth_picks) ? cfg.wi_depth_picks : [2,3,4]),
          target_tag: tpl.wi_target_tag || cfg.wi_target_tag || '<A_TRANS>',
          strategy: tpl.wi_strategy || cfg.wi_strategy || 'extract_only',
          whitelist: (cfg.whitelists && cfg.whitelists[activeName]) ? cfg.whitelists[activeName] : [],
        }];
      }
      // 读取行为配置（模板优先，回退全局）
      const singleUserEnabled = (tpl.single_user_enabled ?? cfg.single_user_enabled) ?? false;
      const replaceStrategy = (tpl.replace_strategy || cfg.replace_strategy) || 'config_tags_clean';
      const injectPrefill = (tpl.inject_prefill_message ?? cfg.inject_prefill_message);
      const enabledGroups = wiGroups.filter(g=> g && g.extract_enabled !== false && typeof g.target_tag === 'string' && g.target_tag.length).map((g,i)=>({ ...g, __idx:i }));
      const tagList = [];
      const groupTextMap = {};
      const PROTECT_MAP = {}; const BEGIN_MAP = {}; const END_MAP = {};
      enabledGroups.forEach((g)=>{ const idx=g.__idx; const t = g.target_tag; if (!tagList.includes(t)) tagList.push(t); PROTECT_MAP[t] = `<<NOASS_WI_TAG_${idx}>>`; BEGIN_MAP[t] = `<<NOASS_INSERT_BEGIN_${idx}>>`; END_MAP[t] = `<<NOASS_INSERT_END_${idx}>>`; });
      if (enabledGroups.length){
        try{
          const chatForWI = (Array.isArray(ctx.chat)? ctx.chat : []).map(x=> {
            const name = x?.name ? String(x.name)+': ' : '';
            return name + String(x?.mes||'');
          }).reverse();
          const dry = true; const maxCtx = Number(ctx.maxContext || 2048);
          const { worldInfoDepth } = await ctx.getWorldInfoPrompt(chatForWI, maxCtx, dry, {});
          const groups = Array.isArray(worldInfoDepth) ? worldInfoDepth.slice().sort((a,b)=>Number(b?.depth||0)-Number(a?.depth||0)) : [];
          enabledGroups.forEach(g=>{
            const pickSet = new Set(Array.isArray(g.depth_picks)? g.depth_picks.map(Number) : []);
            const usePick = g.depth_mode === 'pick';
            const threshold = Number(g.depth_threshold ?? 2);
            const want = (d)=> usePick ? pickSet.has(Number(d)) : (Number(d) >= threshold);
            const parts = [];
            groups.forEach(gr=>{
              if (!want(gr.depth)) return;
              const arr = Array.isArray(gr.entries)? gr.entries : [];
              arr.forEach(s=>{ if (s) parts.push(String(s)); });
            });
            const text = parts.join('\n');
            if (text) groupTextMap[g.target_tag] = text;
          });
          if (Object.keys(groupTextMap).length){ sessionTagMap = Object.assign({}, groupTextMap); }
        }catch(e){ try{ console.warn('[ST-Diff][noass] wi extract failed', e); }catch{} }
      }

      function activePrefixes(){
        try {
          const act = cfg.active || '默认';
          const tpl = (cfg.templates && cfg.templates[act]) ? cfg.templates[act] : {};
          // 仅覆盖前缀相关键
          const obj = {
            user: tpl.user ?? cfg.user,
            assistant: tpl.assistant ?? cfg.assistant,
            example_user: cfg.example_user,
            example_assistant: cfg.example_assistant,
            system: tpl.system ?? cfg.system,
            separator: cfg.separator,
            separator_system: tpl.separator_system ?? cfg.separator_system,
            prefill_user: tpl.prefill_user ?? cfg.prefill_user,
          };
          // 校验：user/assistant 非空且不同，否则回退默认
          try {
            const du = (obj.user || '').trim();
            const da = (obj.assistant || '').trim();
            if (!du || !da || du === da) {
              obj.user = 'Human';
              obj.assistant = 'Assistant';
              try { console.warn('[ST-Diff][noass] activePrefixes fallback to defaults: user/assistant invalid'); } catch {}
            }
          } catch {}
          return obj;
        } catch { return cfg; }
      }

      let replacedAny = false;
      function processAndAddMergeBlock(block){
        if (!block || !block.length) return;
        // 捕获
        if (cfg.capture_enabled !== false && Array.isArray(cfg.capture_rules) && cfg.capture_rules.length){
          const combined = block.map(m=> String(m?.content||'')).filter(Boolean).join('\n\n');
          captureAndStoreData(ctx, combined, cfg.capture_rules, cfg.capture_enabled !== false);
        }
        // 合并
        // 保证 clewd 正则行为
        const ap = activePrefixes();
        const mergedAssistantMessage = processExact(ap, block);
        if (mergedAssistantMessage && mergedAssistantMessage.content){
          let content = mergedAssistantMessage.content;
          // 在合并阶段按策略处理“数据捕获规则”的标签，避免提前把世界书目标标签内容注入
          content = replaceByStrategy(ctx, content, cfg, replaceStrategy, null);

          // 系统分离
          let systemMsg = null;
          const sepSys = ap.separator_system || cfg.separator_system || '';
          if (sepSys){
            const idx = content.indexOf(sepSys);
            if (idx > 0){
              const sys = content.substring(0, idx + sepSys.length);
              content = content.substring(idx + sepSys.length);
              systemMsg = { role:'system', content: sys };
            }
          }
          if (systemMsg) finalMessages.push(systemMsg);

          if (singleUserEnabled) {
            // 单 user 模式：直接将合并后的内容作为 user
            finalMessages.push({ role:'user', content });
          } else {
            // 默认（acheron）模式
            if (injectPrefill !== false) {
              const prefill = (ap.prefill_user ?? cfg.prefill_user) || 'Continue the conversation.';
              finalMessages.push({ role:'user', content: prefill });
            }
            finalMessages.push({ role:'assistant', content });
          }
        }
      }

      for (const message of originalMessages){
        const hasNoTrans = String(message?.content||'').indexOf(NO_TRANS_TAG) !== -1;
        if (hasNoTrans){
          processAndAddMergeBlock(currentBlock); currentBlock = [];
          let cleanedContent = String(message.content||'').replace(NO_TRANS_TAG, '').trim();
          if (sessionTagMap){
            for (const tg of Object.keys(sessionTagMap)){
              const mark = PROTECT_MAP[tg] || '<<NOASS_WI_TAG_GENERIC>>';
              cleanedContent = cleanedContent.split(tg).join(mark);
            }
          }
          const cleaned = { role: message.role, content: cleanedContent };
          // 保留消息也进行系统分离与占位替换
          if (cleaned.content){
            // 保留消息也仅处理“数据捕获规则”的标签（按策略）
            let remaining = replaceByStrategy(ctx, cleaned.content, cfg, replaceStrategy, null);
            if (cfg.separator_system && cleaned.role === 'system'){
              const idx = remaining.indexOf(cfg.separator_system);
              if (idx>0){
                const sys = remaining.substring(0, idx + cfg.separator_system.length);
                remaining = remaining.substring(idx + cfg.separator_system.length).trim();
                finalMessages.push({ role:'system', content: sys });
              }
            }
            if (remaining){ finalMessages.push({ role: cleaned.role, content: remaining }); }
          }
        } else {
          // 加入合并块前，保护目标标签避免在 clewd 清理阶段被移除
          let mc = String(message?.content||'');
          if (sessionTagMap){ for (const tg of Object.keys(sessionTagMap)){ const mark = PROTECT_MAP[tg] || '<<NOASS_WI_TAG_GENERIC>>'; mc = mc.split(tg).join(mark); } }
          currentBlock.push({ ...message, content: mc });
        }
      }
      processAndAddMergeBlock(currentBlock);
      // 对最终消息再次做占位替换，并将保护标记还原为真实目标标签再替换
      for (const m of finalMessages){
        if (!m.content) continue;
        // 先还原每个保护占位，并逐组替换
        if (sessionTagMap){
          for (const tg of Object.keys(sessionTagMap)){
            const mark = PROTECT_MAP[tg] || '<<NOASS_WI_TAG_GENERIC>>';
            m.content = String(m.content).split(mark).join(tg);
          }
          for (const tg of Object.keys(sessionTagMap)){
            const text = sessionTagMap[tg]; if (!text) continue;
            const begin = BEGIN_MAP[tg] || '<<NOASS_INSERT_BEGIN>>';
            const end = END_MAP[tg] || '<<NOASS_INSERT_END>>';
            const re = new RegExp(escapeRegExp(tg), 'g');
            const rep = begin + text + end;
            const nv = String(m.content).replace(re, rep);
            if (nv!==m.content){ m.content = nv; replacedAny=true; }
          }
        }
        // 再处理“数据捕获规则”的标签（按策略）
        m.content = replaceByStrategy(ctx, m.content, cfg, replaceStrategy, null);
      }

      // 按组剥离阶段。随后统一清理 BEGIN/END 标记
      try{
        if (replacedAny && enabledGroups.length){
          const stripGroups = enabledGroups.filter(g=> (g.strategy||'extract_only')==='extract_and_strip' && groupTextMap[g.target_tag]);
          if (stripGroups.length){
            // 收集每组的 removeSet 和 whitelist
            const removeSetMap = {}; const whitelistMap = {}; const collapseMap = {}; const beginList = []; const endList = [];
            stripGroups.forEach(g=>{
              const tag = g.target_tag; removeSetMap[tag] = new Set((groupTextMap[tag]||'').split('\n').map(s=>s.trim()).filter(Boolean));
              whitelistMap[tag] = Array.isArray(g.whitelist) ? g.whitelist : ((cfg.whitelists && cfg.whitelists[activeName])||[]);
              collapseMap[tag] = !!g.collapse_empty_after_strip;
              beginList.push(BEGIN_MAP[tag] || '<<NOASS_INSERT_BEGIN>>');
              endList.push(END_MAP[tag] || '<<NOASS_INSERT_END>>');
            });
            const isBegin = (t)=> beginList.find(b=> t.includes(b));
            const isEnd = (t)=> endList.find(e=> t.includes(e));
            const matchWhite = (t, list)=>{
              if (!list || !list.length) return false;
              for (const w of list){ const hasContent = typeof w?.content==='string' && w.content.length>0; const hasDO = (w?.depth!=null) || (w?.order!=null); if (hasContent){ if (t.includes(w.content)) return true; } else if (hasDO){ return true; } }
              return false;
            };
            finalMessages.forEach(m=>{
              if (!m.content) return;
              const lines = String(m.content).split('\n');
              const kept = [];
              let inInsert = false;
              for (let line of lines){
                let t = line.trim();
                const b = isBegin(t); if (b){ inInsert = true; line = line.replace(b, ''); kept.push(line); continue; }
                const e = isEnd(t); if (e){ inInsert = false; line = line.replace(e, ''); kept.push(line); continue; }
                if (inInsert){ kept.push(line); continue; }
                // 检查每个组的 removeSet
                let removed = false;
                for (const g of stripGroups){
                  const rs = removeSetMap[g.target_tag];
                  if (!rs) continue;
                  if (rs.has(t)) { if (!matchWhite(t, whitelistMap[g.target_tag])) { removed = true; break; } }
                  // 宽松匹配：当行包含较长片段时也视为命中（避免空白差异导致漏剥离）
                  if (!removed) {
                    for (const frag of rs){
                      if (frag && frag.length >= 6 && t.indexOf(frag) !== -1){ if (!matchWhite(t, whitelistMap[g.target_tag])) { removed = true; break; } }
                    }
                    if (removed) break;
                  }
                }
                if (!removed) kept.push(line);
              }
              let out = kept.join('\n');
              // 按需在“剥离处”折叠空行：将三连及以上空行折叠为一个空行（仅影响本次处理的消息文本）
              if (Object.values(collapseMap).some(Boolean)){
                out = out.replace(/\n{3,}/g, '\n\n');
              }
              m.content = out;
            });
          }
          // 无论是否剥离，都进行一次标记清理
          const allBegins = Object.values(BEGIN_MAP).concat('<<NOASS_INSERT_BEGIN>>');
          const allEnds = Object.values(END_MAP).concat('<<NOASS_INSERT_END>>');
          for (const m of finalMessages){ if (!m.content) continue; allBegins.forEach(b=>{ m.content = m.content.split(b).join(''); }); allEnds.forEach(e=>{ m.content = m.content.split(e).join(''); }); }
        }
      } catch(e){ try{ console.warn('[ST-Diff][noass] strip wi failed', e); }catch{} }

      completion.messages = finalMessages;
    } catch (e){ try { console.warn('[ST-Diff][noass] handler error', e); } catch{} }
  };

  const bind = ()=>{ try { es.on(et.CHAT_COMPLETION_SETTINGS_READY, handler); } catch{} };
  const unbind = ()=>{ try { es.removeListener?.(et.CHAT_COMPLETION_SETTINGS_READY, handler); } catch{} };
  bind();

  // 跟随设置变化与 API 变化的简单自恢复
  try {
    es.on(et.SETTINGS_UPDATED || 'settings_updated', ()=>{});
  } catch{}

  teardown = unbind;
}

export async function unmount(ctx){
  try { if (typeof teardown === 'function') teardown(); } catch{}
  teardown = null;
}


