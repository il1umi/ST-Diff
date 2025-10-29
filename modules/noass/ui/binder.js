import { mountWibridgeControls, unmountWibridgeControls } from './wibridgeControls.js';
import {
  saveState as persistState,
  cloneTemplate as cloneTemplateFromState,
  ensureTemplateDefaults as ensureTemplateDefaultsFromState,
  createDefaultRule as createDefaultRuleFromState,
  createDefaultWorldbookGroup as createDefaultWorldbookGroupFromState,
  sanitizeWorldbookGroup as sanitizeWorldbookGroupFromState,
  sanitizeWorldbookGroups as sanitizeWorldbookGroupsFromState,
} from '../state/state.js';
import {
  defaultTemplate,
  DEFAULT_TEMPLATE_NAME,
  WORLD_BOOK_GROUP_MODES,
  WORLD_BOOK_ANCHORS,
  WORLD_BOOK_DEFAULT_ROLE,
  WORLD_BOOK_DEPTH_PRESETS,
} from '../state/defaults.js';
import {
  getStoredDataSnapshot,
  clearStoredData,
  removeStoredDataTag,
  setStoredDataEntries,
  parseStoredDataText,
  formatStoredDataEntries,
} from '../runtime/capture/capture.js';

const SECTION_SELECTOR = '#stdiff-noass';
const BODY_SELECTOR = '#stdiff-noass-body';
const EVENT_NS = '.stdiffNoass';

let singleton = null;

export function bindUI(ctx, state, deps = {}) {
  if (singleton) {
    singleton.unbind();
  }

  const binder = new NoassSettingsBinder(ctx, state, deps);
  if (!binder.bind()) {
    return false;
  }

  singleton = binder;
  return true;
}

export function unbindUI() {
  if (!singleton) {
    return;
  }

  singleton.unbind();
  singleton = null;
}

class NoassSettingsBinder {
  constructor(ctx, state, rawDeps) {
    this.ctx = ctx;
    this.state = state;
    this.deps = this.withDefaults(rawDeps);

    this.$root = null;
    this.ns = EVENT_NS;
    this.dom = {};
    this.activeName = null;
    this.isUpdating = false;
    this.refreshStoredDataView = null;
    this.worldbookController = null;
    this.sectionKeys = ['root', 'capture', 'worldbook', 'storage'];
  }

  withDefaults(rawDeps) {
    const deps = { ...rawDeps };

    deps.saveState ??= persistState;
    deps.cloneTemplate ??= cloneTemplateFromState;
    deps.ensureTemplateDefaults ??= ensureTemplateDefaultsFromState;
    deps.createDefaultRule ??= createDefaultRuleFromState;
    deps.createDefaultWorldbookGroup ??= createDefaultWorldbookGroupFromState;
    deps.sanitizeWorldbookGroup ??= sanitizeWorldbookGroupFromState;
    deps.sanitizeWorldbookGroups ??= sanitizeWorldbookGroupsFromState;

    deps.defaultTemplate ??= defaultTemplate;
    deps.DEFAULT_TEMPLATE_NAME ??= DEFAULT_TEMPLATE_NAME;
    deps.WORLD_BOOK_GROUP_MODES ??= WORLD_BOOK_GROUP_MODES;
    deps.WORLD_BOOK_ANCHORS ??= WORLD_BOOK_ANCHORS;
    deps.WORLD_BOOK_DEFAULT_ROLE ??= WORLD_BOOK_DEFAULT_ROLE;
    deps.WORLD_BOOK_DEPTH_PRESETS ??= WORLD_BOOK_DEPTH_PRESETS;
    deps.getStoredDataSnapshot ??= getStoredDataSnapshot;
    deps.clearStoredData ??= clearStoredData;
    deps.removeStoredDataTag ??= removeStoredDataTag;
    deps.setStoredDataEntries ??= setStoredDataEntries;
    deps.parseStoredDataText ??= parseStoredDataText;
    deps.formatStoredDataEntries ??= formatStoredDataEntries;

    deps.setRefreshStoredDataView ??= () => {};
    deps.resetWorldbookCache ??= () => {};
    deps.setWorldbookLogAdapter ??= () => {};
    deps.exportWorldbookSnapshot ??= () => ({
      entries: [],
      entriesByDepth: {},
      initialized: false,
      lastUpdated: 0,
    });
    deps.subscribeWorldbookSnapshot ??= () => {};
    deps.unsubscribeWorldbookSnapshot ??= () => {};
    deps.runWorldbookDryRun ??= () => Promise.resolve();
    deps.warnWorldbookIssue ??= () => {};
    deps.debugWorldbookLog ??= () => {};

    return deps;
  }

