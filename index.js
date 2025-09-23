// 酒馆构筑对比工具（ST-Diff）- 主入口

const EXT_KEY = 'st-diff'; // 内部命名空间 key
const DISPLAY_NAME = '酒馆构筑对比工具';

function getCtx() {
  try {
    if (typeof getContext === 'function') return getContext();
    if (window?.SillyTavern?.getContext) return window.SillyTavern.getContext();
  } catch {}
  return null;
}

const DEFAULTS = {
  enabled: false,
  ui: { viewMode: 'side-by-side', ignoreWhitespace: true, ignoreCase: false, jsonNormalize: true },
  worldinfo: { lastSelectedA: null, lastSelectedB: null },
  history: [],
  version: 1,
  modules: { worldbook: true, presets: false },
};

async function openPanel(ctx) {
  // 使用酒馆的模板加载（提供 scripts/extensions 下相对路径）
  const base = 'third-party/ST-Diff/presentation/templates';
  const html = await ctx.renderExtensionTemplateAsync(base, 'main');
  const $root = $(html);


  // 恢复设置示例：视图模式
  const settings = ensureSettings(ctx);
  $root.find('[data-stdiff-view-mode]').val(settings.ui.viewMode);

  $root.on('change', '[data-stdiff-view-mode]', (e) => {
    settings.ui.viewMode = e.target.value;
    ctx.saveSettingsDebounced?.();
  });

  // 注入到扩展面板
  const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
  $target.append($root);

  // ====== noass UI 绑定 ======
  try {
    const noass = (ctx.extensionSettings || window.extension_settings)['st-diff'].noass || {};
    const $box = $root.find('#stdiff-noass');
    const $en = $box.find('#stdiff-noass-enabled');
    const $tplSel = $box.find('#stdiff-noass-tpl-select');
    const $tplNew = $box.find('#stdiff-noass-tpl-new');
    const $tplDup = $box.find('#stdiff-noass-tpl-dup');
    const $tplRen = $box.find('#stdiff-noass-tpl-rename');
    const $tplDel = $box.find('#stdiff-noass-tpl-del');
    const $tplSave = $box.find('#stdiff-noass-tpl-save');
    const $user = $box.find('#stdiff-noass-user');
    const $asst = $box.find('#stdiff-noass-assistant');
    const $sys = $box.find('#stdiff-noass-system');
    const $sepSys = $box.find('#stdiff-noass-sep-system');
    const $prefill = $box.find('#stdiff-noass-prefill');
    const $cap = $box.find('#stdiff-noass-cap-enabled');
    const $rules = $box.find('#stdiff-noass-rules');
    const $addRule = $box.find('#stdiff-noass-add-rule');
    const $saveRules = $box.find('#stdiff-noass-save-rules');
    const $storeList = $box.find('#stdiff-noass-storage-list');
    const $storeRefresh = $box.find('#stdiff-noass-storage-refresh');
    const $storeClear = $box.find('#stdiff-noass-storage-clear');
    // 世界书提取控件
    const $wiEnabled = $box.find('#stdiff-noass-wi-enabled');
    const $wiMode = $box.find('input[name="stdiff-noass-wi-mode"]');
    const $wiThreshold = $box.find('#stdiff-noass-wi-threshold');
    const $wiPicks = $box.find('#stdiff-noass-wi-picks');
    const $wiTag = $box.find('#stdiff-noass-wi-tag');
    const $wiStrategy = $box.find('#stdiff-noass-wi-strategy');
    const $wiCollapse = $box.find('#stdiff-noass-wi-collapse');
    // 组控件
    const $wiGroupSel = $box.find('#stdiff-noass-wi-group-select');
    const $wiGroupNew = $box.find('#stdiff-noass-wi-group-new');
    const $wiGroupCopy = $box.find('#stdiff-noass-wi-group-copy');
    const $wiGroupRename = $box.find('#stdiff-noass-wi-group-rename');
    const $wiGroupDel = $box.find('#stdiff-noass-wi-group-del');
    const $wiGroupSave = $box.find('#stdiff-noass-wi-group-save');
    // 白名单
    const $wlList = $box.find('#stdiff-noass-wl');
    const $wlAdd = $box.find('#stdiff-noass-wl-add');
    const $wlSave = $box.find('#stdiff-noass-wl-save');

    // 初始化值
    $en.prop('checked', noass.enabled !== false);
    // 模板集初始化
    function slotRoot(){ const root=ctx.extensionSettings||window.extension_settings; root['st-diff']=root['st-diff']||{}; root['st-diff'].noass=root['st-diff'].noass||{}; root['st-diff'].noass.templates = root['st-diff'].noass.templates || {}; return root['st-diff'].noass; }
    function getTemplates(){ return slotRoot().templates; }
    function getActiveName(){ return slotRoot().active || '默认'; }
    function setActiveName(n){ slotRoot().active = n; saveDebounced(); }
    function ensureTemplate(name){
      const t=getTemplates();
      if (!t[name]){
        t[name] = {
          user:'Human', assistant:'Assistant', system:'SYSTEM', separator_system:'', prefill_user:'Continue the conversation.',
          // 让“提取世界书并传递”按模板隔离
          wi_extract_enabled:false,
          wi_depth_mode:'threshold',
          wi_depth_threshold:2,
          wi_depth_picks:[2,3,4],
          wi_target_tag:'<A_TRANS>',
          wi_strategy:'extract_only',
          wi_groups: [],
        };
      }
      return t[name];
    }
    function loadTemplateToUI(name){
      const t=ensureTemplate(name);
      $user.val(t.user||''); $asst.val(t.assistant||''); $sys.val(t.system||''); $sepSys.val(t.separator_system||''); $prefill.val(t.prefill_user||'');
      // 组下拉
      const groups = Array.isArray(t.wi_groups) ? t.wi_groups : (t.wi_groups=[]);
      $wiGroupSel.empty();
      if (!groups.length) { groups.push({ name:'组1', extract_enabled:false, depth_mode:'threshold', depth_threshold:2, depth_picks:[2,3,4], target_tag:'<A_TRANS>', strategy:'extract_only', whitelist:[] }); }
      groups.forEach((g, i)=>{ $wiGroupSel.append(`<option value="${i}">${g.name||('组'+(i+1))}</option>`); });
      $wiGroupSel.val('0');
      loadGroupToUI(0);
    }
    function saveUIToTemplate(name){
      const t=ensureTemplate(name);
      t.user=$user.val(); t.assistant=$asst.val(); t.system=$sys.val(); t.separator_system=$sepSys.val(); t.prefill_user=$prefill.val();
      // 保存当前组
      saveGroupFromUI(Number($wiGroupSel.val()||0));
      saveDebounced();
    }
    function refreshTplOptions(){ const t=getTemplates(); const names=Object.keys(t); $tplSel.empty(); names.forEach(n=> $tplSel.append(`<option value="${n}">${n}</option>`)); const act=getActiveName(); if (!names.includes(act) && names.length){ setActiveName(names[0]); } $tplSel.val(getActiveName()); }
    // 初次确保默认模板
    ensureTemplate(getActiveName()); refreshTplOptions(); loadTemplateToUI(getActiveName());
    $cap.prop('checked', noass.capture_enabled !== false);
    // 按模板加载（覆盖全局）
    loadTemplateToUI(getActiveName());

    function getSlot(){ const root = ctx.extensionSettings || window.extension_settings; root['st-diff']=root['st-diff']||{}; root['st-diff'].noass=root['st-diff'].noass||{}; return root['st-diff'].noass; }
    function saveDebounced(){ (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))(); }

    $en.on('change', ()=>{ getSlot().enabled = $en.prop('checked'); saveDebounced(); updateModulesVisibility(ctx); toggleNoassBody(); });
    const bindText = ($el, key)=> $el.on('input', ()=>{ saveUIToTemplate(getActiveName()); });
    bindText($user,'user'); bindText($asst,'assistant'); bindText($sys,'system'); bindText($sepSys,'separator_system'); bindText($prefill,'prefill_user');
    // 模板事件
    $tplSel.on('change', ()=>{ setActiveName($tplSel.val()); loadTemplateToUI(getActiveName()); });
    $tplNew.on('click', ()=>{ const base='配置'; let i=1; const t=getTemplates(); while (t[base+i]) i++; t[base+i]={ user:'Human', assistant:'Assistant', system:'SYSTEM', separator_system:'', prefill_user:'Continue the conversation.' }; setActiveName(base+i); refreshTplOptions(); loadTemplateToUI(getActiveName()); });
    $tplDup.on('click', ()=>{ const cur=getActiveName(); const t=getTemplates(); const src=ensureTemplate(cur); const base=cur+'-副本'; let i=1; while (t[base+i]) i++; t[base+i]=JSON.parse(JSON.stringify(src)); setActiveName(base+i); refreshTplOptions(); loadTemplateToUI(getActiveName()); });
    $tplRen.on('click', ()=>{ const cur=getActiveName(); const name=prompt('输入新名称', cur)||cur; const t=getTemplates(); if (name!==cur && !t[name]){ t[name]=t[cur]; delete t[cur]; setActiveName(name); refreshTplOptions(); loadTemplateToUI(getActiveName()); saveDebounced(); } });
    $tplDel.on('click', ()=>{ const cur=getActiveName(); const t=getTemplates(); const names=Object.keys(t); if (names.length<=1){ alert('至少保留一个模板'); return; } if (confirm(`删除模板“${cur}”？`)){ delete t[cur]; setActiveName(Object.keys(t)[0]); refreshTplOptions(); loadTemplateToUI(getActiveName()); saveDebounced(); } });
    $tplSave.on('click', ()=>{ saveUIToTemplate(getActiveName()); try{ toastr?.success?.('模板已保存'); }catch{} });
    $cap.on('change', ()=>{ getSlot().capture_enabled = $cap.prop('checked'); saveDebounced(); });
    function toggleNoassBody(){ try { $box.find('#stdiff-noass-body').toggle($en.prop('checked')); } catch{} }
    toggleNoassBody();
    // 组载入/保存函数
    function loadGroupToUI(idx){
      const t=ensureTemplate(getActiveName()); const groups=t.wi_groups;
      const g = groups[idx] || groups[0];
      $wiEnabled.prop('checked', !!g.extract_enabled);
      $wiMode.filter('[value="threshold"]').prop('checked', (g.depth_mode||'threshold')==='threshold');
      $wiMode.filter('[value="pick"]').prop('checked', (g.depth_mode||'threshold')==='pick');
      $wiThreshold.val(g.depth_threshold ?? 2);
      try{ const picks = Array.isArray(g.depth_picks)? g.depth_picks:[]; $wiPicks.val(picks.join('\n')); }catch{}
      $wiTag.val(g.target_tag || '<A_TRANS>');
      $wiStrategy.val(g.strategy || 'extract_only');
      $wiCollapse.prop('checked', !!g.collapse_empty_after_strip);
      // 白名单切换到组内：复用原白名单UI，但读写 g.whitelist
      renderWhitelistForGroup(g);
    }
    function saveGroupFromUI(idx){
      const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; const g = groups[idx] || (groups[idx]={});
      g.extract_enabled = $wiEnabled.prop('checked');
      g.depth_mode = $wiMode.filter(':checked').val();
      g.depth_threshold = Number($wiThreshold.val()||2);
      g.depth_picks = String($wiPicks.val()||'').split(/\r?\n/).map(s=>Number(s.trim())).filter(n=>!isNaN(n));
      g.target_tag = $wiTag.val();
      g.strategy = $wiStrategy.val();
      g.collapse_empty_after_strip = $wiCollapse.prop('checked');
      g.whitelist = readWhitelistFromUI();
    }
    // 当前组获取器
    function getCurrentGroup(){ const t=ensureTemplate(getActiveName()); return t.wi_groups[Number($wiGroupSel.val()||0)] || t.wi_groups[0]; }
    // 字段自动保存到当前组
    $wiEnabled.on('change', ()=>{ const g=getCurrentGroup(); if (!g) return; g.extract_enabled = $wiEnabled.prop('checked'); saveDebounced(); });
    $wiMode.on('change', ()=>{ const g=getCurrentGroup(); if (!g) return; g.depth_mode = $wiMode.filter(':checked').val(); saveDebounced(); });
    $wiThreshold.on('input', ()=>{ const g=getCurrentGroup(); if (!g) return; g.depth_threshold = Number($wiThreshold.val()||2); saveDebounced(); });
    $wiPicks.on('input', ()=>{ const g=getCurrentGroup(); if (!g) return; g.depth_picks = String($wiPicks.val()||'').split(/\r?\n/).map(s=>Number(s.trim())).filter(n=>!isNaN(n)); saveDebounced(); });
    $wiTag.on('input', ()=>{ const g=getCurrentGroup(); if (!g) return; g.target_tag = $wiTag.val(); saveDebounced(); });
    $wiStrategy.on('change', ()=>{ const g=getCurrentGroup(); if (!g) return; g.strategy = $wiStrategy.val(); saveDebounced(); });
    $wiCollapse.on('change', ()=>{ const g=getCurrentGroup(); if (!g) return; g.collapse_empty_after_strip = $wiCollapse.prop('checked'); saveDebounced(); });
    // 组事件
    $wiGroupSel.on('change', ()=>{ saveGroupFromUI(Number($wiGroupSel.data('last')||0)); loadGroupToUI(Number($wiGroupSel.val()||0)); $wiGroupSel.data('last', Number($wiGroupSel.val()||0)); saveDebounced(); });
    $wiGroupNew.on('click', ()=>{ const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; saveGroupFromUI(Number($wiGroupSel.val()||0)); groups.push({ name:`组${groups.length+1}`, extract_enabled:false, depth_mode:'threshold', depth_threshold:2, depth_picks:[2,3,4], target_tag:'<A_TRANS>', strategy:'extract_only', whitelist:[] }); loadTemplateToUI(getActiveName()); saveDebounced(); });
    $wiGroupCopy.on('click', ()=>{ const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; const idx=Number($wiGroupSel.val()||0); saveGroupFromUI(idx); const dup=JSON.parse(JSON.stringify(groups[idx])); dup.name = (dup.name||`组${idx+1}`)+'-副本'; groups.splice(idx+1,0,dup); loadTemplateToUI(getActiveName()); saveDebounced(); });
    $wiGroupRename.on('click', ()=>{ const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; const idx=Number($wiGroupSel.val()||0); const name=prompt('输入组名', groups[idx].name||`组${idx+1}`) || groups[idx].name; groups[idx].name=name; loadTemplateToUI(getActiveName()); saveDebounced(); });
    $wiGroupDel.on('click', ()=>{ const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; if (groups.length<=1) { alert('至少保留一组'); return; } const idx=Number($wiGroupSel.val()||0); groups.splice(idx,1); loadTemplateToUI(getActiveName()); saveDebounced(); });
    $wiGroupSave.on('click', ()=>{ saveGroupFromUI(Number($wiGroupSel.val()||0)); saveDebounced(); try{ toastr?.success?.('当前组已保存'); }catch{} });

    // 将白名单读写改为组内
    function renderWhitelistForGroup(g){
      const data = Array.isArray(g.whitelist)? g.whitelist : (g.whitelist=[]);
      $wlList.empty();
      data.forEach((item, idx)=>{
        const row = $(`<div class="flex-container" style="column-gap:8px; row-gap:6px; flex-wrap:wrap; align-items:center;"></div>`);
        const d = $(`<label>@d <input type="number" class="text_pole" min="0" style="max-width:90px;"></label>`);
        const o = $(`<label>顺序 <input type="number" class="text_pole" style="max-width:120px;"></label>`);
        const c = $(`<label>内容 <input type="text" class="text_pole" style="min-width:220px;"></label>`);
        const del = $(`<button class="menu_button">删除</button>`);
        d.find('input').val(item.depth ?? ''); o.find('input').val(item.order ?? ''); c.find('input').val(item.content ?? '');
        del.on('click', ()=>{ data.splice(idx,1); renderWhitelistForGroup(g); saveDebounced(); });
        row.append(d,o,c,del);
        $wlList.append(row);
      });
    }
    function readWhitelistFromUI(){
      const rows = $wlList.children().toArray();
      const out = [];
      rows.forEach(n=>{ const $n=$(n); const depth = $n.find('label:contains("@d") input').val(); const order=$n.find('label:contains("顺序") input').val(); const content=$n.find('label:contains("内容") input').val(); out.push({ depth: depth===''? null:Number(depth), order: order===''? null:Number(order), content:String(content||'') }); });
      return out;
    }
    // 覆盖白名单按钮行为
    $wlAdd.off('click').on('click', ()=>{ const t=ensureTemplate(getActiveName()); const groups=t.wi_groups; const idx=Number($wiGroupSel.val()||0); groups[idx].whitelist = Array.isArray(groups[idx].whitelist)? groups[idx].whitelist:[]; groups[idx].whitelist.push({ depth:null, order:null, content:'' }); renderWhitelistForGroup(groups[idx]); saveDebounced(); });
    $wlSave.off('click').on('click', ()=>{ saveGroupFromUI(Number($wiGroupSel.val()||0)); saveDebounced(); try{ toastr?.success?.('白名单已保存'); }catch{} });

    function renderRules(){
      const slot = getSlot(); const arr = Array.isArray(slot.capture_rules)? slot.capture_rules : (slot.capture_rules=[]);
      $rules.empty();
      arr.forEach((r, idx)=>{
        const row = $(`<div class="flex-container" style="gap:6px; align-items:center;"></div>`);
        const $enb = $(`<label class="checkbox_label"><input type="checkbox" ${r.enabled===false?'':'checked'}> 启用</label>`);
        const $tag = $(`<input type="text" class="text_pole" placeholder="<tag>" style="width:120px;">`).val(r.tag||'');
        const $reg = $(`<input type="text" class="text_pole" placeholder="/pattern/flags" style="width:260px;">`).val(r.regex||'');
        const $mode = $(`<select class="text_pole" style="width:100px;"><option value="accumulate">叠加式</option><option value="replace">替换式</option></select>`).val(r.updateMode||'accumulate');
        const $range = $(`<input type="text" class="text_pole" placeholder="+1,+3~+5,-2" style="width:140px;">`).val(r.range||'');
        const $del = $(`<button class="menu_button">删除</button>`);
        $del.on('click', ()=>{ arr.splice(idx,1); renderRules(); });
        row.append($enb, $('<span>tag</span>'), $tag, $('<span>regex</span>'), $reg, $('<span>模式</span>'), $mode, $('<span>范围</span>'), $range, $del);
        $rules.append(row);
        row.data('bind', ()=>({ enabled: row.find('input[type=checkbox]').prop('checked'), tag: $tag.val(), regex: $reg.val(), updateMode: $mode.val(), range: $range.val() }));
      });
    }
    renderRules();
    $addRule.on('click', ()=>{ const slot=getSlot(); slot.capture_rules = slot.capture_rules||[]; slot.capture_rules.push({ enabled:true, tag:'<TAG>', regex:'/(.+)/g', updateMode:'accumulate', range:'' }); renderRules(); });
    $saveRules.on('click', ()=>{
      const slot=getSlot(); const rows = $rules.children().toArray(); const out=[];
      rows.forEach(n=>{ const fn = $(n).data('bind'); if (typeof fn==='function'){ const r = fn(); if (r && r.tag && r.regex) out.push(r); } });
      slot.capture_rules = out; saveDebounced(); try{ toastr?.success?.('规则已保存'); }catch{}
    });

    function refreshStorage(){
      const slot = getSlot(); const data = slot.stored_data || {}; $storeList.empty();
      const keys = Object.keys(data);
      if (!keys.length){ $storeList.append('<div style="color:#999;">暂无存储数据</div>'); return; }
      keys.forEach(tag=>{
        const items = Array.isArray(data[tag]) ? data[tag] : [];
        const box = $(`<div class="flex-container" style="padding:6px; border:1px solid var(--SmartThemeBorderColor); border-radius:6px; gap:6px; flex-direction:column;">`+
          `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;"><h4 style="margin:0;">标记：${tag}（${items.length}）</h4>`+
          `<span></span></div>`+
          `</div>`);
        const ta = $('<textarea class="text_pole" style="width:100%; height:140px; font-family:monospace;"></textarea>').val(items.join('\n---\n'));
        const rowBtns = $('<div style="margin-top:6px;"></div>');
        const btnSave = $('<button class="menu_button" style="margin-right:6px;">保存此标记</button>');
        const btnClear = $('<button class="menu_button">清空此标记</button>');
        btnSave.on('click', ()=>{
          const content = String(ta.val()||'').trim();
          if (!content){ delete slot.stored_data[tag]; } else {
            slot.stored_data[tag] = content.split(/\n---\n|\n-{3,}\n/).map(s=>String(s).trim()).filter(Boolean);
          }
          saveDebounced(); refreshStorage(); try{ toastr?.success?.('已保存'); }catch{}
        });
        btnClear.on('click', ()=>{ delete slot.stored_data[tag]; saveDebounced(); refreshStorage(); try{ toastr?.info?.('已清空'); }catch{} });
        rowBtns.append(btnSave, btnClear);
        box.append(ta, rowBtns);
        $storeList.append(box);
      });
    }
    refreshStorage();
    $storeRefresh.on('click', refreshStorage);
    $storeClear.on('click', ()=>{ const slot=getSlot(); slot.stored_data={}; saveDebounced(); refreshStorage(); try{ toastr?.info?.('所有存储已清空'); }catch{} });

    // ====== 白名单（按模板隔离存储） ======
    function tplSlot(){ const root=ctx.extensionSettings||window.extension_settings; root['st-diff']=root['st-diff']||{}; const ns=root['st-diff'].noass=root['st-diff'].noass||{}; ns.whitelists = ns.whitelists || {}; const act=getActiveName(); ns.whitelists[act] = ns.whitelists[act] || []; return ns.whitelists[act]; }
    function renderWhitelist(){
      const data = tplSlot();
      $wlList.empty();
      data.forEach((item, idx)=>{
        const row = $(`<div class="flex-container" style="column-gap:8px; row-gap:6px; flex-wrap:wrap; align-items:center;"></div>`);
        const d = $(`<label>@d <input type="number" class="text_pole" min="0" style="max-width:90px;"></label>`);
        const o = $(`<label>顺序 <input type="number" class="text_pole" style="max-width:120px;"></label>`);
        const c = $(`<label>内容 <input type="text" class="text_pole" style="min-width:220px;"></label>`);
        const del = $(`<button class="menu_button">删除</button>`);
        d.find('input').val(item.depth ?? '');
        o.find('input').val(item.order ?? '');
        c.find('input').val(item.content ?? '');
        del.on('click', ()=>{ data.splice(idx,1); renderWhitelist(); saveDebounced(); });
        row.append(d,o,c,del);
        $wlList.append(row);
      });
    }
    function saveWhitelistFromUI(){
      const data = tplSlot();
      const rows = $wlList.children().toArray();
      const out = [];
      rows.forEach(n=>{
        const $n=$(n);
        const depth = $n.find('label:contains("@d") input').val();
        const order = $n.find('label:contains("顺序") input').val();
        const content = $n.find('label:contains("内容") input').val();
        out.push({ depth: depth===''? null : Number(depth), order: order===''? null : Number(order), content: String(content||'') });
      });
      const slot = tplSlot(); slot.length = 0; out.forEach(x=> slot.push(x)); saveDebounced();
    }
    $wlAdd.on('click', ()=>{ const slot=tplSlot(); slot.push({ depth:null, order:null, content:'' }); renderWhitelist(); saveDebounced(); });
    $wlSave.on('click', ()=>{ saveWhitelistFromUI(); try{ toastr?.success?.('白名单已保存'); }catch{} });
    // 初始渲染
    renderWhitelist();

    // ========== 模板导入/导出 ==========
    // 在模板栏后面追加两个按钮
    const btnExport = $('<button class="menu_button" id="stdiff-noass-tpl-export">导出</button>');
    const btnImport = $('<button class="menu_button" id="stdiff-noass-tpl-import">导入</button>');
    $box.find('#stdiff-noass-tpl-save').after(btnImport).after(btnExport);

    btnExport.on('click', ()=>{
      // 导出包含 noass 下所有配置（包含 templates 与 whitelists）
      const slot = getSlot();
      const payload = {
        noass: {
          enabled: slot.enabled !== false,
          templates: slot.templates || {},
          active: slot.active || '默认',
          whitelists: slot.whitelists || {},
          capture_enabled: slot.capture_enabled !== false,
          capture_rules: slot.capture_rules || [],
          stored_data: slot.stored_data || {},
        }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      // 使用活动模板名称作为文件名后缀
      const activeName = (slot.active || 'default') + '';
      const safe = activeName.replace(/[\\/:*?"<>|]/g, '_');
      a.href = url; a.download = `ST-diff-noass-${safe}.json`; a.click();
      URL.revokeObjectURL(url);
    });

    btnImport.on('click', async ()=>{
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/json';
      input.onchange = async ()=>{
        const file = input.files && input.files[0]; if (!file) return;
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          if (!json || !json.noass) { alert('无效的配置文件'); return; }
          const slot = getSlot();
          // 合并导入（不覆盖未提供字段）
          slot.enabled = json.noass.enabled ?? slot.enabled;
          slot.templates = json.noass.templates || slot.templates || {};
          slot.active = json.noass.active || slot.active || '默认';
          slot.whitelists = json.noass.whitelists || slot.whitelists || {};
          slot.capture_enabled = json.noass.capture_enabled ?? slot.capture_enabled;
          slot.capture_rules = Array.isArray(json.noass.capture_rules) ? json.noass.capture_rules : slot.capture_rules;
          slot.stored_data = json.noass.stored_data || slot.stored_data || {};
          saveDebounced();
          refreshTplOptions(); loadTemplateToUI(getActiveName()); renderRules(); renderWhitelist();
          try{ toastr?.success?.('导入成功'); }catch{}
        } catch(e){ alert('导入失败：'+e); }
      };
      input.click();
    });
  } catch(e){ console.warn('[ST-Diff] noass UI 绑定失败', e); }
}

function ensureSettings(ctx) {
  const root = ctx.extensionSettings || window.extension_settings;
  root[EXT_KEY] ||= JSON.parse(JSON.stringify(DEFAULTS));
  return root[EXT_KEY];
}

function loadEnabledToUI(ctx) {
  const s = ensureSettings(ctx);
  $('#stdiff-enabled').prop('checked', !!s.enabled);
  // 修改主开关文案
  $('#stdiff-enabled').closest('label').contents().filter(function(){return this.nodeType===3;}).remove();
  $('#stdiff-enabled').closest('label').append(' 启用世界书对比');
}

function bindEnableToggle(ctx) {
  $(document).on('change', '#stdiff-enabled', function () {
    const s = ensureSettings(ctx);
    s.enabled = $(this).prop('checked');
    (ctx.saveSettingsDebounced || window.saveSettingsDebounced || (()=>{}))();
    try { toastr.info(`${DISPLAY_NAME}${s.enabled ? '已启用' : '已禁用'}`, DISPLAY_NAME); } catch {}
    updateModulesVisibility(ctx);
  });
}

async function init() {
  const ctx = getCtx();
  if (!ctx?.renderExtensionTemplateAsync) {
    console.error('[ST-Diff] 宿主缺少 renderExtensionTemplateAsync');
    return;
  }

  // 主面板
  await openPanel(ctx);
  // 启用总开关（位于模板内）
  bindEnableToggle(ctx);
  loadEnabledToUI(ctx);
  // 根据启用状态装载无界面子模块（如 noass）
  updateModulesVisibility(ctx);

  // 页面感知式装载模块（世界书优先，预设占位）
  setupPageAwareMount(ctx);
}

// =============== 模块装载器（页面感知） ===============
const Modules = {
  worldbook: {
    mounted: false,
    async mount(ctx) {
      if (this.mounted) return; this.mounted = true;
      try {
        const mod = await import('./modules/worldbook/worldbook.module.js');
        await mod.mount(ctx);
      } catch (e) { console.warn('[ST-Diff] 世界书模块加载失败', e); }
    },
    unmount() { /* 预留：清理事件与DOM */ },
  },
  // 无界面功能模块：对话合并/正则/捕获替换（集成自 js-runner 文本）。
  noass: {
    mounted: false,
    async mount(ctx) {
      if (this.mounted) return; this.mounted = true;
      try {
        const mod = await import('./modules/noass/noass.module.js');
        await mod.mount(ctx);
      } catch (e) {
        console.warn('[ST-Diff] noass 模块加载失败', e);
      }
    },
    async unmount(ctx){
      if (!this.mounted) return; this.mounted = false;
      try {
        const mod = await import('./modules/noass/noass.module.js');
        if (typeof mod.unmount === 'function') await mod.unmount(ctx);
      } catch (e) {
        console.warn('[ST-Diff] noass 模块卸载失败', e);
      }
    }
  },
  presets: {
    mounted: false,
    async mount(ctx) {
      if (this.mounted) return; this.mounted = true;
      try {
        const mod = await import('./modules/presets/presets.module.js');
        await mod.mount(ctx);
      } catch (e) { console.warn('[ST-Diff] 预设模块加载失败', e); }
    },
    unmount() { /* 预留 */ },
  }
};

function setupPageAwareMount(ctx){
  const tryMountWorldbook = () => {
    const hasWI = $('#world_editor_select').length > 0 || $('#world_info').length > 0;
    if (hasWI) Modules.worldbook.mount(ctx);
  };
  tryMountWorldbook();
  const es = ctx.eventSource, et = ctx.eventTypes || ctx.event_types;
  if (es && et?.WORLDINFO_CHANGED) {
    es.on(et.WORLDINFO_CHANGED, tryMountWorldbook);
  } else {
    let attempts = 0; const t = setInterval(()=>{ if (++attempts>20){clearInterval(t);} else { tryMountWorldbook(); } }, 500);
  }
}

function updateModulesVisibility(ctx){
  const s = ensureSettings(ctx);
  const enabled = !!s.enabled;
  // 世界书模块显示/隐藏
  const $wb = $('#stdiff-worldbook-panel');
  if ($wb.length){ $wb.toggle(enabled); }
  // 无界面模块：按主开关启用/停用
  try {
    const noassEnabled = !!((ctx.extensionSettings||window.extension_settings)['st-diff']?.noass?.enabled !== false);
    if (noassEnabled) { Modules.noass.mount(ctx); } else { Modules.noass.unmount(ctx); }
  } catch {}
}



jQuery(() => { init().catch(console.error); });
