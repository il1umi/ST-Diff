import {
  saveState as persistState,
  createDefaultWorldbookGroup as createDefaultWorldbookGroupFromState,
  sanitizeWorldbookGroup as sanitizeWorldbookGroupFromState,
  sanitizeWorldbookGroups as sanitizeWorldbookGroupsFromState,
} from '../state/state.js';
import {
  WORLD_BOOK_GROUP_MODES,
  WORLD_BOOK_ANCHORS,
  WORLD_BOOK_DEFAULT_ROLE,
  WORLD_BOOK_DEPTH_PRESETS,
} from '../state/defaults.js';

const DEFAULT_EVENT_NS = '.stdiffWorldbook';
const LOG_MAX_LINES = 40;

let activeController = null;

/**
 * 挂载世界书控制面板。
 * @param {object} ctx SillyTavern 扩展上下文
 * @param {object} state noass 状态对象
 * @param {object} deps 依赖集合
 * @param {object} options 附加配置（$root、eventNamespace、toast）
 * @returns {object|null} 控制器实例
 */
export function mountWibridgeControls(ctx, state, deps = {}, options = {}) {
  unmountWibridgeControls();

  const controller = new NoassWorldbookControls(ctx, state, deps, options);
  if (!controller.mount()) {
    return null;
  }

  activeController = controller;
  return controller;
}

/**
 * 卸载世界书控制面板。
 */
export function unmountWibridgeControls() {
  if (!activeController) {
    return;
  }
  activeController.destroy();
  activeController = null;
}

class NoassWorldbookControls {
  constructor(ctx, state, rawDeps, options) {
    this.ctx = ctx;
    this.state = state;
    this.deps = this.withDefaults(rawDeps);

    this.$root = options?.$root || $('#stdiff-noass');
    this.ns = options?.eventNamespace || DEFAULT_EVENT_NS;
    this.toast = typeof options?.toast === 'function' ? options.toast : () => {};

    this.dom = {};
    this.internalUpdate = false;
    this.currentIndex = 0;
    this.snapshot = this.deps.exportWorldbookSnapshot();
    this.logBuffer = [];
    this.snapshotCallback = null;
    this.unsubscribed = false;

    this.saveState = () => {
      if (typeof this.deps.saveState === 'function') {
        this.deps.saveState(this.ctx);
      }
    };

    this.getTemplate = () => {
      if (typeof this.deps.getActiveTemplate === 'function') {
        return this.deps.getActiveTemplate();
      }
      const templates = this.state.templates || {};
      const activeName = this.state.active || Object.keys(templates)[0];
      return templates[activeName];
    };

    this.requestTemplateRefresh =
      typeof this.deps.requestTemplateRefresh === 'function'
        ? this.deps.requestTemplateRefresh
        : () => {};
  }

  withDefaults(rawDeps) {
    const deps = { ...rawDeps };

    deps.saveState ??= persistState;
    deps.getActiveTemplate ??= null;
    deps.exportWorldbookSnapshot ??= () => ({
      entries: [],
      entriesByDepth: {},
      lastUpdated: 0,
      initialized: false,
    });
    deps.subscribeWorldbookSnapshot ??= () => {};
    deps.unsubscribeWorldbookSnapshot ??= () => {};
    deps.runWorldbookDryRun ??= () => Promise.resolve();
    deps.warnWorldbookIssue ??= () => {};
    deps.debugWorldbookLog ??= () => {};
    deps.setWorldbookLogAdapter ??= () => {};
    deps.requestTemplateRefresh ??= () => {};

    deps.createDefaultWorldbookGroup ??= createDefaultWorldbookGroupFromState;
    deps.sanitizeWorldbookGroup ??= sanitizeWorldbookGroupFromState;
    deps.sanitizeWorldbookGroups ??= sanitizeWorldbookGroupsFromState;

    deps.WORLD_BOOK_GROUP_MODES ??= WORLD_BOOK_GROUP_MODES;
    deps.WORLD_BOOK_ANCHORS ??= WORLD_BOOK_ANCHORS;
    deps.WORLD_BOOK_DEFAULT_ROLE ??= WORLD_BOOK_DEFAULT_ROLE;
    deps.WORLD_BOOK_DEPTH_PRESETS ??= WORLD_BOOK_DEPTH_PRESETS;

    return deps;
  }