  bind() {
    this.$root = $(SECTION_SELECTOR);
    if (!this.$root.length) {
      return false;
    }

    this.ensureTemplatesReady();
    this.cacheDomReferences();
    this.bindGeneralEvents();
    this.mountWorldbookControls();
    this.refreshTemplateOptions();
    this.loadTemplateToUI();
    this.toggleBody();

    return true;
  }

  unbind() {
    if (!this.$root) {
      return;
    }

    this.$root.off(this.ns);
    this.$root.find('*').off(this.ns);

    if (this.worldbookController) {
      this.worldbookController.destroy();
      this.worldbookController = null;
    }
    unmountWibridgeControls();

    this.refreshStoredDataView = null;
    this.deps.setRefreshStoredDataView(null);
    this.deps.setWorldbookLogAdapter({ append: null, reset: null });

    this.dom = {};
    this.$root = null;
  }

  ensureTemplatesReady() {
    const { cloneTemplate, ensureTemplateDefaults, defaultTemplate, DEFAULT_TEMPLATE_NAME } = this.deps;

    this.state.templates ||= {};
    if (!Object.keys(this.state.templates).length) {
      this.state.templates[DEFAULT_TEMPLATE_NAME] = cloneTemplate(defaultTemplate);
    }

    for (const name of Object.keys(this.state.templates)) {
      this.state.templates[name] = ensureTemplateDefaults(this.state.templates[name]);
    }

    if (!this.state.active || !this.state.templates[this.state.active]) {
      this.state.active = Object.keys(this.state.templates)[0];
    }

    this.activeName = this.state.active;
  }

  cacheDomReferences() {
    const $root = this.$root;

    this.dom = {
      $enabled: $root.find('#stdiff-noass-enabled'),
      $body: $root.find(BODY_SELECTOR),

      $tplSelect: $root.find('#stdiff-noass-tpl-select'),
      $tplNew: $root.find('#stdiff-noass-tpl-new'),
      $tplDup: $root.find('#stdiff-noass-tpl-dup'),
      $tplRename: $root.find('#stdiff-noass-tpl-rename'),
      $tplDelete: $root.find('#stdiff-noass-tpl-del'),
      $tplSave: $root.find('#stdiff-noass-tpl-save'),
      $tplExport: $root.find('#stdiff-noass-tpl-export'),
      $tplImport: $root.find('#stdiff-noass-tpl-import'),
      $tplImportFile: $root.find('#stdiff-noass-tpl-import-file'),

      $user: $root.find('#stdiff-noass-user'),
      $assistant: $root.find('#stdiff-noass-assistant'),
      $exampleUser: $root.find('#stdiff-noass-example-user'),
      $exampleAssistant: $root.find('#stdiff-noass-example-assistant'),
      $system: $root.find('#stdiff-noass-system'),
      $separator: $root.find('#stdiff-noass-separator'),
      $separatorSystem: $root.find('#stdiff-noass-sep-system'),
      $prefill: $root.find('#stdiff-noass-prefill'),

      $singleUser: $root.find('#stdiff-noass-single-user'),
      $cleanClewd: $root.find('#stdiff-noass-clean-clewd'),
      $injectPrefill: $root.find('#stdiff-noass-inject-prefill'),
      $captureEnabled: $root.find('#stdiff-noass-cap-enabled'),

      $rulesContainer: $root.find('#stdiff-noass-rules'),
      $addRule: $root.find('#stdiff-noass-add-rule'),
      $saveRules: $root.find('#stdiff-noass-save-rules'),

      $storageList: $root.find('#stdiff-noass-storage-list'),
      $storageRefresh: $root.find('#stdiff-noass-storage-refresh'),
      $storageClearAll: $root.find('#stdiff-noass-storage-clear'),
      sections: {},
    };

    this.sectionKeys.forEach((key) => {
      this.dom.sections[key] = $root.find(`[data-stdiff-section="${key}"]`);
    });
  }

