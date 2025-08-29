// 世界书模块入口：仅使用 getContext() 与宿主交互，内部可 import 自身文件
export async function mount(ctx){
  try{
    const html = await ctx.renderExtensionTemplateAsync('third-party/ST-Diff/modules/worldbook','panel');
    const $anchor = $('#world_popup_bottom_holder').length ? $('#world_popup_bottom_holder') : $('#world_editor_select').parent();
    $(html).insertBefore($anchor);

    // 布局：两行结构（标签行、选择框行）
    const $row = $('#stdiff-worldbook-panel .stdiff-row');
    const $label = $row.find('label').first();
    const $sel = $('#stdiff-worldbook-b');
    const $filter = $('#stdiff-worldbook-filter');
    $row.css({ display:'flex', flexDirection:'column', gap:'6px' });
    $label.css({ whiteSpace:'nowrap' });
    // 选择框半宽，由模板内联样式控制；这里确保最小宽度
    $sel.css({ minWidth:'220px' });

    // 跟随总开关显示/隐藏
    try { const root = ctx.extensionSettings || window.extension_settings; const s = root?.['st-diff']; $('#stdiff-worldbook-panel').toggle(!!s?.enabled); } catch{}

    // 选项填充（从原生世界书下拉同步）+ 持久化
    function findSourceSelect(){
      // 世界书下拉
      const candidates = Array.from(document.querySelectorAll('select'));
      for (const sel of candidates){
        const first = sel.options && sel.options.length ? (sel.options[0].textContent || '').trim() : '';
        if (/选择以编辑|Select\s*to\s*edit/i.test(first)) return sel;
      }
      // 回退：常见选择器
      const selectors = ['#worlds_select','#world_editor_select_list','#world_editor_select','select[name="world"]','.worldbook-select select'];
      for (const s of selectors){ const el = document.querySelector(s); if (el) return el; }
      return null;
    }

    function getWorldNames(){
      const set = new Set(); const list = [];
      const src = findSourceSelect();
      if (src && src.options){
        for (let i=0;i<src.options.length;i++){
          const text = (src.options[i].textContent || '').trim();
          if (!text) continue;
          // 跳过占位项“--- 选择以编辑 ---”
          if (/^[-—\s]*选择以编辑[-—\s]*$/i.test(text)) continue;
          if (/^[-—\s]*Select\s*to\s*edit[-—\s]*$/i.test(text)) continue;
          if (!set.has(text)) { set.add(text); list.push(text); }
        }
      }
      // 作为补充，加入 ctx.world_names
      try {
        const extra = Array.isArray(ctx?.world_names) ? ctx.world_names : (window.world_names || []);
        extra.forEach(v=>{ const name = (v||'').toString().trim(); if(name && !set.has(name)){ set.add(name); list.push(name); } });
      } catch {}
      return list;
    }

    // 选项源与过滤
    let allNames = [];
    let currentFilter = '';

    function renderOptions(){
      const prev = $sel.val() || '';
      const pool = allNames || [];
      const filtered = currentFilter ? pool.filter(n => n.toLowerCase().includes(currentFilter.toLowerCase())) : pool;
      $sel.empty().append(`<option value="">（未选择）</option>`);
      filtered.forEach(n=> $sel.append(`<option value="${n}">${n}</option>`));
      $sel.css({ whiteSpace:'normal' });
      // 恢复之前/已保存的选择
      if (prev && filtered.includes(prev)) {
        $sel.val(prev);
      } else {
        try{
          const root = ctx.extensionSettings || window.extension_settings;
          const saved = root?.['st-diff']?.worldinfo?.lastSelectedB || '';
          if (saved && filtered.includes(saved)) { $sel.val(saved); }
        }catch{}
      }
    }

    function refreshFromSource(){
      allNames = getWorldNames();
      renderOptions();
    }

    // 初次渲染
    refreshFromSource();

    // 过滤输入
    const debounce = (fn, wait=150) => { let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); }; };
    $filter.off('input.stdifFilter').on('input.stdifFilter', debounce(()=>{
      currentFilter = ($filter.val()||'').toString().trim();
      renderOptions();
    }, 150));

    // 同步原生世界书下拉变化/刷新
    const selectorCandidates = ['#world_editor_select','#world_editor_select_list','#worlds_select','select[name="world"]','.worldbook-select select'];
    // 初始时若已有已选 B，则预取快照（方便后续对比）
    try {
      const root = ctx.extensionSettings || window.extension_settings;
      const savedName = root?.['st-diff']?.worldinfo?.lastSelectedB || '';
      if (savedName) {
        const repo = await import('./repo.js');
        const api = repo.createWorldbookRepo(ctx);
        const snap = await api.snapshot(savedName, root['st-diff']?.ui || {});
        root['st-diff'].worldinfo.cachedB = snap;
        try { window.STDiff = window.STDiff || {}; window.STDiff.cachedB = snap; } catch {}
        try { console.log('[ST-Diff][worldbook] cachedB preloaded:', snap); } catch {}
      }
    } catch (err) {
      try { console.warn('[ST-Diff][worldbook] preload failed', err); } catch {}
    }

    $(document).off('change.stdifA');
    selectorCandidates.forEach(sel => $(document).on('change.stdifA', sel, ()=> refreshFromSource()));
    try{
      const anchors = selectorCandidates.map(s=> document.querySelector(s)).filter(Boolean);
      if (anchors.length && window.MutationObserver){
        const mo = new MutationObserver(()=> refreshFromSource());
        anchors.forEach(a=> mo.observe(a, { childList:true, subtree:true }));
      }
    }catch{}
      // 只读（禁写B）选项：加载与持久化
      try{
        const root = ctx.extensionSettings || window.extension_settings;
        root['st-diff'] = root['st-diff'] || {}; root['st-diff'].worldinfo = root['st-diff'].worldinfo || {};
        const $ro = $('#stdiff-readonly');
        $ro.prop('checked', !!root['st-diff'].worldinfo.readonly);
        $ro.off('change.stdifRO').on('change.stdifRO', ()=>{
          root['st-diff'].worldinfo.readonly = $ro.prop('checked');
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
          try { toastr.info(root['st-diff'].worldinfo.readonly? 'B写入已禁用' : 'B写入已启用', '只读模式'); } catch{}
        });
      } catch{}

      // 暂存模式（手动保存）选项：加载与持久化
      try{
        const root = ctx.extensionSettings || window.extension_settings;
        root['st-diff'] = root['st-diff'] || {}; root['st-diff'].worldinfo = root['st-diff'].worldinfo || {};
        const $st = $('#stdiff-staging');
        // 默认开启暂存模式（手动保存）
        if (root['st-diff'].worldinfo.staging === undefined) {
          root['st-diff'].worldinfo.staging = true;
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
        }
        $st.prop('checked', !!root['st-diff'].worldinfo.staging);
        $st.off('change.stdifSTG').on('change.stdifSTG', ()=>{
          root['st-diff'].worldinfo.staging = $st.prop('checked');
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
          try { toastr.info(root['st-diff'].worldinfo.staging? '已开启暂存模式' : '已关闭暂存模式'); } catch{}
        });
      } catch{}

      // 暂存“保存”按钮
      try{
        const $btnSave = $('#stdiff-staging-save');
        $btnSave.off('click.stdifSTGS').on('click.stdifSTGS', ()=>{
          try{ window.STDiff?.worldinfo?.commitStaging?.(); }catch(e){ console.warn('[ST-Diff] commitStaging error', e); }
        });
      } catch{}



    // 选项与对比 UI：持久化 + 仓库接入 + 对比按钮
    try {
      const root = ctx.extensionSettings || window.extension_settings;
      if (root) {
        root['st-diff'] = root['st-diff'] || { ui: { viewMode:'side-by-side', ignoreWhitespace:true, ignoreCase:false, jsonNormalize:true } };
        root['st-diff'].ui = Object.assign({ ignoreWhitespace:true, ignoreCase:false, jsonNormalize:true }, root['st-diff'].ui||{});
        root['st-diff'].worldinfo = root['st-diff'].worldinfo || {};

        // 勾选项初始与持久化
        const $optWS = $('#stdiff-opt-ignorews');
        const $optCase = $('#stdiff-opt-ignorecase');
        const $optJSON = $('#stdiff-opt-json');
        $optWS.prop('checked', !!root['st-diff'].ui.ignoreWhitespace);
        $optCase.prop('checked', !!root['st-diff'].ui.ignoreCase);
        $optJSON.prop('checked', !!root['st-diff'].ui.jsonNormalize);
        $optWS.on('change', ()=>{ root['st-diff'].ui.ignoreWhitespace = $optWS.prop('checked'); (ctx.saveSettingsDebounced||(()=>{}))(); });
        $optCase.on('change', ()=>{ root['st-diff'].ui.ignoreCase = $optCase.prop('checked'); (ctx.saveSettingsDebounced||(()=>{}))(); });
        $optJSON.on('change', ()=>{ root['st-diff'].ui.jsonNormalize = $optJSON.prop('checked'); (ctx.saveSettingsDebounced||(()=>{}))(); });

        // 选择变更：预取 B 快照
        $sel.off('change.stdifwb').on('change.stdifwb', async () => {
          const name = $sel.val() || null;
          root['st-diff'].worldinfo.lastSelectedB = name;
          (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
          try {
            const repo = await import('./repo.js');
            const api = repo.createWorldbookRepo(ctx);
            const snap = await api.snapshot(name, root['st-diff']?.ui || {});
            root['st-diff'].worldinfo.cachedB = snap;
            try { window.STDiff = window.STDiff || {}; window.STDiff.cachedB = snap; } catch {}
            try { console.log('[ST-Diff][worldbook] cachedB updated:', snap); } catch {}
          } catch (err) { try { console.warn('[ST-Diff][worldbook] snapshot failed', err); } catch {} }
        });

        // 对比按钮：抓取 A（页面上当前启用的世界/“选择以编辑”当前项），与 B 做对比
        $('#stdiff-run-compare').off('click.stdifRun').on('click.stdifRun', async ()=>{
          const repo = await import('./repo.js');
          const api = repo.createWorldbookRepo(ctx);
          const opts = root['st-diff'].ui || {};

          // A：尝试用“选择以编辑”的当前项（优先使用选项文本作为标题，其次再尝试 value）
          let aNameText = '';
          let aNameValue = '';
          try {
            const sel = (function(){
              const all = Array.from(document.querySelectorAll('select'));
              for (const s of all){ const t = s.options?.[0]?.textContent?.trim()||''; if (/选择以编辑|Select\s*to\s*edit/i.test(t)) return s; }
              return document.querySelector('#worlds_select') || document.querySelector('#world_editor_select_list') || document.querySelector('#world_editor_select');
            })();
            if (sel){
              aNameValue = sel.value || '';
              aNameText = sel.options?.[sel.selectedIndex]?.textContent?.trim() || aNameValue || '';
            }
          }catch{}

          const bName = $sel.val() || '';
          let aSnap = await api.snapshot(aNameText, opts);
          if ((!aSnap?.entries?.length) && aNameValue && aNameValue !== aNameText) {
            try { aSnap = await api.snapshot(aNameValue, opts); } catch {}
          }
          const bSnap = await api.snapshot(bName, opts);
          try { console.log('[ST-Diff] compare A=', aSnap?.name, aSnap?.entries?.length, 'B=', bSnap?.name, bSnap?.entries?.length); } catch {}

          try {
            const diffMod = await import('./diff.js');
            const result = diffMod.diffSnapshots(aSnap, bSnap);
            const html = diffMod.formatPreviewHtml(aSnap, bSnap, result);
            const $out = $('#stdiff-compare-output');
            $out.html(html);
            // 绑定点击：进入条目详细对比
            $out.off('click.stdiffEntry').on('click.stdiffEntry', '.stdiff-entry-link', async (ev)=>{
              ev.preventDefault();
              const $a = $(ev.currentTarget);
              const key = $a.data('key');
              const category = $a.data('category');
              const character = $a.data('character');
              const label = $a.data('label');
              const { openEntryDiffDialog } = await import('./entryDiff.js');
              await openEntryDiffDialog(ctx, aSnap, bSnap, { key, category, character, label });
            });
          } catch (err) {
            $('#stdiff-compare-output').text('对比失败：' + (err?.message||err));
          }
        });


      // 工具：刷新缓存 + 清理占位条目
      try {
        const repo = await import('./repo.js');
        const api = repo.createWorldbookRepo(ctx);
        const $btnRefresh = $('#stdiff-cache-refresh');
        const $btnClean = $('#stdiff-clean-placeholders');

        // 刷新缓存：清空扩展缓存并预读当前B
        $btnRefresh.off('click.stdifCache').on('click.stdifCache', async ()=>{
          try{
            const root = ctx.extensionSettings || window.extension_settings;
            if (root?.['st-diff']?.worldinfo){ delete root['st-diff'].worldinfo.cachedB; }
            window.STDiff = window.STDiff || {}; delete window.STDiff.cachedB;
            toastr?.info?.('已清除扩展缓存并刷新');
          }catch(e){ console.warn('[ST-Diff] refresh cache error', e); }
        });

        // 扫描并清理占位/误创建条目（B）
        $btnClean.off('click.stdifClean').on('click.stdifClean', async ()=>{
          const name = $('#stdiff-worldbook-b').val() || '';
          if (!name){ toastr?.warning?.('请先选择世界书B'); return; }
          let book = await api.get(name);
          let data = book; // 使用编辑器结构
          if (!data){ toastr?.error?.('无法加载世界书B'); return; }
          if (Array.isArray(data.entries)){
            const obj = {}; for (const it of data.entries){ const uid = (it?.uid ?? it?.id ?? it?._id ?? '').toString(); if (uid) obj[uid]=it; } data.entries=obj;
          }
          data.entries ||= {};
          const isDefault = (v, def) => (v===undefined || v===null) ? true : String(v)===String(def);
          const candidates = [];
          for (const [uid, e] of Object.entries(data.entries)){
            const comment = (e.comment||'').toString().trim();
            const content = (e.content||'').toString().trim();
            const hasKeys = (Array.isArray(e.keys)&&e.keys.length) || (Array.isArray(e.key)&&e.key.length) || (Array.isArray(e.keysecondary)&&e.keysecondary.length);
            const isTestTitle = /^测试$/i.test(comment);
            const isMinimal = !hasKeys && !content && (comment==='')
              && isDefault(e.order,0) && isDefault(e.depth,0) && isDefault(e.position,0) && isDefault(e.probability,100);
            if (isTestTitle || isMinimal) candidates.push({ uid, comment });
          }
          if (!candidates.length){ toastr?.info?.('未发现可清理的占位/测试条目'); return; }
          const listHtml = candidates.map(c=>`<li>UID ${c.uid}：${c.comment?c.comment:'<i>(空标题)</i>'}</li>`).join('');
          const html = `<div><h3>将删除以下占位条目（${candidates.length}）</h3><ol>${listHtml}</ol></div>`;
          const ok = await ctx.callGenericPopup?.(html, 'confirm', '清理占位条目', { okButton:'删除', cancelButton:'取消' });
          if (!ok) return;
          for (const c of candidates) { try { delete data.entries[c.uid]; } catch{} }
          const res = await api.saveBook(name, data);
          if (res?.ok){ toastr?.success?.('清理完成'); try{ await ctx.reloadWorldInfoEditor?.(name); }catch{} }
          else { toastr?.error?.('保存失败：'+(res?.reason||'')); }
        });

        // 清理占位（A）：当前正在编辑的世界书
        try{
          const $btnCleanA = $('#stdiff-clean-placeholders-A');
          const inferAName = ()=>{
            try {
              const sel = (function(){
                const all = Array.from(document.querySelectorAll('select'));
                for (const s of all){ const t = s.options?.[0]?.textContent?.trim()||''; if (/选择以编辑|Select\s*to\s*edit/i.test(t)) return s; }
                return document.querySelector('#worlds_select') || document.querySelector('#world_editor_select_list') || document.querySelector('#world_editor_select');
              })();
              if (sel){
                const val = sel.value || '';
                const txt = sel.options?.[sel.selectedIndex]?.textContent?.trim() || val || '';
                return txt || val || '';
              }
            } catch{}
            return '';
          };
          $btnCleanA.off('click.stdifCleanA').on('click.stdifCleanA', async ()=>{
            const name = inferAName();
            if (!name){ toastr?.warning?.('未找到正在编辑的世界书（A）'); return; }
            let book = await api.get(name);
            let data = book; // 使用编辑器结构
            if (!data){ toastr?.error?.('无法加载世界书A'); return; }
            if (Array.isArray(data.entries)){
              const obj = {}; for (const it of data.entries){ const uid = (it?.uid ?? it?.id ?? it?._id ?? '').toString(); if (uid) obj[uid]=it; } data.entries=obj;
            }
            data.entries ||= {};
            const isDefault = (v, def) => (v===undefined || v===null) ? true : String(v)===String(def);
            const candidates = [];
            for (const [uid, e] of Object.entries(data.entries)){
              const comment = (e.comment||'').toString().trim();
              const content = (e.content||'').toString().trim();
              const hasKeys = (Array.isArray(e.key)&&e.key.length) || (Array.isArray(e.keys)&&e.keys.length) || (Array.isArray(e.keysecondary)&&e.keysecondary.length);
              const isTestTitle = /^测试$/i.test(comment);
              const isMinimal = !hasKeys && !content && (comment==='')
                && isDefault(e.order,0) && isDefault(e.depth,0) && isDefault(e.position,0) && isDefault(e.probability,100);
              if (isTestTitle || isMinimal) candidates.push({ uid, comment });
            }
            if (!candidates.length){ toastr?.info?.('未发现可清理的占位/测试条目（A）'); return; }
            const listHtml = candidates.map(c=>`<li>UID ${c.uid}：${c.comment?c.comment:'<i>(空标题)</i>'}</li>`).join('');
            const html = `<div><h3>将删除以下占位/测试条目（${candidates.length}）</h3><ol>${listHtml}</ol></div>`;
            const ok = await ctx.callGenericPopup?.(html, 'confirm', '清理A占位条目', { okButton:'删除', cancelButton:'取消' });
            if (!ok) return;
            for (const c of candidates) { try { delete data.entries[c.uid]; } catch{} }
            const res = await api.saveBook(name, data);
            if (res?.ok){ toastr?.success?.('A清理完成'); try{ await ctx.reloadWorldInfoEditor?.(name); }catch{} }
            else { toastr?.error?.('保存失败：'+(res?.reason||'')); }
          });
        }catch{}

      } catch (e){ console.warn('[ST-Diff] tools init failed', e); }

    // 启动参数Diff注入（在用户进入条目详情时动态插入B参数行）
    try { const mod = await import('./paramsDiff.js?ts='+Date.now()); mod.initParamsDiff(ctx); } catch(e) { try{ console.warn('[ST-Diff] paramsDiff init failed', e); }catch{} }

      }
    } catch {}

  }catch(e){ console.warn('[ST-Diff][worldbook] mount failed', e); }
}