  mount() {
    if (!this.$root || !this.$root.length) {
      return false;
    }

    this.cacheDom();
    if (!this.dom.$block.length) {
      return false;
    }

    this.setupLogAdapter();
    this.bindEvents();
    this.subscribeSnapshot();
    this.updateSnapshotView();
    this.renderTemplate();
    return true;
  }

  destroy() {
    this.teardownLogAdapter();
    this.unsubscribeSnapshot();
    this.unbindEvents();

    this.dom = {};
    this.logBuffer = [];
  }

  updateTemplate(template) {
    this.renderTemplate(template);
  }

  cacheDom() {
    const $root = this.$root;

    this.dom = {
      $block: $root.find('#stdiff-noass-worldbook'),
      $debug: $root.find('#stdiff-noass-worldbook-debug'),
      $prev: $root.find('#stdiff-noass-worldbook-prev'),
      $next: $root.find('#stdiff-noass-worldbook-next'),
      $add: $root.find('#stdiff-noass-worldbook-add'),
      $dup: $root.find('#stdiff-noass-worldbook-dup'),
      $del: $root.find('#stdiff-noass-worldbook-del'),
      $index: $root.find('#stdiff-noass-worldbook-index'),
      $enabled: $root.find('#stdiff-noass-worldbook-enabled'),
      $label: $root.find('#stdiff-noass-worldbook-label'),
      $order: $root.find('#stdiff-noass-worldbook-order'),
      $summary: $root.find('#stdiff-noass-worldbook-summary'),
      $modeRange: $root.find('#stdiff-noass-worldbook-mode-range'),
      $modeGte: $root.find('#stdiff-noass-worldbook-mode-gte'),
      $depthMin: $root.find('#stdiff-noass-worldbook-depth-min'),
      $depthMax: $root.find('#stdiff-noass-worldbook-depth-max'),
      $depthChips: $root.find('#stdiff-noass-worldbook-depth-chips'),
      $depthCustom: $root.find('#stdiff-noass-worldbook-depth-custom'),
      $depthAdd: $root.find('#stdiff-noass-worldbook-depth-add'),
      $whitelistSelect: $root.find('#stdiff-noass-worldbook-whitelist-select'),
      $whitelistInput: $root.find('#stdiff-noass-worldbook-whitelist-input'),
      $whitelistAdd: $root.find('#stdiff-noass-worldbook-whitelist-add'),
      $whitelistClear: $root.find('#stdiff-noass-worldbook-whitelist-clear'),
      $whitelistTags: $root.find('#stdiff-noass-worldbook-whitelist-tags'),
      $anchor: $root.find('#stdiff-noass-worldbook-target-anchor'),
      $customKey: $root.find('#stdiff-noass-worldbook-target-custom'),
      $role: $root.find('#stdiff-noass-worldbook-target-role'),
      $targetOrder: $root.find('#stdiff-noass-worldbook-target-order'),
      $cleanOrphan: $root.find('#stdiff-noass-worldbook-clean-orphan'),
      $snapshot: $root.find('#stdiff-noass-worldbook-snapshot'),
      $refresh: $root.find('#stdiff-noass-worldbook-refresh'),
      $dryrun: $root.find('#stdiff-noass-worldbook-dryrun'),
      $log: $root.find('#stdiff-noass-worldbook-log'),
    };
  }

