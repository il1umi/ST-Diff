/**
 * @file 宏模块 UI 绑定：负责切换标签、管理折叠状态与工具栏渲染。
 */
import { MACRO_KEYS, UI_SELECTORS } from '../constants.js';
import { saveMacrosState } from '../state/manager.js';
import { notify } from './components/shared.js';

const EVENT_NS = '.stdiffMacros';
const VALID_TABS = Object.values(MACRO_KEYS);

let singleton = null;

/**
 * 绑定宏模块 UI。
 * @param {ReturnType<typeof import('../../../index.js')['getCtx']>} ctx
 * @param {import('../state/manager.js').MacrosState} state
 * @param {Partial<MacroBinderDeps>} [deps]
 */
export function bindUI(ctx, state, deps = {}) {
  if (singleton) {
    singleton.unbind();
    singleton = null;
  }

  const binder = new MacroBinder(ctx, state, deps);
  if (!binder.bind()) {
    return false;
  }

  singleton = binder;
  return true;
}

/**
 * 卸载宏模块 UI。
 */
export function unbindUI() {
  if (!singleton) return;
  singleton.unbind();
  singleton = null;
}

/**
 * @typedef {Object} MacroBinderDeps
 * @property {(ctx: any) => void} saveState
 * @property {(ctx: any, state: import('../state/manager.js').MacrosState, elements: MacroPaneContext) => (void|(() => void))} renderRoulettePanel
 * @property {(ctx: any, state: import('../state/manager.js').MacrosState, elements: MacroPaneContext) => (void|(() => void))} renderCascadePanel
 * @property {(ctx: any, state: import('../state/manager.js').MacrosState, elements: MacroToolbarContext) => (void|(() => void))} renderToolbar
 */

/**
 * @typedef {Object} MacroPaneContext
 * @property {JQuery} $container
 * @property {() => void} requestSave
 * @property {() => void} requestRefresh
 */

/**
 * @typedef {Object} MacroToolbarContext
 * @property {JQuery} $container
 * @property {() => void} requestSave
 * @property {(tab: string, options?: { save?: boolean }) => void} switchTab
 * @property {() => string} getActiveTab
 */

class MacroBinder {
  /**
   * @param {ReturnType<typeof import('../../../index.js')['getCtx']>} ctx
   * @param {import('../state/manager.js').MacrosState} state
   * @param {Partial<MacroBinderDeps>} rawDeps
   */
  constructor(ctx, state, rawDeps) {
    this.ctx = ctx;
    this.state = state;
    this.deps = this.withDefaults(rawDeps);

    this.$root = null;
    this.$tabs = $();
    this.$toolbar = null;
    this.$collapse = null;
    this.panes = {};
    this.ns = EVENT_NS;

    this.toolbarController = null;
    this.cleanup = {
      toolbar: null,
      panes: {},
    };
  }

  /**
   * 合并依赖并提供兜底
   * @param {Partial<MacroBinderDeps>} rawDeps
   * @returns {MacroBinderDeps}
   */
  withDefaults(rawDeps) {
    return {
      saveState: rawDeps?.saveState ?? saveMacrosState,
      renderRoulettePanel: rawDeps?.renderRoulettePanel ?? null,
      renderCascadePanel: rawDeps?.renderCascadePanel ?? null,
      renderToolbar: rawDeps?.renderToolbar ?? null,
      // 运行时钩子（启用/禁用时注册/注销宏）
      registerMacros: typeof rawDeps?.registerMacros === 'function' ? rawDeps.registerMacros : null,
      unregisterMacros: typeof rawDeps?.unregisterMacros === 'function' ? rawDeps.unregisterMacros : null,
    };
  }

  /**
   * 初始化UI。
   * @returns {boolean}
   */
  bind() {
    this.$root = $(UI_SELECTORS.ROOT_SECTION);
    if (!this.$root.length) {
      return false;
    }

    this.ensureUiState();
    this.cacheDom();
    this.bindCollapse();
    this.bindTabs();
    this.renderToolbar();
    this.applyActiveTab({ save: false });
    this.updateCollapseVisual(false);

    // 绑定启用开关，并按状态更新主体显隐
    this.bindEnableToggle();
    this.toggleBody(false);

    return true;
  }

  /**
   * 解绑事件并清理资源。
   */
  unbind() {
    this.teardownToolbar();
    this.teardownPanes();

    if (this.$root) {
      this.$root.off(this.ns);
      this.$root.find('*').off(this.ns);
    }

    this.$root = null;
    this.$tabs = $();
    this.$toolbar = null;
    this.$collapse = null;
    this.panes = {};
  }

  /**
   * 确保 UI 状态存在并处于合法值
   */
  ensureUiState() {
    this.state.ui ||= {};
    if (!VALID_TABS.includes(this.state.ui.activeTab)) {
      this.state.ui.activeTab = MACRO_KEYS.ROULETTE;
    }
    if (typeof this.state.ui.collapsed !== 'boolean') {
      // 默认折叠：仅展示“启用宏模块”勾选项，其他按钮与内容通过右上角折叠按钮控制显隐
      this.state.ui.collapsed = true;
    }
    // 模块独立开关兜底（默认启用）
    if (typeof this.state.enabled !== 'boolean') {
      this.state.enabled = true;
    }
  }

