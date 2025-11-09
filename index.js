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
  noass: { enabled: true },
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
}

function ensureSettings(ctx) {
  const root = ctx.extensionSettings || window.extension_settings;
  root[EXT_KEY] ||= JSON.parse(JSON.stringify(DEFAULTS));
  return root[EXT_KEY];
}

function loadEnabledToUI(ctx) {
  const s = ensureSettings(ctx);
  $('#stdiff-enabled').prop('checked', !!s.enabled);
  updateModulesVisibility(ctx);
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

  // 首次尝试挂载无界面模块
  try {
    await Modules.noass.mount(ctx);
  } catch (e) {
    console.warn('[ST-Diff] noass 初始化失败', e);
  }

  try {
    await Modules.macros.mount(ctx);
  } catch (e) {
    console.warn('[ST-Diff] macros 初始化失败', e);
  }

  // 页面感知式装载模块（世界书优先，预设占位）
  setupPageAwareMount(ctx);
}

// =============== 模块装载器（页面感知） ===============
const Modules = {
  noass: {
    mounted: false,
    async mount(ctx) {
      if (this.mounted) return;
      this.mounted = true;
      try {
        const mod = await import('./modules/noass/index.js');
        await mod.mount(ctx);
      } catch (e) {
        console.warn('[ST-Diff] noass 模块加载失败', e);
        this.mounted = false;
      }
    },
    async unmount(ctx) {
      if (!this.mounted) return;
      this.mounted = false;
      try {
        const mod = await import('./modules/noass/index.js');
        if (typeof mod.unmount === 'function') {
          await mod.unmount(ctx);
        }
      } catch (e) {
        console.warn('[ST-Diff] noass 模块卸载失败', e);
      }
    },
  },
  macros: {
    mounted: false,
    async mount(ctx) {
      if (this.mounted) return;
      this.mounted = true;
      try {
        const mod = await import('./modules/macros/index.js');
        await mod.mount(ctx);
      } catch (e) {
        console.warn('[ST-Diff] macros 模块加载失败', e);
        this.mounted = false;
      }
    },
    async unmount(ctx) {
      if (!this.mounted) return;
      this.mounted = false;
      try {
        const mod = await import('./modules/macros/index.js');
        if (typeof mod.unmount === 'function') {
          await mod.unmount(ctx);
        }
      } catch (e) {
        console.warn('[ST-Diff] macros 模块卸载失败', e);
      }
    },
  },
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
  const settings = ensureSettings(ctx);
  const worldbookEnabled = !!settings.enabled;

  // 世界书模块显示/隐藏
  $('#stdiff-worldbook-panel').toggle(worldbookEnabled);

  try {
    if (worldbookEnabled) {
      Modules.worldbook.mount(ctx);
    } else {
      Modules.worldbook.unmount(ctx);
    }
  } catch (e) {
    console.warn('[ST-Diff] worldbook 可见性更新失败', e);
  }

  // noass 模块始终展示外层容器，由内部开关控制主体
  const $noass = $('#stdiff-noass');
  if ($noass.length) { $noass.show(); }
  try {
    Modules.noass.mount(ctx);
  } catch (e) {
    console.warn('[ST-Diff] noass 可见性更新失败', e);
  }

  try {
    Modules.macros.mount(ctx);
  } catch (e) {
    console.warn('[ST-Diff] macros 可见性更新失败', e);
  }
}



jQuery(() => { init().catch(console.error); });
