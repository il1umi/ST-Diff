// 参数内联Diff注入：在世界书A的条目详情页每个参数控件上（下）方，插入一行世界书B的控件

/**
 * 初始化Diff注入
 * - 监听条目详情面板展开
 * - 读取A/B世界书数据
 * - 在目标控件上方插入B控件，变更时保存到B世界书
 */
export async function initParamsDiff(ctx){
  try {
    const $ = window.jQuery || window.$;
    const repo = await import('./repo.js');
    const api = repo.createWorldbookRepo(ctx);
    const log = (...args)=>{ try{ console.log('[ST-Diff][paramsDiff]', ...args);}catch{} };
    log('init start');
    // 移除旧版本可能遗留的样式，避免污染A的控件
    try{ const old = document.getElementById('stdiff-wb-style'); if (old) old.remove(); }catch{}

    // 让扩展开关控制：未启用就直接返回；并监听开关变化以显隐我们注入的DOM
    let enabled = true;
    try {
      const root = ctx.extensionSettings || window.extension_settings;
      enabled = !!root?.['st-diff']?.enabled;
      if (!enabled) { log('disabled via settings, skip init'); return; }
      const es = ctx.eventSource; const et = ctx.eventTypes || ctx.event_types;
      if (es && (et?.SETTINGS_UPDATED || et?.WORLDINFO_CHANGED)){
        es.on(et.SETTINGS_UPDATED || et.WORLDINFO_CHANGED, ()=>{
          const now = !!((ctx.extensionSettings||window.extension_settings)?.['st-diff']?.enabled);
          if (now === enabled) return;
          enabled = now;
          if (!enabled){
            // 关闭：解绑所有事件，并清理已注入的DOM（含Select2容器）
            try { unbindObserver(); } catch{}
            try { $(document).off('click.stdifB'); } catch{}
            try { cleanupInjectedUnder($(document)); } catch { $('.stdiff-inline, .stdiff-bline, .stdiff-bplain').remove(); }
          } else {
            // 开启：重绑观察器与点击事件，并注入当前条目
            try { bindObserver(); } catch{}
            try {
              $(document).off('click.stdifB').on('click.stdifB', '.inline-drawer-icon, .inline-drawer-toggle', function(){
                const $entry = $(this).closest('.world_entry');
                if ($entry && $entry.length) setTimeout(()=> injectForEntry($entry), 0);
              });

            } catch{}
            try { scanExistingEntries(); } catch{}
          }
        });
      }
    } catch {}

    const state = {
      cache: new Map(), // name -> data(json)
      tries: new WeakMap(), // entryEl -> retry count
    };

    const debounce = (fn, wait=250)=>{ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; };

    function debug(...args){ try{ console.debug('[ST-Diff][paramsDiff]', ...args);}catch{} }

    // 等待抽屉内容挂载
    function scheduleRetry($entry, max=8, delay=100){
      try{
        const el = $entry && $entry.get ? $entry.get(0) : null;
        if (!el) return;
        const n = (state.tries.get(el) || 0);
        if (n >= max) return;
        state.tries.set(el, n+1);
        setTimeout(()=> injectForEntry($entry), delay);
      }catch{}
    }

    // 对每个条目避免选择器（select2等）动态插入触发重复注入
    function shouldDebounceEntry($entry, ms=400){
      try{
        const el = $entry && $entry.get ? $entry.get(0) : null; if (!el) return false;
        state.lastInject = state.lastInject || new WeakMap();
        const now = Date.now();
        const last = state.lastInject.get(el) || 0;
        if (now - last < ms) return true;
        state.lastInject.set(el, now);
        return false;
      }catch{ return false; }
    }

    // 观察器引用及解绑函数
    let moRef = null;
    function unbindObserver(){ try{ if (moRef){ moRef.disconnect(); moRef = null; } } catch{} }

    // 在作用域下按字段删除我们注入的B侧UI（防止重渲染导致重复注入）
    function removeBForField($scope, fieldKey){
      if (!fieldKey) return;
      try {
        $scope.find(`.stdiff-inline[data-stdiff-field="${fieldKey}"], .stdiff-bline[data-stdiff-field="${fieldKey}"], .stdiff-bplain[data-stdiff-field="${fieldKey}"]`).each(function(){
          const $n=$(this); destroySelect2Under($n); $n.remove();
        });
      } catch{}
    }



    // 统一清理：销毁选择器与移除已注入DOM
    function destroySelect2Under($root){
      try { $root.find('select').each(function(){ const $sel=$(this); if ($sel.data('select2')){ try{ $sel.select2('destroy'); } catch{} } }); } catch{}
      try { $root.find('.select2-container').remove(); } catch{}
    }
    function cleanupInjectedUnder($root){
      try { $root.find('.stdiff-inline, .stdiff-bline, .stdiff-bplain').each(function(){ const $n=$(this); destroySelect2Under($n); $n.remove(); }); } catch{}
    }

    // 折叠/展开联动：受酒馆 inline-drawer 显隐与禁用态控制
    function toggleHeaderBVisibility($entry){
      try{
        const $content = $entry.find('.inline-drawer-content').first();
        const isOpen = $content.length && $content.is(':visible');
        const isDisabled = $entry.hasClass('disabledWIEntry') || $entry.find('.disabledWIEntry').length>0;
        const $headers = $entry.find('.stdiff-bplain.stdiff-b-header');
        if (isOpen && !isDisabled){ $headers.show(); } else { $headers.hide(); }
      }catch{}
    }

    async function ensureBook(name){
      if (!name) { debug('ensureBook: empty name'); return null; }
      if (state.cache.has(name)) { debug('ensureBook: hit cache', name); return state.cache.get(name); }
      let data = null;
      // 使用 ctx 和 repo
      try {
        if (typeof ctx?.loadWorldInfo === 'function') {
          data = await ctx.loadWorldInfo(name);
          debug('ensureBook via ctx.loadWorldInfo', name, !!data);
        }
      } catch(e){ debug('ensureBook ctx.loadWorldInfo error', e?.message||e); }
      if (!data) {
        try { data = await api.get(name); debug('ensureBook via repo.get', name, !!data); } catch(e){ debug('ensureBook repo.get error', e?.message||e); }
      }
      if (data) state.cache.set(name, data);
      else debug('ensureBook failed for', name);
      return data;
    }

    function getSelectedAName(){
      // 直接取编辑器下拉
      const sel = document.querySelector('#world_editor_select');
      if (sel && sel.selectedIndex >= 0){
        const txt = sel.options?.[sel.selectedIndex]?.textContent?.trim();
        return txt || sel.value || '';
      }
      // 退化尝试
      const s2 = document.querySelector('#worlds_select') || document.querySelector('#world_editor_select_list');
      if (s2 && s2.selectedIndex>=0){
        const txt = s2.options?.[s2.selectedIndex]?.textContent?.trim();
        return txt || s2.value || '';
      }
      return '';
    }

    function getSelectedBName(){
      // 优先读扩展面板的下拉
      try {
        const el = document.querySelector('#stdiff-worldbook-b');
        const v = el && typeof el.value === 'string' ? el.value.trim() : '';
        if (v) return v;
      } catch{}
      // 回退读持久化
      try { return (ctx.extensionSettings||window.extension_settings)?.['st-diff']?.worldinfo?.lastSelectedB || ''; } catch{ return ''; }
    }

    function keySignature(entry){
      try{ const k = (entry?.key||[]).join(',').toLowerCase(); const s=(entry?.keysecondary||[]).join(',').toLowerCase(); return k+'||'+s; }catch{ return ''; }
    }

    function findEntryInBookByA(book, aEntry){
      if (!book?.entries || !aEntry) return null;
      const norm = (s)=> (s??'').toString().replace(/\s+/g,' ').trim().toLowerCase();
      // 优先用“标题（comment/title）”进行同名匹配（忽略空白与大小写差异）
      if (aEntry.comment){
        const target = norm(aEntry.comment);
        for (const uid of Object.keys(book.entries)){
          const e = book.entries[uid];
          const title = norm(e?.comment ?? e?.title ?? '');
          if (title && title === target) return e;
        }
      }
      // 回退：再尝试关键字签名匹配
      const sig = keySignature(aEntry);
      if (sig){
        for (const uid of Object.keys(book.entries)){
          const e = book.entries[uid];
          if (keySignature(e) === sig) return e;
        }
      }
      return null;
    }

    function readAEntryFromDom($entry){
      try {
        // 容错：UID 可能不存在或不是属性，尝试多种位置读取，即使没有UID也继续返回其他信息
        let uidRaw = $entry.attr('uid') || $entry.data('uid');
        if (!uidRaw) {
          try { uidRaw = $entry.find('input[name="uid"]').val(); } catch {}
          if (!uidRaw) {
            try {
              const t = ($entry.find('.WIEntryTitleAndStatus').text()||'');
              const m = t.match(/UID\s*[:：]\s*(\d+)/i);
              if (m) uidRaw = m[1];
            } catch {}
          }
        }
        const uid = (uidRaw!==undefined && uidRaw!==null && String(uidRaw).trim()!=='') ? Number(uidRaw) : undefined;

        // 从DOM读取部分值用于匹配：关键字/副关键字/标题
        const comment = $entry.find('textarea[name="comment"]').val();
        const key = [];
        try {
          // 优先读 select2 里的 token
          $entry.find('.keyprimary .select2-selection__rendered .item').each((_,el)=> key.push(el.textContent.trim()));
          if (!key.length){
            const raw = String($entry.find('textarea[name="key"]').val()||'');
            raw.split(',').map(x=>x.trim()).filter(Boolean).forEach(x=> key.push(x));
          }
        } catch{}
        const keysecondary = [];
        try {
          $entry.find('.keysecondary .select2-selection__rendered .item').each((_,el)=> keysecondary.push(el.textContent.trim()));
          if (!keysecondary.length){
            const raw = String($entry.find('textarea[name="keysecondary"]').val()||'');
            raw.split(',').map(x=>x.trim()).filter(Boolean).forEach(x=> keysecondary.push(x));
          }
        } catch{}
        return { uid, comment, key, keysecondary };
      } catch { return null; }
    }

    function createBLabel(text){
      const $small = $('<small class="textAlignCenter" style="display:block;margin-bottom:2px;color:var(--SmartThemeBorderColor,#888);"></small>');
      $small.text(text + '（世界书B）');
      return $small;
    }

	    function createALabel(text){
	      const $small = $('<small class="textAlignCenter" style="display:block;margin-bottom:2px;color:var(--SmartThemeBorderColor,#888);"></small>');
	      $small.text(text);
	      return $small;
	    }
	    function ensureATitleInsideBlock($controlBlock, text, fieldKey){
	      if (!$controlBlock || !$controlBlock.length) return;
	      const sel = fieldKey ? `small.stdiff-ahead[data-stdiff-a="${fieldKey}"]` : 'small.stdiff-ahead';
	      if ($controlBlock.children(sel).length) return;
	      const $lb = createALabel(text).addClass('stdiff-ahead');
	      if (fieldKey) $lb.attr('data-stdiff-a', fieldKey);
	      $controlBlock.prepend($lb);
	    }


    function insertBRowField($controlBlock, fieldKey){
      // 在同一控件块内部追加唯一的虚线框B行并去重
      if (!$controlBlock || !$controlBlock.length) return $('<div/>');
      const sel = fieldKey ? `.stdiff-bline[data-stdiff-field="${fieldKey}"]` : '.stdiff-bline';
      const $exists = $controlBlock.children(sel);
      if ($exists.length) return $exists.first();
      const $row = $('<div class="stdiff-bline" style="margin:6px 0;padding:4px;border:1px dashed var(--SmartThemeBorderColor,#ccc);border-radius:4px;background:transparent;"></div>');
      if (fieldKey) $row.attr('data-stdiff-field', fieldKey);
      $controlBlock.append($row);
      return $row;
    }

    function insertBRow($controlBlock){ return insertBRowField($controlBlock, null); }

    function applyThemeSelect($sel){
      // 保持与酒馆全局主题一致
      return $sel;
    }

    function makeTriStateSelect(init){
      const $sel = $('<select class="text_pole widthNatural margin0"></select>');
      $sel.append('<option value="null">跟随全局</option>');
      $sel.append('<option value="true">是</option>');
      $sel.append('<option value="false">否</option>');
      const val = (init===null || init===undefined) ? 'null' : (init ? 'true' : 'false');
      $sel.val(val);
      return applyThemeSelect($sel);
    }

    function makeCheckbox(init){
      const $label = $('<label class="checkbox flex-container alignitemscenter flexNoGap"></label>');
      const $cb = $('<input type="checkbox" />');
      $cb.prop('checked', !!init);
      $label.append($cb).append($('<span></span>'));
      return { $label, $cb };
    }

    function makeNumberInput(init, { min=0, max=999999 }={}){
      const $inp = $(`<input type="number" class="text_pole margin0" min="${min}" max="${max}" />`);
      if (init!==null && init!==undefined && init!=='') $inp.val(init);
      return $inp;
    }

    // 主要关键字（逗号分隔文本）
    function wireKeywords($row, label, initArr, onChange){
      $row.append(createBLabel(label));
      const txt = Array.isArray(initArr) ? initArr.join(',') : '';
      const isOptional = /可选/.test(label);
      const ph = isOptional ? '逗号分割列表（如果为空则忽略）' : '逗号分割列表';
      const $inp = $(`<input type="text" class="text_pole margin0" placeholder="${ph}" />`).val(txt);
      $row.append($inp);
      $inp.on('input', (e, meta)=>{
        if (e && (e.isTrigger || e.originalEvent?.isTrusted === false)) return;
        if (meta && meta.noSave === true) return;
        const arr = ($inp.val()||'').toString().split(',').map(s=>s.trim()).filter(Boolean);
        onChange(arr);
      });
    }

    // 逻辑下拉（克隆A侧select[name="entryLogicType"]，选项顺序：与任意/与所有/非所有/非任何）
    function wireLogicSelect($row, label, $selA, initVal, onChange){
      $row.append(createBLabel(label));
      const $sel = $('<select class="text_pole widthNatural margin0"></select>');
      try { $selA.children().each((_,opt)=> $sel.append($(opt).clone())); } catch{}
      $row.append($sel);
      // 设置初值：优先按 value 匹配，否则按索引
      let setOk = false;
      if (initVal !== undefined && initVal !== null){
        try { $sel.val(String(initVal)); setOk = ($sel.val() === String(initVal)); } catch{}
      }
      if (!setOk){
        const idx = Math.max(0, Math.min(3, Number(initVal)||0));
        try { $sel.prop('selectedIndex', idx); } catch{}
      }
      let initializing = true; setTimeout(()=>{ initializing = false; }, 0);
      $sel.on('input', ()=>{
        if (initializing) return;
        const v = $sel.val();
        const n = Number(v);
        const idx = $sel.prop('selectedIndex');
        onChange(!isNaN(n) ? n : idx);
      });
    }

    // 根据 input[name] 在条目内查找对应的label（兼容多种class结构）
    function findCheckboxLabelByInputName($entry, inputName){
      // 优先返回“可见”的label，避免命中隐藏模板节点
      let $labs = $entry.find(`label.checkbox:has(input[name="${inputName}"])`).filter(':visible');
      if ($labs.length) return $labs.first();
      $labs = $entry.find(`label.checkbox_label:has(input[name="${inputName}"])`).filter(':visible');
      if ($labs.length) return $labs.first();
      // 回退：从可见的input反查
      let $inp = $entry.find(`input[name="${inputName}"]`).filter(':visible').first();
      if (!$inp.length) $inp = $entry.find(`input[name="${inputName}"]`).first();
      if ($inp.length){
        let $lab = $inp.closest('label');
        if ($lab.length && $lab.is(':visible')) return $lab;
        const $blk = $inp.closest('.world_entry_form_control');
        if ($blk.length){
          $lab = $blk.find('label.checkbox:visible, label.checkbox_label:visible').first();
          if ($lab.length) return $lab;
        }
      }
      return $();
    }



    async function saveBField(B_name, B_data, entry, field, value, originalKeyPath){
      if (!B_name || !B_data || !entry) return;
      try {
        entry[field] = value;
        // 可选：更新 original map（非必须，但是还是放在这里吧....万一以后用得上呢）


        // originalKeyPath 
        await api.saveBook(B_name, B_data);
      } catch(e){ console.warn('[ST-Diff][paramsDiff] save failed', field, e); }
    }

    function wireTriState($row, label, initVal, onChange){
      $row.append(createBLabel(label));
      const $control = makeTriStateSelect(initVal);
      $row.append($control);
      $control.on('input', ()=>{
        const v = $control.val();
        onChange(v==='null'? null : (v==='true'));
      });
    }

    function wireCheckbox($row, label, initVal, onChange){
      const { $label, $cb } = makeCheckbox(initVal);
      $label.find('span').text(label + '（世界书B）');
      $row.append($label);
      $cb.on('input', ()=> onChange($cb.prop('checked')));
    }

    function wireNumber($row, label, initVal, limits, onChange){
      $row.append(createBLabel(label));
      const $inp = makeNumberInput(initVal, limits);
      $row.append($inp);
      let initializing = true; setTimeout(()=>{ initializing = false; }, 0);
      $inp.on('input', ()=>{ if (initializing) return; onChange(Number($inp.val())); });
    }

    // 无边框的B行，复用酒馆纵向控件样式（按字段去重），不带 world_entry_form_control避免破坏A侧横向布局
    function insertBSlimField($controlBlock, fieldKey){
      if (!$controlBlock || !$controlBlock.length) return $('<div/>');
      const sel = fieldKey ? `.stdiff-bplain[data-stdiff-field="${fieldKey}"]` : '.stdiff-bplain';
      const $exists = $controlBlock.children(sel);
      if ($exists.length) return $exists.first();
      const $row = $('<div class="stdiff-bplain" style="margin:4px 0 2px 0;"></div>');
      if (fieldKey) $row.attr('data-stdiff-field', fieldKey);
      $controlBlock.append($row);
      return $row;
    }

    function insertBPlainField($controlBlock, fieldKey){
      if (!$controlBlock || !$controlBlock.length) return $('<div/>');
      const sel = fieldKey ? `.stdiff-bplain[data-stdiff-field="${fieldKey}"]` : '.stdiff-bplain';
      const $exists = $controlBlock.children(sel);
      if ($exists.length) return $exists.first();
      const $row = $('<div class="stdiff-bplain world_entry_form_control" style="margin:6px 0;"></div>');
      if (fieldKey) $row.attr('data-stdiff-field', fieldKey);
      $controlBlock.append($row);
      return $row;

    // 复刻全局“触发策略”下拉为B侧只读展示
    function wireGlobalStrategySelect($row, label, $globalSel){
      $row.append(createBLabel(label));
      const $sel = $('<select class="text_pole widthNatural margin0" disabled></select>');
      try {
        $globalSel.find('option').each((_, opt)=>{
          const $o = $('<option></option>').attr('value', opt.value).text($(opt).text());
          $sel.append($o);
        });
        $sel.val($globalSel.val());
        // 跟随全局变更
        const update = ()=> $sel.val($globalSel.val());
        $globalSel.on('input.stdifft', update);
        $globalSel.on('change.stdifft', update);
      } catch{}
      $row.append($sel);
    }

    }
    function insertBPlain($controlBlock){ return insertBPlainField($controlBlock, null); }

    function wireText($row, label, initVal, onChange){
      $row.append(createBLabel(label));
      const $inp = $('<input type="text" class="text_pole margin0" />');
      if (initVal !== undefined && initVal !== null) $inp.val(initVal);
      $row.append($inp);
      $inp.on('input', (e)=>{ if (e && e.originalEvent && e.originalEvent.isTrusted === false) return; onChange(($inp.val()||'').toString()); });
    }

    function findBlockForInput($inp){
      let $blk = $inp.closest('.world_entry_form_control');
      if ($blk.length) return $blk;
      $blk = $inp.closest('.flex2, .flex4, .flex1');
      if ($blk.length) return $blk;
      return $inp.parent();
    }

    // 基于A侧select2复刻的角色/标签绑定选择器（世界书B）
    function wireCharacterFilterSelect($row, $selA, initCF, onChange){
      $row.append(createBLabel('绑定到角色或标签'));
      const $sel = $('<select class="text_pole margin0" multiple="multiple" style="width:100%"></select>');
      try { $selA.children().each((_,opt)=> $sel.append($(opt).clone())); } catch{}
      $row.append($sel);
      const names = Array.isArray(initCF?.names) ? initCF.names : [];
      const tags = Array.isArray(initCF?.tags) ? initCF.tags : [];
      const isTagOpt = ($o)=> String($o.text()||'').trim().startsWith('#') || String($o.val()||'').trim().startsWith('#') || String($o.data('type')||'')==='tag';
      // 预选
      $sel.find('option').each(function(){
        const $o=$(this); const txt=String($o.text()||'').trim(); const val=String($o.val()||'').trim();
        if (isTagOpt($o)){
          const t = txt.startsWith('#')? txt.slice(1) : (val.startsWith('#')? val.slice(1) : txt);
          if (tags.includes(t)) $o.prop('selected', true);
        } else {
          if (names.includes(txt) || names.includes(val)) $o.prop('selected', true);
        }
      });
      // 初始化 select2 可能触发一次 change，这里做防抖与基线对比避免误保存
      let initializing = true;
      const snapshot = ()=>{
        const out = { names: [], tags: [] };
        $sel.find('option:selected').each(function(){
          const $o = $(this);
          const txt = String($o.text()||'').trim();
          const val = String($o.val()||'').trim();
          if (isTagOpt($o)){
            const t = txt.startsWith('#')? txt.slice(1) : (val.startsWith('#')? val.slice(1) : txt);
            if (t) out.tags.push(t);
          } else {
            const n = txt || val; if (n) out.names.push(n);
          }
        });
        return out;
      };
      let baseline = JSON.stringify(snapshot());
      // 延迟初始化 select2：首次按下时阻止原生下拉，初始化后自动打开；确保下拉不瞬间收起
      const initSelect2 = ()=>{ try{ if ($.fn.select2 && !$sel.data('select2')){ $sel.select2({ width:'100%', dropdownParent: $row }); } }catch{} };
      $sel.one('mousedown.stdifft', function(e){ e.preventDefault(); e.stopPropagation(); initSelect2(); setTimeout(()=>{ try{ $sel.select2('open'); }catch{} }, 0); });
      $sel.one('focusin.stdifft init.stdifft', initSelect2);
      setTimeout(()=>{ initializing = false; baseline = JSON.stringify(snapshot()); }, 0);
      $sel.on('change.stdifft', ()=>{
        const out = snapshot();
        if (initializing) return;
        if (JSON.stringify(out) === baseline) return;
        onChange(out);
        baseline = JSON.stringify(out);
      });
    }


    function wireDelayRecursionLevel($row, label, initVal, onChange){
      $row.append(createBLabel(label));
      const $inp = $('<input type="text" class="text_pole margin0" placeholder="1" />');
      if (initVal !== undefined && initVal !== null && initVal !== false) $inp.val(initVal);
      $row.append($inp);
      $inp.on('input', ()=>{
        const content = ($inp.val()||'').toString();
        let value;
        if (content === '') {
          value = (typeof initVal === 'boolean') ? initVal : true;
        } else if (content === '1' || content === 1) {
          value = true;
        } else if (!isNaN(Number(content))) {
          value = Number(content);
        } else {
          value = false;
        }
        onChange(value);
      });
    }

    function wireCharFilterPlain($row, cf, onChange){
      const names = Array.isArray(cf?.names) ? cf.names.join(',') : '';
      const tags = Array.isArray(cf?.tags) ? cf.tags.join(',') : '';
      // 角色名
      $row.append(createBLabel('角色名（逗号分隔）'));
      const $names = $('<input type="text" class="text_pole margin0" placeholder="Alice,Bob" />').val(names);
      $row.append($names);
      // 标签
      $row.append(createBLabel('标签（逗号分隔）'));


      const $tags = $('<input type="text" class="text_pole margin0" placeholder="#tag1,#tag2" />').val(tags);
      $row.append($tags);
      // 排除
      const { $label, $cb } = makeCheckbox(!!cf?.isExclude);
      $label.find('span').text('排除（世界书B）');
      $row.append($label);
      const save = ()=>{
        const out = {
          names: ($names.val()||'').toString().split(',').map(s=>s.trim()).filter(Boolean),
          tags: ($tags.val()||'').toString().split(',').map(s=>s.trim()).filter(Boolean),
          isExclude: !!$cb.prop('checked'),
        };
        onChange(out);
      };
      $names.on('input', save); $tags.on('input', save); $cb.on('input', save);
    }

    function wireEntryState($row, initConstant, initVectorized, setConstant, setVectorized){
      $row.append(createBLabel('状态'));
      const $sel = $('<select class="text_pole widthNatural margin0"></select>');
      $sel.append('<option value="normal">🟢</option>');
      $sel.append('<option value="constant">🔵</option>');
      $sel.append('<option value="vectorized">🔗</option>');
      let v = 'normal';
      if (initVectorized) v = 'vectorized'; else if (initConstant) v = 'constant';
      $sel.val(v);
      $row.append($sel);
      $sel.on('input', ()=>{
        const val = $sel.val();
        if (val === 'vectorized'){ setVectorized(true); setConstant(false); }
        else if (val === 'constant'){ setVectorized(false); setConstant(true); }
        else { setVectorized(false); setConstant(false); }
      });
    }

    function wirePosition($row, label, initPos, initRole, $selA, onChange){
      $row.append(createBLabel(label));
      const $sel = $('<select class="text_pole widthNatural margin0"></select>');
      try { $selA.children().each((_,opt)=> $sel.append($(opt).clone())); } catch{}
      $row.append($sel);
      // 选择当前
      try {
        const roleStr = (initRole==null)? '' : String(initRole);
        const $opt = $sel.find(`option[value="${initPos}"][data-role="${roleStr}"]`);
        if ($opt.length) $opt.prop('selected', true); else $sel.val(String(initPos));
      } catch {}
      let initializing = true; setTimeout(()=>{ initializing = false; }, 0);
      $sel.on('input', ()=>{
        if (initializing) return;
        const pos = Number($sel.val());
        const roleAttr = $sel.find(':selected').data('role');
        const role = (pos===4) ? (roleAttr===''? null : Number(roleAttr)) : null;
        onChange({ position: isNaN(pos)?0:pos, role });
      });
      return $sel;
    }

    async function injectForEntry($entry){
      try{
        if (shouldDebounceEntry && shouldDebounceEntry($entry)) { debug('debounced'); return; }
        const A_name = getSelectedAName();
        const B_name = getSelectedBName();
        log('injectForEntry start', { A_name, B_name, uid: $entry.attr('uid')||$entry.data('uid') });
        if (!A_name || !B_name) return;
        // 若 B 未选择或等于 A，则不注入，防止对 A 造成任何干扰
        if (!B_name || B_name === A_name) { debug('skip inject: invalid B or B==A', { A_name, B_name }); return; }
        const A_data = await ensureBook(A_name);
        const B_data = await ensureBook(B_name);
        if (!A_data || !B_data) return;
        // 兼容：防止某些神秘的酒馆版本 entries 为数组，转为对象（按 uid/id/_id 索引）
        try {
          if (Array.isArray(B_data.entries)){
            const obj = {}; for (const it of B_data.entries){ const uid = (it?.uid ?? it?.id ?? it?._id ?? '').toString(); if (uid) obj[uid]=it; }
            if (Object.keys(obj).length) B_data.entries = obj;
          }
        } catch{}
        log('books loaded', { A_entries: A_data?.entries && Object.keys(A_data.entries).length, B_entries: B_data?.entries && Object.keys(B_data.entries).length });

        const aLite = readAEntryFromDom($entry);
        log('aLite', aLite);
        if (!aLite) return;
        const aEntry = A_data.entries?.[aLite.uid];
        let bEntry = findEntryInBookByA(B_data, aLite) || B_data.entries?.[aLite.uid];
        const bWasMissing = !bEntry;
        if (!bEntry) { bEntry = { __pendingCreate: true }; }

        // 仅在抽屉内容已渲染时插入；并且只检查抽屉内部是否已有我们的区块
        const $drawer = $entry.find('.inline-drawer-outlet, .inline-drawer-content').first();
        if (!$drawer.length){ debug('drawer not found, retry'); scheduleRetry($entry, 15, 120); return; }
        if ($drawer.children().length === 0){ debug('drawer empty, retry'); scheduleRetry($entry, 15, 120); return; }
        // 允许同一控件块内出现多个 B 行（区分不同字段），仅避免重复对同一字段二次注入由 insertBRow 去重

        // 提前定位标题区域（少量提示用），但不再用于插入位置
        const $titleZone = $entry.find('.WIEntryTitleAndStatus');



        // 辅助：确保B侧条目存在（必要时根据A的关键信息自动创建）
        async function ensureBEntryExists(){
          // 不在此处创建/写入 entries，避免无交互时产生占位条目
          if (bEntry && bEntry.uid) return bEntry;
          return null;
        }


        // 暂存：记录哪些世界书存在未保存的更改（按世界书名）
        state.stagedBooks = state.stagedBooks || new Set();

        // 导出“保存暂存”动作供面板按钮调用
        try {
          const g = (window.STDiff = window.STDiff || {});
          g.worldinfo = g.worldinfo || {};
          if (typeof g.worldinfo.commitStaging !== 'function'){
            g.worldinfo.commitStaging = async ()=>{
              if (!state.stagedBooks || state.stagedBooks.size===0){ try{ toastr?.info?.('没有可保存的暂存更改'); }catch{} return; }
              const repo2 = await import('./repo.js');
              const api2 = repo2.createWorldbookRepo(ctx);
              let okCount = 0, failCount = 0;
              for (const bookName of Array.from(state.stagedBooks)){
                const data = state.cache.get(bookName) || await ensureBook(bookName);
                if (!data) { failCount++; continue; }
                try {
                  const res = await api2.saveBook(bookName, data);
                  if (res?.ok){ okCount++; state.stagedBooks.delete(bookName); }
                  else { failCount++; }
                } catch(e){ console.warn('[ST-Diff][paramsDiff] staging save failed', bookName, e?.message||e); failCount++; }
              }
              try {
                if (okCount && !failCount) toastr?.success?.(`已保存 ${okCount} 本世界书的暂存更改`);
                else if (okCount || failCount) toastr?.warning?.(`保存完成：成功 ${okCount}，失败 ${failCount}`);
                else toastr?.info?.('没有可保存的暂存更改');
              } catch{}
            };
          }
        } catch{}

        // 包装保存器：先确保条目存在，再写值并保存
        function makeSetter(field, originalKeyPath){
          return async (val)=>{
            // 只读模式下直接跳过写入
            try {
              const ro = !!((ctx.extensionSettings||window.extension_settings)?.['st-diff']?.worldinfo?.readonly);
              if (ro) { debug('readonly, skip save for field', field); return; }
            } catch {}
            // 首次真实修改时再创建并挂入 B.entries，避免无交互产生占位条目
            if (!bEntry || !bEntry.uid){
              const entries = B_data.entries || (B_data.entries = {});
              let maxId = 0; Object.keys(entries).forEach(k=>{ const n = parseInt(k); if (!isNaN(n) && n>maxId) maxId=n; });
              const newUid = maxId + 1;
              const created = {
                uid: newUid,
                key: [], keysecondary: [], comment: '', content: '',
                order: 0, depth: 0, position: 0, probability: 100, useProbability: true,
                group: '', groupOverride: false, groupWeight: 100,
                excludeRecursion: false, preventRecursion: false,
                selective: false, selectiveLogic: 0,
                scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
                delayUntilRecursion: false, sticky: null, cooldown: null, delay: null,
                characterFilter: { names:[], tags:[], isExclude:false }, disable: false, addMemo: false,
              };
              entries[newUid] = created; bEntry = created;
            }
            bEntry[field] = val;
            const settingsRoot = (ctx.extensionSettings||window.extension_settings);
            const staging = !!settingsRoot?.['st-diff']?.worldinfo?.staging;
            if (staging){
              try { state.stagedBooks.add(B_name); toastr?.info?.('已暂存更改（未写入磁盘）', field); } catch{}
              debug('staged', B_name, bEntry.uid, field, val);
            } else {
              try { await api.saveBook(B_name, B_data); } catch(e){ console.warn('[ST-Diff][paramsDiff] save error', e?.message||e); }
              debug('saved', B_name, bEntry.uid, field, val);
            }
          };
        }

        // 0) 主要关键字 / 逻辑 / 可选过滤器
        // 0.1 主要关键字
        const $keyA = $entry.find('select[name="key"], textarea[name="key"]').first();
        if ($keyA.length){
          removeBForField($entry, 'key');
          const $blk = findBlockForInput($keyA);
          const $row = insertBPlainField($blk, 'key');
          wireKeywords($row, '主要关键字', bEntry.key, makeSetter('key'));
        }
        // 0.2 逻辑（与任意/与所有/非所有/非任何）
        const $logicA = $entry.find('select[name="entryLogicType"]').first();
        if ($logicA.length){
          removeBForField($entry, 'selectiveLogic');
          const $blk = $logicA.closest('.world_entry_form_control, .flex1, .flex2, .flex4');
          const $row = insertBPlainField($blk, 'selectiveLogic');
          wireLogicSelect($row, '逻辑', $logicA, bEntry.selectiveLogic, makeSetter('selectiveLogic'));
        }
        // 0.3 可选过滤器（次关键字，逗号分隔文本）
        const $secA = $entry.find('select[name="keysecondary"], textarea[name="keysecondary"]').first();
        if ($secA.length){
          removeBForField($entry, 'keysecondary');
          const $blk = findBlockForInput($secA);
          const $row = insertBPlainField($blk, 'keysecondary');
          wireKeywords($row, '可选过滤器', bEntry.keysecondary, makeSetter('keysecondary'));
        }

        // 1) Tri-state（B参数使用“虚线框 + 上下两行”结构，复用原UI的 .world_entry_form_control 与 <small> 标签字号）
        function addBBlockInsideControl($selectElem, label, initVal, field){
          const $controlBlock = $selectElem.closest('.world_entry_form_control');
          if (!$controlBlock.length) return;
          // 保持与其他B参数风格一致
          const $row = insertBPlainField($controlBlock, field); // 同字段唯一
          $row.empty();
          $row.append(createBLabel(label));
          const $sel = makeTriStateSelect(initVal);
          $row.append($sel);
          $sel.on('input', ()=> makeSetter(field)($sel.val()==='null'?null:($sel.val()==='true')));
        }

        const $caseA = $entry.find('select[name="caseSensitive"]').first();
        if ($caseA.length){ addBBlockInsideControl($caseA, '区分大小写', bEntry.caseSensitive, 'caseSensitive'); }

        const $wholeA = $entry.find('select[name="matchWholeWords"]').first();
        if ($wholeA.length){ addBBlockInsideControl($wholeA, '使用全词', bEntry.matchWholeWords, 'matchWholeWords'); }

        const $grpScoreA = $entry.find('select[name="useGroupScoring"]').first();
        if ($grpScoreA.length){ addBBlockInsideControl($grpScoreA, '组评分', bEntry.useGroupScoring, 'useGroupScoring'); }


        // 2) Checkboxes（A、B 两列并排。将原 label 包装进一行容器，并把B复选框放在同一行右侧）
        function ensureInlineRow($anchorLabel){
          if ($anchorLabel.parent().hasClass('stdiff-inline-row')) return $anchorLabel.parent();
          const $row = $('<div class="stdiff-inline-row" style="display:flex;flex-direction:row;align-items:baseline;gap:12px;justify-content:space-between;"></div>');
          $anchorLabel.after($row);
          $row.append($anchorLabel);
          $row.find('label.checkbox').css({flex:'1 1 0', whiteSpace:'normal'});
          return $row;
        }
        function addInlineCheckboxAfter($anchorLabel, text, initVal, onChange, fieldKey){
          const { $label, $cb } = makeCheckbox(initVal);
          $label.addClass('stdiff-inline');
          if (fieldKey) $label.attr('data-stdiff-field', fieldKey);
          $label.css({ marginLeft: '0' });
          $label.find('span').text(text + '（世界书B）');
          $cb.on('input', ()=> onChange($cb.prop('checked')));
          const $row = ensureInlineRow($anchorLabel);
          // 同字段唯一：只移除同字段的B列
          if (fieldKey) $row.children(`label.stdiff-inline[data-stdiff-field="${fieldKey}"]`).remove();
          else $row.children('label.stdiff-inline').remove();
          // 右对齐到与A一致的位置
          $row.css({ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:'12px' });
          $row.children('label.checkbox').css({flex:'1 1 0'});
          $row.append($label);
        }
        const $ex = findCheckboxLabelByInputName($entry, 'excludeRecursion');
        if ($ex.length){ removeBForField($entry, 'excludeRecursion'); addInlineCheckboxAfter($ex, '不可递归', bEntry.excludeRecursion, makeSetter('excludeRecursion'), 'excludeRecursion'); }
        const $prv = findCheckboxLabelByInputName($entry, 'preventRecursion');
        if ($prv.length){ removeBForField($entry, 'preventRecursion'); addInlineCheckboxAfter($prv, '防止进一步递归', bEntry.preventRecursion, makeSetter('preventRecursion'), 'preventRecursion'); }
        // 容错：若未找到label，尝试创建并插入到 excludeRecursion 之后
        let $delay = findCheckboxLabelByInputName($entry, 'delay_until_recursion');
        if (!$delay.length){
          const $exLab = findCheckboxLabelByInputName($entry, 'excludeRecursion');
          if ($exLab.length){
            const $tmp = $('<label class="checkbox"><input type="checkbox" name="delay_until_recursion"><span></span></label>');
            $exLab.after($tmp);
            $delay = $tmp;
          }
        }
        if ($delay.length){
          // 注意：这里我只能把flag与等级使用不同的字段键，避免后续“递归等级”注入时清理掉本行（可能有其他方法？
          removeBForField($entry, 'delayUntilRecursionFlag');
          const delayFlag = !!(bEntry.delayUntilRecursion === true || (typeof bEntry.delayUntilRecursion === 'number' && bEntry.delayUntilRecursion > 0));
          addInlineCheckboxAfter($delay, '延迟到递归', delayFlag, (val)=>{
            if (!val) return makeSetter('delayUntilRecursion')(false);
            const cur = bEntry.delayUntilRecursion;
            makeSetter('delayUntilRecursion')(typeof cur === 'number' ? cur : true);
          }, 'delayUntilRecursionFlag');
        }

        // 3) 数值参数（组权重）
        const $groupWeightInp = $entry.find('input[name="groupWeight"]').first();
        if ($groupWeightInp.length){
          const $groupWeightBlk = findBlockForInput($groupWeightInp);
          removeBForField($entry, 'groupWeight');
          const $row = insertBPlainField($groupWeightBlk, 'groupWeight');
          wireNumber($row, '组权重', bEntry.groupWeight, {min:1,max:10000}, makeSetter('groupWeight'));
        }

        // 4) 文本/数值（按酒馆全局样式，上下两行布局）
        // 4.1 扫描深度
        const $scanDepthInp = $entry.find('input[name="scanDepth"]').first();
        // A侧错位的小标题：将原来在外层表头的说明，内嵌到对应控件块顶部，避免与B侧扩展错位
        try{
          const headerMap = [
            { name: 'position', text: '插入位置' },
            { name: 'depth', text: '深度' },
            { name: 'order', text: '顺序' },
            { name: 'probability', text: '触发概率' },
          ];
          headerMap.forEach(({name,text})=>{
            const $inp = $entry.find(`[name="${name}"]`).first();
            if ($inp.length){ const $blk = findBlockForInput($inp); ensureATitleInsideBlock($blk, text, `A-${name}`); }
          });
        }catch{}

        if ($scanDepthInp.length){
          const $scanDepthBlk = findBlockForInput($scanDepthInp);
          removeBForField($entry, 'scanDepth');
          const $row = insertBPlainField($scanDepthBlk, 'scanDepth');
          wireNumber($row, '扫描深度', bEntry.scanDepth, {min:0, max:1000}, makeSetter('scanDepth'));
        }
        // 4.2 递归等级（数值/true/false）
        const $delayLvlInp = $entry.find('input[name="delayUntilRecursionLevel"]').first();
        if ($delayLvlInp.length){
          const $delayLvlBlk = findBlockForInput($delayLvlInp);
          removeBForField($entry, 'delayUntilRecursion');
          const $row = insertBPlainField($delayLvlBlk, 'delayUntilRecursion');
          wireDelayRecursionLevel($row, '递归等级', bEntry.delayUntilRecursion, makeSetter('delayUntilRecursion'));
        }
        // 4.3 自动化ID
        const $autoInp = $entry.find('input[name="automationId"]').first();
        if ($autoInp.length){
          const $autoBlk = findBlockForInput($autoInp);
          removeBForField($entry, 'automationId');
          const $row = insertBPlainField($autoBlk, 'automationId');
          wireText($row, '自动化ID', bEntry.automationId, makeSetter('automationId'));
        }
        // 4.4 分组标签（Inclusion Group）
        const $groupInp = $entry.find('input[name="group"]').first();
        if ($groupInp.length){
          const $groupBlk = findBlockForInput($groupInp);
          removeBForField($entry, 'group');
          const $row = insertBPlainField($groupBlk, 'group');
          wireText($row, '分组标签', bEntry.group, makeSetter('group'));
        }
        // 4.5 置顶（优先）复选框：与原A并排
        const $groupOverride = $entry.find('label.checkbox_label:has(input[name="groupOverride"])').first();
        if ($groupOverride.length){ removeBForField($entry, 'groupOverride'); addInlineCheckboxAfter($groupOverride, '优先', bEntry.groupOverride, makeSetter('groupOverride'), 'groupOverride'); }
        // 4.6 粘滞/冷却/延迟
        const $stickyInp = $entry.find('input[name="sticky"]').first();
        if ($stickyInp.length){ const $stickyBlk = findBlockForInput($stickyInp); removeBForField($entry, 'sticky'); const $row = insertBPlainField($stickyBlk, 'sticky'); wireNumber($row, '粘滞', bEntry.sticky, {min:0, max:999999}, makeSetter('sticky')); }
        const $coolInp = $entry.find('input[name="cooldown"]').first();
        const $coolBlk = $coolInp.length ? findBlockForInput($coolInp) : $();

        // 6） 头部区域复刻（顺序/深度/位置/概率）
        // 顺序
        const $orderInp = $entry.find('input[name="order"]').first();
        if ($orderInp.length){
          const $orderBlk = findBlockForInput($orderInp);
          removeBForField($entry, 'order');
          const $row = insertBPlainField($orderBlk, 'order');
          $row.addClass('stdiff-b-header');
          wireNumber($row, '顺序', bEntry.order, {min:-100000, max:100000}, makeSetter('order'));
        }
        // 深度（仅当插入位置为 @D* 时显示）
        const $depthInp = $entry.find('input[name="depth"]').first();
        const $posSelA_forDepth = $entry.find('select[name="position"]').first();
        function shouldShowDepth(){
          if (!$posSelA_forDepth.length) return false;
          const val = String($posSelA_forDepth.val());
          return val === '4';
        }
        if ($depthInp.length){
          const $depthBlk = findBlockForInput($depthInp);
          const renderDepth = ()=>{
            removeBForField($entry, 'depth');
            if (!shouldShowDepth()) return;
            const $row = insertBPlainField($depthBlk, 'depth');
            $row.addClass('stdiff-b-header');
            wireNumber($row, '深度', bEntry.depth, {min:0, max:100000}, makeSetter('depth'));
            try{ toggleHeaderBVisibility($entry); }catch{}
          };
          renderDepth();
          // 跟随“位置”变化
          $posSelA_forDepth.on('change.stdifft depthsync input.stdifft', renderDepth);
        }

        // 位置（含角色）
        const $posSelA = $entry.find('select[name="position"]').first();
        if ($posSelA.length){
          removeBForField($entry, 'position');
          const $posBlk = findBlockForInput($posSelA);
          const $row = insertBPlainField($posBlk, 'position');
          $row.addClass('stdiff-b-header');
          const setPosition = makeSetter('position');
          const setRole = makeSetter('role');
          const $bPosSel = wirePosition($row, '位置', bEntry.position, bEntry.role, $posSelA, async ({ position, role })=>{
            await setPosition(position);
            await setRole(role);
          });
          // 同步：当 B 的 position 改变时，联动 B 侧“深度”的显示/隐藏
          try{
            const $depthInp_local = $entry.find('input[name="depth"]').first();
            const $depthBlk_local = $depthInp_local.length ? findBlockForInput($depthInp_local) : $();
            const syncDepthVisibility = ()=>{
              const val = String($bPosSel.val());
              if (val === '4'){
                // 仅在未渲染时渲染
                if (!$depthBlk_local.children('.stdiff-bplain[data-stdiff-field="depth"]').length){
                  removeBForField($entry, 'depth');
                  const $row = insertBPlainField($depthBlk_local, 'depth');
                  $row.addClass('stdiff-b-header');
                  const initDepth = (bEntry && bEntry.depth !== undefined) ? bEntry.depth : 0;
                  wireNumber($row, '深度', initDepth, {min:0, max:100000}, makeSetter('depth'));
                }
              } else {
                removeBForField($entry, '深度');
                removeBForField($entry, 'depth');
              }
            };
            $bPosSel.on('input.stdifft syncDepth', syncDepthVisibility);
            syncDepthVisibility();
          }catch{}

        }

        // 概率
        const $probInp = $entry.find('input[name="probability"]').first();
        if ($probInp.length){
          const $probBlk = findBlockForInput($probInp);
          removeBForField($entry, 'probability');
          const $row = insertBPlainField($probBlk, 'probability');
          $row.addClass('stdiff-b-header');
          wireNumber($row, '概率', bEntry.probability, {min:0, max:100}, makeSetter('probability'));
        }

        if ($coolBlk.length){ removeBForField($entry, 'cooldown'); const $row = insertBPlainField($coolBlk, 'cooldown'); wireNumber($row, '冷却', bEntry.cooldown, {min:0, max:999999}, makeSetter('cooldown')); }
        const $delayInp = $entry.find('input[name="delay"]').first();
        if ($delayInp.length){ const $delayBlk = findBlockForInput($delayInp); removeBForField($entry, 'delay'); const $row = insertBPlainField($delayBlk, 'delay'); wireNumber($row, '延迟', bEntry.delay, {min:0, max:999999}, makeSetter('delay')); }

        // 5) 角色/标签过滤：在原 A 的下拉块下方追加一个B块（复刻A的select2下拉）
        const $cfInp = $entry.find('select[name="characterFilter"]').first();
        if ($cfInp.length){
          const $cfBlk = findBlockForInput($cfInp);
          removeBForField($entry, 'characterFilter');
          const $row = insertBPlainField($cfBlk, 'characterFilter');
          wireCharacterFilterSelect($row, $cfInp, bEntry.characterFilter, makeSetter('characterFilter'));
        }

        // 6) 底部勾选项：不再复刻（选择性 / 使用触发概率 / 添加备忘）

        // 7) 额外匹配源（Additional Matching Sources）：与原勾选项并排
        const inlineSrc = [
          { sel: 'matchCharacterDescription', label: '角色描述' },
          { sel: 'matchCharacterPersonality', label: '角色性格' },
          { sel: 'matchScenario', label: '场景' },
          { sel: 'matchPersonaDescription', label: '人设描述' },
          { sel: 'matchCharacterDepthPrompt', label: '角色注记' },
          { sel: 'matchCreatorNotes', label: '作者注释' },
        ];
        inlineSrc.forEach(({ sel, label })=>{
          const $lab = $entry.find(`label.checkbox:has(input[name="${sel}"])`).first();
          if ($lab.length){ addInlineCheckboxAfter($lab, label, bEntry[sel], makeSetter(sel), sel); }
        });
      
      } catch(e){ console.warn('[ST-Diff][paramsDiff] inject failed', e); }
        // 全局委托：当任意条目的折叠/主开关变化时，批量同步可见性
        try{
          $(document).off('click.stdifftGlobal').on('click.stdifftGlobal', '.inline-drawer-toggle, .inline-drawer-icon, .killSwitch', debounce(()=>{
            $('.world_entry').each((_,el)=> toggleHeaderBVisibility($(el)));
          }, 80));
        }catch{}

        // 折叠/展开/主开关联动：根据酒馆 inline-drawer 与禁用态隐藏/显示 B 头部字段
        try{
          const $toggle = $entry.find('.inline-drawer-toggle, .inline-drawer-icon').first();
        // 监听 inline-drawer-content 的显示状态变化（更可靠）
        try{
          const $content = $entry.find('.inline-drawer-content').first();
          if ($content.length && window.MutationObserver){
            const mo = new MutationObserver(()=> toggleHeaderBVisibility($entry));
            mo.observe($content[0], { attributes:true, attributeFilter:['style','class'] });
            // 存档以便未来可能清理
            $entry.data('stdiff-header-mo', mo);
            // 初次同步
            toggleHeaderBVisibility($entry);
          }
        }catch{}

          const $kill = $entry.find('.killSwitch').first();
          const sync = ()=> toggleHeaderBVisibility($entry);
          $toggle.off('click.stdifft').on('click.stdifft', ()=> setTimeout(sync, 50));
          $kill.off('click.stdifft').on('click.stdifft', ()=> setTimeout(sync, 50));
          // 初次同步
          sync();
        }catch{}

    }

    // 观察条目详情展开（确保全局唯一）
    function bindObserver(){
      try { unbindObserver(); } catch{}
      const container = document.querySelector('#world_popup_entries_list') || document.getElementById('WorldInfo') || document;
      moRef = new MutationObserver((muts)=>{
        for (const m of muts){
          if (m.type === 'childList'){
            m.addedNodes?.forEach(node=>{
              if (!(node instanceof HTMLElement)) return;
              const $n = $(node);
              // 忽略 select2 的容器和子节点，避免打开下拉时触发再注入
              if ($n.hasClass('select2-container') || $n.closest('.select2-container').length) return;
              // 情况1：直接渲染了一个 world_entry
              if ($n.is && $n.is('.world_entry')){
                const $outlet = $n.find('.inline-drawer-outlet');
                if ($outlet.length){ setTimeout(()=> injectForEntry($n), 50); }
              }
              // 情况2：新建了 outlet 节点
              if ($n.classList && $n.classList.contains('inline-drawer-outlet')){
                const $entry = $n.closest('.world_entry');
                if ($entry && $entry.length){ setTimeout(()=> injectForEntry($entry), 50); }
              }
              // 情况3：向既有 outlet 内部追加了内容（editTemplate 等）
              try{
                const $entry2 = $n.closest('.world_entry');
                if ($entry2 && $entry2.length){ setTimeout(()=> injectForEntry($entry2), 50); }
              }catch{}
              // 扫描子树中的条目
              const $entries = $n.find?.('.world_entry');
              if ($entries?.length){ $entries.each((_,el)=> setTimeout(()=> injectForEntry($(el)), 50)); }
            });
          }
        }
      });
      try { moRef.observe(container, { childList:true, subtree:true }); } catch{}
    }

    bindObserver();

    // 初始全量扫描，处理页面已存在的条目
    function scanExistingEntries(){
      try { $('.world_entry').each((_,el)=> setTimeout(()=> injectForEntry($(el)), 0)); } catch {}
    }
    scanExistingEntries();

    // 绑定条目折叠/展开图标点击时机，确保注入
    try {
      $(document).off('click.stdifB').on('click.stdifB', '.inline-drawer-icon, .inline-drawer-toggle', function(){
        const $entry = $(this).closest('.world_entry');
        if ($entry && $entry.length) setTimeout(()=> injectForEntry($entry), 0);
      });

    // 方便调试：在控制台暴露一个强制注入方法
    try { window.STDiff = window.STDiff || {}; window.STDiff.forceInjectB = (sel)=>{ const $e = $(sel).closest('.world_entry'); if ($e && $e.length) injectForEntry($e); }; } catch {}

    } catch {}

  } catch (e){ console.warn('[ST-Diff][paramsDiff] init failed', e); }
}