  bindEvents() {
    const d = this.dom;

    d.$debug.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const template = this.getTemplate();
      template.debug_worldbook = d.$debug.prop('checked');
      this.saveAndRefresh();
    });

    d.$prev.off('click' + this.ns).on('click' + this.ns, () => {
      this.setWorldbookIndex(this.currentIndex - 1);
    });

    d.$next.off('click' + this.ns).on('click' + this.ns, () => {
      this.setWorldbookIndex(this.currentIndex + 1);
    });

    d.$add.off('click' + this.ns).on('click' + this.ns, () => this.addWorldbookGroup());
    d.$dup.off('click' + this.ns).on('click' + this.ns, () => this.duplicateWorldbookGroup());
    d.$del.off('click' + this.ns).on('click' + this.ns, () => this.removeWorldbookGroup());

    d.$enabled.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      group.enabled = d.$enabled.prop('checked');
      this.saveAndRefresh(false);
      this.renderSummary(group);
    });

    d.$label.off('input' + this.ns).on('input' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      const text = d.$label.val().trim();
      group.label = text || `策略${this.currentIndex + 1}`;
      this.saveAndRefresh(false);
      this.renderSummary(group);
      this.refreshIndexLabel();
    });

    d.$order.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      const value = parseInt(d.$order.val(), 10);
      group.order = Number.isFinite(value) ? value : this.currentIndex;
      this.saveAndRefresh(false);
    });

    d.$modeRange.off('change' + this.ns).on('change' + this.ns, () => this.handleModeChange());
    d.$modeGte.off('change' + this.ns).on('change' + this.ns, () => this.handleModeChange());

    d.$depthMin.off('change' + this.ns).on('change' + this.ns, () => this.handleDepthChange());
    d.$depthMax.off('change' + this.ns).on('change' + this.ns, () => this.handleDepthChange());

    d.$depthChips.off('click' + this.ns).on('click' + this.ns, 'button', (event) => {
      const depth = parseInt($(event.currentTarget).data('depth'), 10);
      if (Number.isInteger(depth)) {
        this.toggleExcludeDepth(depth);
      }
    });

    d.$depthAdd.off('click' + this.ns).on('click' + this.ns, () => {
      const values = this.parseDepthInput(d.$depthCustom.val());
      this.addExcludeDepths(values);
    });

    d.$whitelistSelect.off('change' + this.ns).on('change' + this.ns, () => {
      const value = d.$whitelistSelect.val();
      if (value) {
        this.addWhitelistTitle(value);
        d.$whitelistSelect.val('');
      }
    });

    d.$whitelistAdd.off('click' + this.ns).on('click' + this.ns, () => {
      const value = (d.$whitelistInput.val() || '').trim();
      if (!value) return;
      this.addWhitelistTitle(value);
      d.$whitelistInput.val('');
    });

    d.$whitelistClear.off('click' + this.ns).on('click' + this.ns, () => this.clearWhitelistTitles());

    d.$whitelistTags.off('click' + this.ns).on('click' + this.ns, 'button', (event) => {
      const title = $(event.currentTarget).data('title');
      if (title) {
        this.removeWhitelistTitle(title);
      }
    });

    d.$anchor.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      const anchor = d.$anchor.val();
      group.target = group.target || {};
      group.target.anchor = anchor;
      if (anchor !== this.deps.WORLD_BOOK_ANCHORS.CUSTOM) {
        group.target.customKey = '';
        d.$customKey.val('');
      }
      this.updateCustomInputState();
      this.saveAndRefresh(false);
    });

    d.$customKey.off('input' + this.ns).on('input' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      group.target = group.target || {};
      group.target.customKey = d.$customKey.val().trim();
      this.saveAndRefresh(false);
    });

    d.$role.off('input' + this.ns).on('input' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      group.target = group.target || {};
      group.target.role = d.$role.val().trim() || this.deps.WORLD_BOOK_DEFAULT_ROLE;
      this.saveAndRefresh(false);
      this.renderSummary(group);
    });

    d.$targetOrder.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      const value = parseInt(d.$targetOrder.val(), 10);
      group.target = group.target || {};
      group.target.order = Number.isFinite(value) ? value : this.currentIndex;
      this.saveAndRefresh(false);
    });

    d.$cleanOrphan.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.internalUpdate) return;
      const group = this.getCurrentGroup();
      if (!group) return;
      group.clean_orphan_anchor = d.$cleanOrphan.prop('checked');
      this.saveAndRefresh(false);
    });

    d.$refresh.off('click' + this.ns).on('click' + this.ns, () => {
      this.snapshot = this.deps.exportWorldbookSnapshot();
      this.updateSnapshotView();
      this.refreshWhitelistOptions();
      this.appendLog('手动刷新世界书快照');
    });

    d.$dryrun.off('click' + this.ns).on('click' + this.ns, async () => {
      try {
        await this.deps.runWorldbookDryRun(this.ctx);
      } catch (error) {
        this.appendLog('Dry Run 触发失败', { error: error?.message || String(error) }, { force: true });
        this.toast('Dry Run 执行失败，请查看控制台。', 'error');
      }
    });
  }

  unbindEvents() {
    const d = this.dom;
    Object.values(d).forEach(($el) => {
      if ($el && typeof $el.off === 'function') {
        $el.off(this.ns);
      }
    });
  }

  setupLogAdapter() {
    this.deps.setWorldbookLogAdapter({
      append: (message, data, options) => this.appendLog(message, data, options),
      reset: (lines) => this.resetLog(lines),
    });
  }

  teardownLogAdapter() {
    this.deps.setWorldbookLogAdapter({ append: null, reset: null });
    this.resetLog();
  }

  appendLog(message, data = null, options = {}) {
    if (!message) return;

    const force = !!options.force;
    const reset = !!options.reset;

    if (!force && !this.dom.$debug.prop('checked')) {
      try {
        console.debug('[ST-Diff][noass][worldbook]', message, data || '');
      } catch {}
      return;
    }

    if (reset) {
      this.logBuffer = [];
    }

    const stamp = new Date().toLocaleTimeString();
    const line = data ? `${message} ${JSON.stringify(data)}` : message;
    this.logBuffer.push(`[${stamp}] ${line}`);
    if (this.logBuffer.length > LOG_MAX_LINES) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_MAX_LINES);
    }
    this.renderLog();
  }

  resetLog(lines = []) {
    this.logBuffer = Array.isArray(lines) ? lines.slice(-LOG_MAX_LINES) : [];
    this.renderLog();
  }

  resetLogOnly() {
    this.logBuffer = [];
    this.renderLog();
  }

  renderLog() {
    if (this.dom.$log) {
      this.dom.$log.text(this.logBuffer.join('\n'));
    }
  }

  subscribeSnapshot() {
    if (typeof this.deps.subscribeWorldbookSnapshot !== 'function') {
      return;
    }
    this.snapshotCallback = (snapshot) => {
      this.snapshot = snapshot || this.deps.exportWorldbookSnapshot();
      this.updateSnapshotView();
      if (!this.internalUpdate) {
        this.refreshWhitelistOptions();
      }
    };
    try {
      this.deps.subscribeWorldbookSnapshot(this.snapshotCallback);
    } catch {}
  }

  unsubscribeSnapshot() {
    if (!this.snapshotCallback || typeof this.deps.unsubscribeWorldbookSnapshot !== 'function') {
      return;
    }
    if (this.unsubscribed) return;
    try {
      this.deps.unsubscribeWorldbookSnapshot(this.snapshotCallback);
    } catch {}
    this.unsubscribed = true;
  }

  renderTemplate(template = this.getTemplate()) {
    if (!template) return;
    this.internalUpdate = true;

    const groups = this.ensureWorldbookGroups(template);
    this.currentIndex = this.clampWorldbookIndex(this.currentIndex, groups.length);

    const group = groups[this.currentIndex];
    this.refreshIndexLabel(groups.length);
    this.renderGroupControls(group);
    this.renderSummary(group);
    this.refreshDepthChips(group);
    this.refreshWhitelistTags(group);
    this.refreshWhitelistOptions();
    this.updateCustomInputState();
    this.updateDebugToggle(template.debug_worldbook === true);

    this.internalUpdate = false;
  }

  renderGroupControls(group) {
    const d = this.dom;
    if (!group) return;

    d.$enabled.prop('checked', group.enabled !== false);
    d.$label.val(group.label || `策略${this.currentIndex + 1}`);
    d.$order.val(Number.isFinite(group.order) ? group.order : this.currentIndex);

    const mode = group.mode === this.deps.WORLD_BOOK_GROUP_MODES.GTE ? 'gte' : 'range';
    d.$modeRange.prop('checked', mode === 'range');
    d.$modeGte.prop('checked', mode === 'gte');

    const depth = group.depth || { min: 0, max: 0 };
    d.$depthMin.val(depth.min ?? 0);
    d.$depthMax.val(
      mode === 'gte'
        ? depth.min ?? 0
        : depth.max ?? depth.min ?? 0,
    );

    const target = group.target || {};
    d.$anchor.val(target.anchor || this.deps.WORLD_BOOK_ANCHORS.AFTER);
    d.$customKey.val(target.customKey || '');
    d.$role.val(target.role || this.deps.WORLD_BOOK_DEFAULT_ROLE);
    d.$targetOrder.val(Number.isFinite(target.order) ? target.order : this.currentIndex);
    d.$cleanOrphan.prop('checked', group.clean_orphan_anchor === true);
  }

  refreshIndexLabel(total = this.ensureWorldbookGroups().length) {
    const current = Math.min(this.currentIndex, Math.max(total - 1, 0));
    this.dom.$index.text(total ? `${current + 1} / ${total}` : '0 / 0');
  }

  renderSummary(group) {
    if (!group) {
      this.dom.$summary.text('尚未创建世界书策略');
      return;
    }

    const modeText =
      group.mode === this.deps.WORLD_BOOK_GROUP_MODES.GTE
        ? `深度 ≥ ${group.depth?.min ?? 0}`
        : `深度 [${group.depth?.min ?? 0}..${group.depth?.max ?? group.depth?.min ?? 0}]`;

    const whitelistDepths = group.whitelist?.excludeDepths?.length
      ? `排除深度: ${group.whitelist.excludeDepths.join(', ')}`
      : '排除深度: 无';

    const whitelistTitles = group.whitelist?.excludeTitles?.length
      ? `排除标题: ${group.whitelist.excludeTitles.length} 项`
      : '排除标题: 无';

    const anchor = group.target?.anchor || this.deps.WORLD_BOOK_ANCHORS.AFTER;
    const anchorLabel =
      anchor === this.deps.WORLD_BOOK_ANCHORS.CUSTOM && group.target?.customKey
        ? `${anchor} (${group.target.customKey})`
        : anchor;

    const role = group.target?.role || this.deps.WORLD_BOOK_DEFAULT_ROLE;

    this.dom.$summary.text(
      [modeText, whitelistDepths, whitelistTitles, `目标: ${anchorLabel}`, `角色: ${role}`].join(' ｜ ')
    );
  }

  refreshDepthChips(group) {
    const $chips = this.dom.$depthChips;
    if (!$chips) return;
    const presets = this.deps.WORLD_BOOK_DEPTH_PRESETS;
    const active = new Set(group?.whitelist?.excludeDepths || []);

    this.internalUpdate = true;
    $chips.empty();
    presets.forEach((depth) => {
      const $btn = $('<button type="button" class="stdiff-tag"></button>')
        .text(depth)
        .attr('data-depth', depth);
      if (active.has(depth)) {
        $btn.addClass('active');
      }
      $chips.append($btn);
    });
    this.internalUpdate = false;
  }

  refreshWhitelistTags(group) {
    const $tags = this.dom.$whitelistTags;
    if (!$tags) return;
    const titles = group?.whitelist?.excludeTitles || [];

    this.internalUpdate = true;
    $tags.empty();
    if (!titles.length) {
      $tags.append('<span class="stdiff-noass-empty">暂无排除标题</span>');
    } else {
      titles.forEach((title) => {
        const $tag = $('<span class="stdiff-tag"></span>').text(title);
        const $remove = $('<button type="button" aria-label="移除">×</button>').attr('data-title', title);
        $tag.append($remove);
        $tags.append($tag);
      });
    }
    this.internalUpdate = false;
  }

  refreshWhitelistOptions() {
    const $select = this.dom.$whitelistSelect;
    if (!$select) return;

    const titles = new Set();
    Object.values(this.snapshot.entriesByDepth || {}).forEach((entries) => {
      entries.forEach((entry) => {
        if (entry?.comment) {
          titles.add(entry.comment);
        }
      });
    });

    const template = this.getTemplate();
    const groups = this.ensureWorldbookGroups(template);
    const current = groups[this.currentIndex];
    const excluded = new Set(current?.whitelist?.excludeTitles || []);
    const sortedTitles = Array.from(titles).sort((a, b) => a.localeCompare(b, 'zh-Hans'));

    this.internalUpdate = true;
    $select.empty();
    $select.append('<option value="">从启用世界书条目中选择</option>');
    sortedTitles.forEach((title) => {
      const $option = $('<option></option>').attr('value', title).text(title);
      if (excluded.has(title)) {
        $option.prop('disabled', true);
      }
      $select.append($option);
    });
    this.internalUpdate = false;
  }

  updateSnapshotView() {
    if (!this.dom.$snapshot) return;

    if (!this.snapshot?.initialized) {
      this.dom.$snapshot.text('尚未收到世界书激活事件');
      return;
    }

    const totalEntries = this.snapshot.entries?.length ?? 0;
    const depthCount = Object.keys(this.snapshot.entriesByDepth || {}).length;
    const timeText = this.snapshot.lastUpdated
      ? new Date(this.snapshot.lastUpdated).toLocaleString()
      : '未知时间';

    this.dom.$snapshot.text(`已缓存 ${totalEntries} 条条目，分布于 ${depthCount} 个深度。最近更新时间：${timeText}`);
  }

  updateCustomInputState() {
    const anchor = this.dom.$anchor.val();
    const isCustom = anchor === this.deps.WORLD_BOOK_ANCHORS.CUSTOM;
    this.dom.$customKey.prop('disabled', !isCustom);
  }

  updateDebugToggle(enabled) {
    if (!this.dom.$debug) return;
    this.dom.$debug.prop('checked', !!enabled);
    if (!enabled) {
      this.resetLogOnly();
    }
  }

  ensureWorldbookGroups(template = this.getTemplate()) {
    template.worldbook_groups ||= [];
    if (!template.worldbook_groups.length) {
      template.worldbook_groups.push(this.deps.createDefaultWorldbookGroup(0));
    }

    template.worldbook_groups = template.worldbook_groups.map((group, index) =>
      this.deps.sanitizeWorldbookGroup(group, index)
    );

    template.worldbook_groups.forEach((group, index) => {
      if (typeof group.order !== 'number') {
        group.order = index;
      }
      if (!group.target) {
        group.target = {};
      }
      if (typeof group.target.order !== 'number') {
        group.target.order = index;
      }
    });

    return template.worldbook_groups;
  }

  clampWorldbookIndex(index, length = this.ensureWorldbookGroups().length) {
    if (length === 0) return 0;
    if (index < 0) return 0;
    if (index >= length) return length - 1;
    return index;
  }

  getCurrentGroup() {
    const groups = this.ensureWorldbookGroups();
    return groups[this.currentIndex];
  }

  setWorldbookIndex(newIndex) {
    const groups = this.ensureWorldbookGroups();
    const next = this.clampWorldbookIndex(newIndex, groups.length);
    if (next === this.currentIndex) return;

    this.commitGroupChanges();
    this.currentIndex = next;
    this.renderTemplate();
  }

  addWorldbookGroup() {
    const groups = this.ensureWorldbookGroups();
    const newIndex = groups.length;
    const newGroup = this.deps.createDefaultWorldbookGroup(newIndex);
    groups.push(newGroup);
    this.currentIndex = newIndex;
    this.saveAndRefresh();
    this.renderTemplate();
    this.appendLog('新增世界书策略组', { index: newIndex, label: newGroup.label });
    this.toast('已新增世界书策略组', 'info');
  }

  duplicateWorldbookGroup() {
    const groups = this.ensureWorldbookGroups();
    const source = groups[this.currentIndex];
    if (!source) return;

    this.commitGroupChanges();
    const clone = this.deps.sanitizeWorldbookGroup(
      JSON.parse(JSON.stringify(source)),
      groups.length
    );
    clone.label = `${source.label || '策略'}-副本`;
    groups.splice(this.currentIndex + 1, 0, clone);
    this.currentIndex += 1;

    this.saveAndRefresh();
    this.renderTemplate();
    this.appendLog('复制世界书策略组', { from: this.currentIndex - 1, to: this.currentIndex });
    this.toast('策略组已复制', 'info');
  }

  removeWorldbookGroup() {
    const groups = this.ensureWorldbookGroups();
    if (groups.length <= 1) {
      window.alert('至少保留一个世界书策略');
      return;
    }

    const removed = groups.splice(this.currentIndex, 1);
    const previousIndex = this.currentIndex;
    this.currentIndex = this.clampWorldbookIndex(this.currentIndex, groups.length);

    this.saveAndRefresh();
    this.renderTemplate();
    this.appendLog('删除世界书策略组', { index: previousIndex, label: removed[0]?.label });
    this.toast('策略组已删除', 'info');
  }

  handleModeChange() {
    if (this.internalUpdate) return;
    const group = this.getCurrentGroup();
    if (!group) return;

    group.mode = this.dom.$modeGte.prop('checked')
      ? this.deps.WORLD_BOOK_GROUP_MODES.GTE
      : this.deps.WORLD_BOOK_GROUP_MODES.RANGE;

    if (group.mode === this.deps.WORLD_BOOK_GROUP_MODES.GTE) {
      const min = parseInt(this.dom.$depthMin.val(), 10);
      group.depth = { min: Number.isFinite(min) ? min : 0 };
      this.dom.$depthMax.val(group.depth.min ?? 0);
    } else {
      const min = parseInt(this.dom.$depthMin.val(), 10);
      const max = parseInt(this.dom.$depthMax.val(), 10);
      const normalizedMin = Number.isFinite(min) ? min : 0;
      const normalizedMax = Number.isFinite(max) ? max : normalizedMin;
      group.depth = { min: normalizedMin, max: normalizedMax };
    }

    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  handleDepthChange() {
    if (this.internalUpdate) return;
    const group = this.getCurrentGroup();
    if (!group) return;

    const min = parseInt(this.dom.$depthMin.val(), 10);
    const max = parseInt(this.dom.$depthMax.val(), 10);

    if (group.mode === this.deps.WORLD_BOOK_GROUP_MODES.GTE) {
      group.depth = { min: Number.isFinite(min) ? min : 0 };
      this.dom.$depthMax.val(group.depth.min ?? 0);
    } else {
      const normalizedMin = Number.isFinite(min) ? min : 0;
      const normalizedMax = Number.isFinite(max) ? max : normalizedMin;
      group.depth = { min: normalizedMin, max: normalizedMax };
    }

    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  toggleExcludeDepth(depth) {
    const group = this.getCurrentGroup();
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };

    const set = new Set(group.whitelist.excludeDepths || []);
    if (set.has(depth)) {
      set.delete(depth);
    } else {
      set.add(depth);
    }
    group.whitelist.excludeDepths = Array.from(set).sort((a, b) => a - b);

    this.refreshDepthChips(group);
    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  addExcludeDepths(values) {
    if (!Array.isArray(values) || !values.length) return;
    const group = this.getCurrentGroup();
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };

    const set = new Set(group.whitelist.excludeDepths || []);
    values.forEach((value) => {
      if (Number.isInteger(value) && value >= 0) {
        set.add(value);
      }
    });
    group.whitelist.excludeDepths = Array.from(set).sort((a, b) => a - b);
    this.dom.$depthCustom.val('');

    this.refreshDepthChips(group);
    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  addWhitelistTitle(title) {
    if (!title) return;
    const group = this.getCurrentGroup();
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };

    const set = new Set(group.whitelist.excludeTitles || []);
    set.add(title);
    group.whitelist.excludeTitles = Array.from(set);

    this.refreshWhitelistTags(group);
    this.refreshWhitelistOptions();
    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  removeWhitelistTitle(title) {
    if (!title) return;
    const group = this.getCurrentGroup();
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };

    group.whitelist.excludeTitles = (group.whitelist.excludeTitles || []).filter((item) => item !== title);

    this.refreshWhitelistTags(group);
    this.refreshWhitelistOptions();
    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  clearWhitelistTitles() {
    const group = this.getCurrentGroup();
    if (!group) return;
    group.whitelist ||= { excludeDepths: [], excludeTitles: [] };
    if (!group.whitelist.excludeTitles.length) return;

    group.whitelist.excludeTitles = [];
    this.refreshWhitelistTags(group);
    this.refreshWhitelistOptions();
    this.saveAndRefresh(false);
    this.renderSummary(group);
  }

  parseDepthInput(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[,，\s]+/)
      .map((value) => parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value >= 0);
  }

  commitGroupChanges() {
    const group = this.getCurrentGroup();
    if (!group) return;

    // 基于当前 DOM 再次收集值，避免中途丢失。
    group.enabled = this.dom.$enabled.prop('checked');
    group.label = this.dom.$label.val().trim() || group.label;
    const orderValue = parseInt(this.dom.$order.val(), 10);
    group.order = Number.isFinite(orderValue) ? orderValue : this.currentIndex;

    const mode = this.dom.$modeGte.prop('checked')
      ? this.deps.WORLD_BOOK_GROUP_MODES.GTE
      : this.deps.WORLD_BOOK_GROUP_MODES.RANGE;
    group.mode = mode;

    if (mode === this.deps.WORLD_BOOK_GROUP_MODES.GTE) {
      const min = parseInt(this.dom.$depthMin.val(), 10);
      group.depth = { min: Number.isFinite(min) ? min : 0 };
    } else {
      const min = parseInt(this.dom.$depthMin.val(), 10);
      const max = parseInt(this.dom.$depthMax.val(), 10);
      const normalizedMin = Number.isFinite(min) ? min : 0;
      const normalizedMax = Number.isFinite(max) ? max : normalizedMin;
      group.depth = { min: normalizedMin, max: normalizedMax };
    }

    group.target = group.target || {};
    const anchor = this.dom.$anchor.val();
    group.target.anchor = anchor;
    if (anchor === this.deps.WORLD_BOOK_ANCHORS.CUSTOM) {
      group.target.customKey = this.dom.$customKey.val().trim();
    } else {
      group.target.customKey = '';
    }
    group.target.role = this.dom.$role.val().trim() || this.deps.WORLD_BOOK_DEFAULT_ROLE;
    const targetOrder = parseInt(this.dom.$targetOrder.val(), 10);
    group.target.order = Number.isFinite(targetOrder) ? targetOrder : this.currentIndex;
    group.clean_orphan_anchor = this.dom.$cleanOrphan.prop('checked');
  }

  saveAndRefresh(refreshTemplate = true) {
    this.saveState();
    if (refreshTemplate) {
      this.requestTemplateRefresh();
    }
  }
}