  /**
   * 缓存DOM引用。
   */
  cacheDom() {
    this.$tabs = this.$root.find(`${UI_SELECTORS.TABS} [data-tab]`);
    this.$toolbar = this.$root.find(UI_SELECTORS.TOOLBAR);
    this.$collapse = this.$root.find('[data-stdiff-collapse="macros"]').first();

    this.panes = {};
    this.$root.find(UI_SELECTORS.PANE).each((_, el) => {
      const $pane = $(el);
      const paneKey = $pane.data('pane');
      if (typeof paneKey === 'string') {
        this.panes[paneKey] = $pane;
      }
    });

    // 独立启用开关与主体
    this.$enabled = this.$root.find(UI_SELECTORS.ENABLE_TOGGLE);
    this.$body = this.$root.find(UI_SELECTORS.ROOT_BODY);
  }

  /**
   * 绑定折叠按钮。
   */
  bindCollapse() {
    if (!this.$collapse?.length) return;

    this.$collapse.off(`click${this.ns}`).on(`click${this.ns}`, (event) => {
      event.preventDefault();
      this.toggleCollapsed(!this.state.ui.collapsed);
    });
  }

  /**
   * 绑定标签切换。
   */
  bindTabs() {
    this.$tabs.off(`click${this.ns}`).on(`click${this.ns}`, (event) => {
      event.preventDefault();
      const $btn = $(event.currentTarget);
      const targetTab = String($btn.data('tab'));
      this.switchTab(targetTab);
    });
  }

  /**
   * 渲染工具栏。
   */
  renderToolbar() {
    if (!this.$toolbar?.length) return;
    this.$toolbar.empty();

    if (typeof this.cleanup.toolbar === 'function') {
      this.cleanup.toolbar();
      this.cleanup.toolbar = null;
    }
    if (this.toolbarController && typeof this.toolbarController.destroy === 'function') {
      try { this.toolbarController.destroy(); } catch {}
      this.toolbarController = null;
    }

    if (typeof this.deps.renderToolbar !== 'function') {
      return;
    }

    const renderResult = this.deps.renderToolbar(this.ctx, this.state, {
      $container: this.$toolbar,
      requestSave: () => this.saveState(),
      switchTab: (tab, options) => this.applyActiveTab({ tab, save: options?.save ?? true }),
      getActiveTab: () => this.state.ui.activeTab,
    });

    if (typeof renderResult === 'function') {
      this.cleanup.toolbar = renderResult;
    } else if (renderResult && typeof renderResult === 'object') {
      this.toolbarController = renderResult;
    }
  }

  /**
   * 切换到目标标签。
   * @param {string} tab
   * @param {{ save?: boolean }} [options]
   */
  switchTab(tab, options = {}) {
    this.applyActiveTab({
      tab,
      save: options.save ?? true,
      reRender: true,
    });
  }

  /**
   * 应用当前激活标签。
   * @param {{ tab?: string, save?: boolean, reRender?: boolean }} [options]
   */
  applyActiveTab(options = {}) {
    const targetTab = options.tab && VALID_TABS.includes(options.tab)
      ? options.tab
      : this.state.ui.activeTab;

    this.state.ui.activeTab = targetTab;

    this.$tabs.each((_, el) => {
      const $btn = $(el);
      const tabId = String($btn.data('tab'));
      $btn.toggleClass('is-active', tabId === targetTab);
      $btn.attr('aria-selected', String(tabId === targetTab));
    });

    Object.entries(this.panes).forEach(([key, $pane]) => {
      $pane.toggleClass('is-active', key === targetTab);
    });

    if (options.reRender !== false) {
      this.renderActivePane();
    }

    if (this.toolbarController && typeof this.toolbarController.updateActiveTab === 'function') {
      try { this.toolbarController.updateActiveTab(this.state.ui.activeTab); } catch {}
    }

    if (options.save !== false) {
      this.saveState();
    }
  }

  /**
   * 渲染当前标签对应的面板
   */
  renderActivePane() {
    const activeTab = this.state.ui.activeTab;
    const $pane = this.panes[activeTab];
    if (!$pane?.length) return;

    if (typeof this.cleanup.panes[activeTab] === 'function') {
      this.cleanup.panes[activeTab]();
      this.cleanup.panes[activeTab] = null;
    }

    const renderer = this.getPaneRenderer(activeTab);
    if (typeof renderer !== 'function') {
      $pane.empty();
      return;
    }

    const cleanup = renderer(this.ctx, this.state, {
      $container: $pane,
      requestSave: () => this.saveState(),
      requestRefresh: () => this.renderActivePane(),
    });

    if (typeof cleanup === 'function') {
      this.cleanup.panes[activeTab] = cleanup;
    }
  }