  bindGeneralEvents() {
    const {
      $enabled,
      $tplSelect,
      $tplNew,
      $tplDup,
      $tplRename,
      $tplDelete,
      $tplSave,
      $tplExport,
      $tplImport,
      $tplImportFile,
      $user,
      $assistant,
      $exampleUser,
      $exampleAssistant,
      $system,
      $separator,
      $separatorSystem,
      $prefill,
      $singleUser,
      $cleanClewd,
      $injectPrefill,
      $captureEnabled,
      $addRule,
      $saveRules,
      $storageRefresh,
      $storageClearAll,
    } = this.dom;

    $enabled.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.isUpdating) return;
      this.state.enabled = $enabled.prop('checked');
      this.toggleBody();
      this.saveDebounced();
    });

    $tplSelect.off('change' + this.ns).on('change' + this.ns, () => {
      const name = $tplSelect.val();
      if (!name || !this.state.templates[name]) return;
      this.setActiveTemplate(name);
    });

    $tplNew.off('click' + this.ns).on('click' + this.ns, () => this.handleTemplateCreate());
    $tplDup.off('click' + this.ns).on('click' + this.ns, () => this.handleTemplateDuplicate());
    $tplRename.off('click' + this.ns).on('click' + this.ns, () => this.handleTemplateRename());
    $tplDelete.off('click' + this.ns).on('click' + this.ns, () => this.handleTemplateDelete());
    $tplSave.off('click' + this.ns).on('click' + this.ns, () => this.toast('当前模板已保存', 'info'));
    $tplExport.off('click' + this.ns).on('click' + this.ns, () => this.handleTemplateExport());
    $tplImport.off('click' + this.ns).on('click' + this.ns, () => $tplImportFile.trigger('click'));
    $tplImportFile.off('change' + this.ns).on('change' + this.ns, (event) => this.handleTemplateImport(event));

    this.bindTextInput($user, 'user');
    this.bindTextInput($assistant, 'assistant');
    this.bindTextInput($exampleUser, 'example_user');
    this.bindTextInput($exampleAssistant, 'example_assistant');
    this.bindTextInput($system, 'system');
    this.bindTextInput($separator, 'separator');
    this.bindTextInput($separatorSystem, 'separator_system');
    this.bindTextInput($prefill, 'prefill_user');

    this.bindCheckbox($singleUser, 'single_user', false);
    this.bindCheckbox($cleanClewd, 'clean_clewd', false);
    this.bindCheckbox($injectPrefill, 'inject_prefill', true);
    this.bindCheckbox($captureEnabled, 'capture_enabled', true);

    $addRule.off('click' + this.ns).on('click' + this.ns, () => {
      const template = this.getActiveTemplate();
      template.capture_rules.push(this.deps.createDefaultRule());
      this.renderRules(template.capture_rules);
      this.saveDebounced();
    });

    $saveRules.off('click' + this.ns).on('click' + this.ns, () => {
      this.saveDebounced();
      this.toast('规则已保存', 'info');
    });

    $storageRefresh.off('click' + this.ns).on('click' + this.ns, () => {
      this.refreshStoredDataView?.();
    });

    $storageClearAll.off('click' + this.ns).on('click' + this.ns, () => {
      const template = this.getActiveTemplate();
      const hasData = Object.keys(this.deps.getStoredDataSnapshot(template)).length > 0;
      if (!hasData) return;
      if (!window.confirm('确定要清空所有存储数据吗？')) return;
      this.deps.clearStoredData(template);
      this.renderStoredData(template);
      this.saveDebounced();
    });

    this.$root.off('click' + this.ns, '.stdiff-noass-collapse').on('click' + this.ns, '.stdiff-noass-collapse', (event) => {
      event.preventDefault();
      const key = $(event.currentTarget).data('stdiffCollapse');
      if (!key) return;
      const template = this.getActiveTemplate();
      const collapsedMap = template?.collapsed_sections || {};
      const isCollapsed = collapsedMap[key] === true;
      this.setSectionCollapsed(key, !isCollapsed, template);
    });
  }

  mountWorldbookControls() {
    this.worldbookController = mountWibridgeControls(
      this.ctx,
      this.state,
      {
        ...this.deps,
        getActiveTemplate: () => this.getActiveTemplate(),
        requestTemplateRefresh: () => this.loadTemplateToUI(),
        saveState: () => this.saveDebounced(),
      },
      {
        $root: this.$root,
        eventNamespace: this.ns,
        toast: (message, level) => this.toast(message, level),
      },
    );
  }

  toggleBody() {
    if (!this.dom.$body || !this.dom.$enabled) return;
    const enabled = this.dom.$enabled.prop('checked');
    const template = this.getActiveTemplate();
    const collapsed = template?.collapsed_sections?.root === true;
    this.dom.$body.toggle(!!enabled && !collapsed);
  }

  bindTextInput($input, key) {
    $input.off('input' + this.ns).on('input' + this.ns, () => {
      if (this.isUpdating) return;
      const template = this.getActiveTemplate();
      template[key] = $input.val();
      this.saveDebounced();
    });
  }

  bindCheckbox($checkbox, key, defaultValue) {
    if (typeof this.getActiveTemplate()[key] === 'undefined') {
      this.getActiveTemplate()[key] = defaultValue;
    }
    $checkbox.off('change' + this.ns).on('change' + this.ns, () => {
      if (this.isUpdating) return;
      this.getActiveTemplate()[key] = $checkbox.prop('checked');
      this.saveDebounced();
    });
  }

  getActiveTemplate() {
    return this.state.templates[this.activeName];
  }

  setActiveTemplate(name) {
    if (!this.state.templates[name]) return;
    this.activeName = name;
    this.state.active = name;
    this.loadTemplateToUI();
    this.saveDebounced();
  }

  handleTemplateCreate() {
    const { cloneTemplate, defaultTemplate } = this.deps;
    let idx = Object.keys(this.state.templates).length + 1;
    let candidate = `配置${idx}`;
    while (this.state.templates[candidate]) {
      idx += 1;
      candidate = `配置${idx}`;
    }
    const name = window.prompt('请输入新模板名称', candidate);
    if (!name) return;
    if (this.state.templates[name]) {
      window.alert('模板名称已存在');
      return;
    }
    this.state.templates[name] = cloneTemplate(defaultTemplate);
    this.setActiveTemplate(name);
    this.refreshTemplateOptions();
  }

  handleTemplateDuplicate() {
    const { cloneTemplate } = this.deps;
    const sourceName = this.activeName;
    const source = this.getActiveTemplate();
    const name = window.prompt('复制为新模板名称', `${sourceName}-副本`);
    if (!name) return;
    if (this.state.templates[name]) {
      window.alert('模板名称已存在');
      return;
    }
    this.state.templates[name] = cloneTemplate(source);
    this.setActiveTemplate(name);
    this.refreshTemplateOptions();
  }

  handleTemplateRename() {
    const sourceName = this.activeName;
    const name = window.prompt('输入新的模板名称', sourceName);
    if (!name || name === sourceName) return;
    if (this.state.templates[name]) {
      window.alert('模板名称已存在');
      return;
    }
    this.state.templates[name] = this.state.templates[sourceName];
    delete this.state.templates[sourceName];
    this.setActiveTemplate(name);
    this.refreshTemplateOptions();
  }

  handleTemplateDelete() {
    if (Object.keys(this.state.templates).length <= 1) {
      window.alert('至少保留一个模板');
      return;
    }
    if (!window.confirm(`确认删除模板「${this.activeName}」？`)) return;
    delete this.state.templates[this.activeName];
    const next = Object.keys(this.state.templates)[0];
    this.setActiveTemplate(next);
    this.refreshTemplateOptions();
  }

  handleTemplateExport() {
    const payload = {
      noass: {
        enabled: this.state.enabled !== false,
        templates: this.state.templates,
        active: this.state.active,
      },
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = this.state.active.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `ST-diff-noass-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  handleTemplateImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result;
        const json = JSON.parse(text);
        if (!json || !json.noass) {
          window.alert('无效的配置文件');
          return;
        }
        const imported = json.noass;
        if (typeof imported.enabled !== 'undefined') {
          this.state.enabled = imported.enabled;
          this.dom.$enabled.prop('checked', this.state.enabled !== false);
          this.toggleBody();
        }
        if (imported.templates && typeof imported.templates === 'object') {
          for (const [name, tpl] of Object.entries(imported.templates)) {
            this.state.templates[name] = this.deps.ensureTemplateDefaults(tpl);
          }
        }
        if (imported.active && this.state.templates[imported.active]) {
          this.setActiveTemplate(imported.active);
        } else {
          this.loadTemplateToUI();
        }
        this.refreshTemplateOptions();
        this.saveDebounced();
      } catch (err) {
        console.warn('[ST-Diff][noass] 导入配置失败', err);
        window.alert('导入失败，请检查文件内容');
      } finally {
        this.dom.$tplImportFile.val('');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  refreshTemplateOptions() {
    const { $tplSelect } = this.dom;
    if (!$tplSelect) return;
    this.isUpdating = true;
    $tplSelect.empty();
    Object.keys(this.state.templates).forEach((name) => {
      $tplSelect.append($('<option></option>').attr('value', name).text(name));
    });
    $tplSelect.val(this.activeName);
    this.isUpdating = false;
  }

  loadTemplateToUI() {
    const template = this.getActiveTemplate();
    const {
      $enabled,
      $user,
      $assistant,
      $exampleUser,
      $exampleAssistant,
      $system,
      $separator,
      $separatorSystem,
      $prefill,
      $singleUser,
      $cleanClewd,
      $injectPrefill,
      $captureEnabled,
    } = this.dom;

    this.isUpdating = true;

    $enabled.prop('checked', this.state.enabled !== false);

    $user.val(template.user);
    $assistant.val(template.assistant);
    $exampleUser.val(template.example_user);
    $exampleAssistant.val(template.example_assistant);
    $system.val(template.system);
    $separator.val(template.separator);
    $separatorSystem.val(template.separator_system);
    $prefill.val(template.prefill_user);

    $singleUser.prop('checked', !!template.single_user);
    $cleanClewd.prop('checked', !!template.clean_clewd);
    $injectPrefill.prop('checked', template.inject_prefill !== false);
    $captureEnabled.prop('checked', template.capture_enabled !== false);

    this.renderRules(template.capture_rules);
    this.renderStoredData(template);
    this.applyCollapsedSections(template);

    this.isUpdating = false;
    this.toggleBody();

    if (this.worldbookController) {
      this.worldbookController.updateTemplate(template);
    }
  }

  renderRules(rules) {
    const { $rulesContainer } = this.dom;
    if (!$rulesContainer) return;

    $rulesContainer.empty();

    if (!rules.length) {
      $rulesContainer.append('<div class="stdiff-noass-empty">暂无捕获规则</div>');
      return;
    }

    rules.forEach((rule, index) => {
      const $row = $('<div class="stdiff-noass-rule-row"></div>');

      const $enabled = $('<input type="checkbox" class="stdiff-noass-rule-enabled">')
        .prop('checked', rule.enabled !== false)
        .on('change' + this.ns, () => {
          rule.enabled = $enabled.prop('checked');
          this.saveDebounced();
        });

      const $regex = $('<input type="text" class="text_pole stdiff-noass-rule-regex" spellcheck="false" placeholder="/pattern/flags">')
        .val(rule.regex)
        .on('input' + this.ns, () => {
          rule.regex = $regex.val();
        });

      const $tag = $('<input type="text" class="text_pole stdiff-noass-rule-tag" spellcheck="false" placeholder="<tag>">')
        .val(rule.tag)
        .on('input' + this.ns, () => {
          rule.tag = $tag.val();
        });

      const $mode = $('<select class="text_pole stdiff-noass-rule-mode"></select>')
        .append('<option value="accumulate">叠加式</option>')
        .append('<option value="replace">替换式</option>')
        .val(rule.updateMode === 'replace' ? 'replace' : 'accumulate')
        .on('change' + this.ns, () => {
          rule.updateMode = $mode.val();
          this.saveDebounced();
        });

      const $range = $('<input type="text" class="text_pole stdiff-noass-rule-range" spellcheck="false" placeholder="+1,+3~+5,-2">')
        .val(rule.range)
        .on('input' + this.ns, () => {
          rule.range = $range.val();
        });

      const $delete = $('<button type="button" class="menu_button stdiff-noass-rule-delete">删除</button>')
        .on('click' + this.ns, () => {
          rules.splice(index, 1);
          this.renderRules(rules);
          this.saveDebounced();
        });

      const $left = $('<div class="stdiff-noass-rule-left"></div>')
        .append($('<label class="checkbox_label"></label>').append($enabled).append(' 启用'))
        .append($delete);

      const $right = $('<div class="stdiff-noass-rule-right"></div>')
        .append(this.createLabeledField('正则', $regex))
        .append(this.createLabeledField('标记', $tag))
        .append(this.createLabeledField('模式', $mode))
        .append(this.createLabeledField('范围', $range));

      $row.append($left).append($right);
      $rulesContainer.append($row);
    });
  }

  renderStoredData(template) {
    const { $storageList } = this.dom;
    if (!$storageList) return;

    $storageList.empty();

    const snapshot = this.deps.getStoredDataSnapshot(template);
    const tags = Object.keys(snapshot).sort();

    if (!tags.length) {
      $storageList.append('<div class="stdiff-noass-empty">暂无存储数据</div>');
    } else {
      tags.forEach((tag) => {
        const entries = snapshot[tag] || [];
        const $item = $('<div class="stdiff-noass-storage-item"></div>');
        const $title = $('<div class="stdiff-noass-storage-title"></div>').text(`标记: ${tag} (${entries.length} 条数据)`);
        const $textarea = $('<textarea class="stdiff-noass-storage-text" spellcheck="false"></textarea>').val(
          this.deps.formatStoredDataEntries(entries),
        );

        const $saveBtn = $('<button class="menu_button">保存编辑</button>').on('click' + this.ns, () => {
          const parsedEntries = this.deps.parseStoredDataText($textarea.val());
          this.deps.setStoredDataEntries(template, tag, parsedEntries);
          this.renderStoredData(template);
          this.saveDebounced();
          this.toast(`标记 ${tag} 的数据已保存`, 'info');
        });

        const $clearBtn = $('<button class="menu_button">清空此标记</button>').on('click' + this.ns, () => {
          if (!window.confirm(`确定要清空标记 ${tag} 的数据吗？`)) return;
          this.deps.removeStoredDataTag(template, tag);
          this.renderStoredData(template);
          this.saveDebounced();
          this.toast(`标记 ${tag} 的数据已清空`, 'info');
        });

        const $btnRow = $('<div class="stdiff-noass-btns"></div>').append($saveBtn, $clearBtn);

        $item.append($title, $textarea, $btnRow);
        $storageList.append($item);
      });
    }

    this.refreshStoredDataView = () => this.renderStoredData(this.getActiveTemplate());
    this.deps.setRefreshStoredDataView(this.refreshStoredDataView);
  }

  createLabeledField(label, $element) {
    return $('<label class="stdiff-noass-field"></label>')
      .append(`<span>${label}</span>`)
      .append($element);
  }

  applyCollapsedSections(template) {
    const activeTemplate = template || this.getActiveTemplate();
    const collapsed = activeTemplate && typeof activeTemplate.collapsed_sections === 'object'
      ? activeTemplate.collapsed_sections
      : {};
    this.sectionKeys.forEach((key) => {
      const isCollapsed = collapsed[key] === true;
      this.setSectionCollapsed(key, isCollapsed, activeTemplate, { save: false });
    });
  }

  setSectionCollapsed(key, collapsed, template = this.getActiveTemplate(), options = {}) {
    const resolvedTemplate = template || this.getActiveTemplate();
    if (!resolvedTemplate) return;

    if (!resolvedTemplate.collapsed_sections || typeof resolvedTemplate.collapsed_sections !== 'object') {
      resolvedTemplate.collapsed_sections = {};
    }

    const targetState = !!collapsed;
    const previous = resolvedTemplate.collapsed_sections[key] === true;

    if (!this.dom.sections) {
      this.dom.sections = {};
    }

    const $block = this.dom.sections[key]?.length
      ? this.dom.sections[key]
      : this.$root.find(`[data-stdiff-section="${key}"]`);

    if ($block?.length) {
      this.dom.sections[key] = $block;
      $block.toggleClass('is-collapsed', targetState);

      const $toggle = $block.find('.stdiff-noass-collapse').first();
      if ($toggle.length) {
        $toggle.attr('aria-expanded', String(!targetState));
      }
    }

    resolvedTemplate.collapsed_sections[key] = targetState;

    if (key === 'root') {
      this.toggleBody();
    }

    if (options.save !== false && previous !== targetState) {
      this.saveDebounced();
    }
  }

  saveDebounced() {
    this.deps.saveState(this.ctx);
  }

  toast(message, level = 'info') {
    try {
      const toaster = this.ctx?.toastr || window.toastr;
      if (!toaster) return;
      const fn = toaster[level] || toaster.info;
      fn?.call(toaster, message);
    } catch {
      // ignore
    }
  }
}