  /**
   * 根据标签类型返回渲染函数。
   * @param {string} tab
   * @returns {MacroBinderDeps['renderRoulettePanel']|MacroBinderDeps['renderCascadePanel']|null}
   */
  getPaneRenderer(tab) {
    if (tab === MACRO_KEYS.ROULETTE) {
      return this.deps.renderRoulettePanel;
    }
    if (tab === MACRO_KEYS.CASCADE) {
      return this.deps.renderCascadePanel;
    }
    return null;
  }

  /**
   * 切换折叠状态。
   * @param {boolean} collapsed
   */
  toggleCollapsed(collapsed) {
    if (this.state.ui.collapsed === collapsed) {
      this.updateCollapseVisual(true);
      return;
    }
    this.state.ui.collapsed = collapsed;
    this.updateCollapseVisual(true);
    this.saveState();
  }

  /**
   * 更新折叠的视觉状态。
   * @param {boolean} animate
   */
  updateCollapseVisual(animate) {
    const collapsed = this.state.ui.collapsed === true;
    if (!this.$root) return;

    this.$root.toggleClass('is-collapsed', collapsed);

    // 仅更新折叠按钮视觉；主体显隐交由 toggleBody() 统一控制
    if (this.$collapse?.length) {
      this.$collapse.attr('aria-expanded', String(!collapsed));
      this.$collapse.find('i').css('transform', collapsed ? 'rotate(180deg)' : '');
    }

    // 根据最新折叠状态刷新主体显隐
    this.toggleBody(animate);
  }

  /**
   * 持久化设置。
   */
  saveState() {
    try {
      this.deps.saveState(this.ctx);
    } catch (error) {
      console.warn('[ST-Diff][macros] 保存状态失败', error);
      try {
        notify(this.ctx, '保存设置失败，请查看控制台日志。', 'error');
      } catch {}
    }
  }

  /**
   * 绑定启用/禁用宏模块的勾选项。
   */
  bindEnableToggle() {
    if (!this.$enabled?.length) return;

    // 初始化勾选态
    this.$enabled.prop('checked', this.state.enabled === true);

    // 事件绑定
    this.$enabled.off(`change${this.ns}`).on(`change${this.ns}`, (event) => {
      const nextEnabled = $(event.currentTarget).is(':checked');
      this.handleEnableToggle(nextEnabled);
    });
  }

  /**
   * 处理启用/禁用切换：保存状态、注册/注销宏、更新主体显隐。
   * @param {boolean} enabled
   */
  handleEnableToggle(enabled) {
    const prev = this.state.enabled === true;

    // 更新状态并持久化
    this.state.enabled = enabled === true;
    this.saveState();

    // 尝试注册/注销宏
    try {
      if (this.state.enabled) {
        if (typeof this.deps.registerMacros === 'function') {
          this.deps.registerMacros();
        }
      } else {
        if (typeof this.deps.unregisterMacros === 'function') {
          this.deps.unregisterMacros();
        }
      }
    } catch (error) {
      console.warn('[ST-Diff][macros] 切换启用状态时注册/注销失败', error);
      // 回退 UI 与状态
      this.state.enabled = prev;
      this.$enabled.prop('checked', prev);
      this.saveState();
    }

    // 刷新主体显隐
    this.toggleBody(true);

    // 同步工具栏的标签指示与按钮禁用态（需在显隐更新后执行）
    if (this.toolbarController && typeof this.toolbarController.updateActiveTab === 'function') {
      try {
        this.toolbarController.updateActiveTab(this.state.ui.activeTab);
      } catch {}
    }
  }

  /**
   * 根据 enable + collapsed 统一更新主体显隐。
   * @param {boolean} animate
   */
  toggleBody(animate) {
    const canShow = this.state.enabled === true && this.state.ui.collapsed !== true;

    const $body = this.$body?.length ? this.$body : this.$root.find('.stdiff-section-body').first();
    const $toolbar = this.$toolbar?.length ? this.$toolbar : null;

    if ($body?.length) {
      if (canShow) {
        animate ? $body.slideDown(120) : $body.show();
      } else {
        animate ? $body.slideUp(120) : $body.hide();
      }
    }

    // 工具栏随折叠/展开统一控制显隐（仅保留“启用宏模块”勾选项在头部）
    if ($toolbar) {
      if (canShow) {
        $toolbar.show();
      } else {
        $toolbar.hide();
      }
    }
  }

  /**
   * 清理工具栏与面板渲染器。
   */
  teardownToolbar() {
    if (typeof this.cleanup.toolbar === 'function') {
      try { this.cleanup.toolbar(); } catch {}
      this.cleanup.toolbar = null;
    }
    if (this.toolbarController && typeof this.toolbarController.destroy === 'function') {
      try { this.toolbarController.destroy(); } catch {}
      this.toolbarController = null;
    }
    if (this.$toolbar?.length) {
      this.$toolbar.off(this.ns).empty();
    }
  }

  teardownPanes() {
    Object.keys(this.cleanup.panes).forEach((key) => {
      const handler = this.cleanup.panes[key];
      if (typeof handler === 'function') {
        try { handler(); } catch {}
      }
    });
    this.cleanup.panes = {};
  }
}