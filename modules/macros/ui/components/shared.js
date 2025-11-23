import { MACRO_KEYS, EXTENSION_KEY } from '../../constants.js';
import { importModule, saveMacrosState } from '../../state/manager.js';

const TAG = '[ST-Diff][macros:UI]';
const MACROS_DOC_URL = '/scripts/extensions/third-party/ST-Diff/macros.md';

const TAB_LABELS = {
    [MACRO_KEYS.ROULETTE]: 'Roulette宏',
    [MACRO_KEYS.CASCADE]: 'Cascade宏',
};

const ACTION_LABELS = {
    importData: '导入配置',
    exportData: '导出配置',
    preview: '预览结果',
    openDocs: '查看文档',
};

const toolbarHandlers = {
    [MACRO_KEYS.ROULETTE]: createHandlerSet(),
    [MACRO_KEYS.CASCADE]: createHandlerSet(),
};

const TOOLBAR_GLOBAL_NS = '.stdiffMacrosToolbarGlobals';

// 移除宏工具栏对“世界书对比/noass”全局开关的代理展示
const GLOBAL_TOGGLE_DEFINITIONS = Object.freeze([]);

let toolbarGlobalsSync = null;

export function registerToolbarGlobalsSync(handler) {
    toolbarGlobalsSync = typeof handler === 'function' ? handler : null;
}

export function triggerToolbarGlobalsSync() {
    try {
        toolbarGlobalsSync?.();
    } catch (error) {
        console.warn(TAG, '同步宏工具栏全局开关失败', error);
    }
}

/**
 * 注册工具栏操作处理器。
 * @param {'roulette'|'cascade'} tab
 * @param {Partial<ToolbarHandlerSet>} handlers
 * @returns {() => void} 取消注册函数
 */
export function registerToolbarHandlers(tab, handlers = {}) {
    assertValidTab(tab);

    const target = toolbarHandlers[tab] ?? (toolbarHandlers[tab] = createHandlerSet());
    const previous = {};

    Object.entries(handlers).forEach(([action, fn]) => {
        if (action in target) {
            previous[action] = target[action];
            target[action] = typeof fn === 'function' ? fn : null;
        }
    });

    return () => {
        Object.entries(previous).forEach(([action, fn]) => {
            target[action] = fn ?? null;
        });
    };
}

/**
 * 渲染工具栏
 * @param {any} ctx
 * @param {import('../../state/manager.js').MacrosState} state
 * @param {{ $container: JQuery, requestSave: () => void, switchTab: (tab:string, options?:{save?:boolean}) => void, getActiveTab: () => string }} context
 * @returns {{ destroy: () => void, updateActiveTab: (tab?: string) => void }}
 */
export function renderToolbar(ctx, state, context) {
    const { $container, requestSave, switchTab, getActiveTab } = context;

    const $toolbar = $('<div class="stdiff-macros-toolbar"></div>');
    const $primary = $('<div class="stdiff-macros-toolbar__primary"></div>');
    const $secondary = $('<div class="stdiff-macros-toolbar__secondary"></div>');

    // 不再渲染宏工具栏的“全局开关”代理
    registerToolbarGlobalsSync(null);

    const buttons = {
        importData: createToolbarButton('fa-solid fa-file-arrow-up', ACTION_LABELS.importData, 'importData'),
        exportData: createToolbarButton('fa-solid fa-file-arrow-down', ACTION_LABELS.exportData, 'exportData'),
        preview: createToolbarButton('fa-solid fa-eye', ACTION_LABELS.preview, 'preview', { tone: 'primary' }),
        openDocs: createToolbarButton('fa-solid fa-circle-question', ACTION_LABELS.openDocs, 'openDocs', { tone: 'ghost' }),
    };

    const $tabIndicator = $('<span class="stdiff-macros-toolbar__indicator"></span>');

    // 工具栏仅保留全局操作（导入/导出/预览/文档），组级CRUD在面板组导航条
    $primary
        .append(buttons.importData)
        .append(buttons.exportData);

    $secondary
        .append(buttons.preview)
        .append(buttons.openDocs)
        .append($tabIndicator);

    $toolbar.append($primary).append($secondary);
    $container.append($toolbar);

    const clickNs = '.stdiffMacrosToolbar';
    $toolbar
        .off(`click${clickNs}`)
        .on(`click${clickNs}`, '[data-action]', (event) => {
            event.preventDefault();
            const action = $(event.currentTarget).data('action');
            if (!action) return;

            // 全局导入/导出：一个文件同时包含两个宏及其所有组
            if (action === 'exportData') {
                try {
                    exportAllMacrosFile(ctx, state);
                } catch (error) {
                    notify(ctx, `导出失败：${error?.message ?? error}`, 'error');
                }
                return;
            }
            if (action === 'importData') {
                try {
                    importAllMacrosFile(ctx, state, () => {
                        // 保存并刷新当前标签面板
                        try { saveMacrosState(ctx); } catch {}
                        const active = getActiveTab();
                        switchTab(active, { save: false });
                        notify(ctx, '已导入宏模块全量配置。', 'success');
                    });
                } catch (error) {
                    notify(ctx, `导入失败：${error?.message ?? error}`, 'error');
                }
                return;
            }

            // 其它操作按原有标签处理（预览/文档）
            const tab = getActiveTab();
            const handlers = ensureHandlerSet(tab);
            const handler = handlers[action];

            if (typeof handler === 'function') {
                try {
                    handler({
                        ctx,
                        state,
                        tab,
                        requestSave,
                        switchTab,
                        event,
                    });
                } catch (error) {
                    notify(ctx, `执行操作失败：${error?.message ?? error}`, 'error');
                    console.warn(TAG, `Toolbar action ${action} failed`, error);
                }
                return;
            }

            notify(ctx, `当前标签暂未实现“${ACTION_LABELS[action] ?? action}”操作`, 'warning');
        });

    const updateActiveTab = (tabOverride) => {
        const tab = tabOverride && TAB_LABELS[tabOverride]
            ? tabOverride
            : getActiveTab();
        const handlers = ensureHandlerSet(tab);

        $tabIndicator.text(`当前标签：${TAB_LABELS[tab] ?? tab}`);

        const enabled = state?.enabled === true;
        Object.entries(buttons).forEach(([action, $button]) => {
            // import/export 改为“全量（两个宏+所有组）”的文件读写，不再依赖面板handler
            const isGlobalAction = action === 'importData' || action === 'exportData';
            const hasHandler = isGlobalAction ? true : typeof handlers[action] === 'function';
            const disabled = !hasHandler || !enabled;
            $button.toggleClass('is-disabled', disabled);
            $button.prop('disabled', disabled);
        });
        if (!enabled) {
            $tabIndicator.text(`当前标签：${TAB_LABELS[tab] ?? tab}（宏已禁用）`);
        }
    };

    updateActiveTab();

    return {
        updateActiveTab,
        destroy: () => {
            registerToolbarGlobalsSync(null);
            $toolbar.off(clickNs);
            $toolbar.remove();
        },
    };
}

function createGlobalToggleControls(ctx) {
    const toggles = [];
    const $container = $('<div class="stdiff-macros-toolbar__globals"></div>');

    GLOBAL_TOGGLE_DEFINITIONS.forEach((definition) => {
        const toggle = createGlobalToggle(ctx, definition);
        if (toggle) {
            toggles.push(toggle);
            $container.append(toggle.$wrapper);
        }
    });

    if (!toggles.length) {
        $container.remove();
        return null;
    }

    return {
        $container,
        sync: () => toggles.forEach((toggle) => toggle.sync()),
        destroy: () => {
            toggles.forEach((toggle) => toggle.destroy());
            $container.remove();
        },
    };
}

function createGlobalToggle(ctx, definition) {
    const handlerNs = `${TOOLBAR_GLOBAL_NS}.${definition.id}`;
    const $wrapper = $('<label class="checkbox_label stdiff-macros-toolbar__global"></label>')
        .attr('for', definition.id)
        .attr('data-primary-selector', definition.primarySelector);

    const $input = $('<input type="checkbox">')
        .attr('id', definition.id)
        .attr('data-primary-selector', definition.primarySelector);

    const $text = $('<span></span>').text(definition.label);

    $wrapper.append($input, $text);

    let isSyncing = false;

    const sync = () => {
        const next = resolveGlobalToggleState(ctx, definition);
        isSyncing = true;
        $input.prop('checked', next);
        isSyncing = false;
    };

    const persistThroughPrimary = (checked) => {
        if (updatePrimaryToggle(definition.primarySelector, checked)) {
            return;
        }

        const settingsRoot = getSettingsRoot(ctx);
        const extSettings = (settingsRoot[EXTENSION_KEY] ||= {});
        writeSettingValue(extSettings, definition.settingsPath, checked);

        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        } else if (typeof window?.saveSettingsDebounced === 'function') {
            window.saveSettingsDebounced();
        }
    };

    $input
        .off(handlerNs)
        .on(`change${handlerNs}`, (event) => {
            if (isSyncing) return;
            const checked = $(event.currentTarget).is(':checked');
            persistThroughPrimary(checked);
        });

    sync();

    return {
        $wrapper,
        sync,
        destroy: () => {
            $input.off(handlerNs);
            $wrapper.remove();
        },
    };
}

function getSettingsRoot(ctx) {
    if (ctx?.extensionSettings) {
        return ctx.extensionSettings;
    }
    window.extension_settings ??= {};
    return window.extension_settings;
}

function resolveGlobalToggleState(ctx, definition) {
    const primary = $(definition.primarySelector);
    if (primary.length) {
        return primary.is(':checked');
    }

    const settingsRoot = getSettingsRoot(ctx);
    const extSettings = settingsRoot[EXTENSION_KEY] ?? {};
    const stored = readSettingValue(extSettings, definition.settingsPath);
    if (typeof stored === 'boolean') {
        return stored;
    }

    return false;
}

function readSettingValue(target, path = []) {
    if (!target) return undefined;
    let current = target;
    for (const key of path) {
        if (current == null || typeof current !== 'object' || !(key in current)) {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

function writeSettingValue(target, path = [], value) {
    let current = target;
    const lastIndex = path.length - 1;
    if (lastIndex < 0) return;

    path.forEach((key, index) => {
        if (index === lastIndex) {
            current[key] = value;
            return;
        }
        current[key] ??= {};
        if (typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    });
}

function updatePrimaryToggle(primarySelector, checked) {
    const $primary = $(primarySelector);
    if (!$primary.length) {
        return false;
    }

    const current = $primary.is(':checked');
    if (current !== checked) {
        $primary.prop('checked', checked);
    }
    $primary.trigger('change');
    return true;
}

/**
 * 创建列表行基础骨架
 * @param {{ id?: string, label?: string, value?: string, weight?: number, enabled?: boolean }} entry
 * @param {{
 *   draggable?: boolean,
 *   allowWeight?: boolean,
 *   allowToggle?: boolean,
 *   multiline?: boolean,
 *   classes?: string,
 *   placeholderLabel?: string,
 *   placeholderValue?: string,
 *   weightOptions?: WeightInputOptions
 * }} options
 * @returns {{ $row: JQuery, refs: ListRowRefs }}
 */
export function createListRow(entry = {}, options = {}) {
    const {
        draggable = true,
        allowWeight = true,
        allowToggle = true,
        multiline = true,
        classes = '',
        placeholderLabel = '名称（可选）',
        placeholderValue = '内容',
        weightOptions = {},
    } = options;

    const id = entry.id ?? '';
    const $row = $('<div class="stdiff-macros__row"></div>')
        .attr('data-entry-id', id)
        .addClass(classes);
  
    const refs = {};
    let columnIndex = 0;
  
    if (draggable) {
        refs.drag = $('<button type="button" class="stdiff-macros__drag" title="拖动排序"></button>')
            .append('<i class="fa-solid fa-grip-vertical"></i>');
        $row.append(refs.drag);
        columnIndex += 1;
    } else {
        $row.addClass('stdiff-macros__row--no-drag');
    }
  
    const $main = $('<div class="stdiff-macros__inputs"></div>');
    refs.label = $('<input type="text" class="text_pole stdiff-macros__input stdiff-macros__input--label">')
        .attr('placeholder', placeholderLabel)
        .val(entry.label ?? '');
    $main.append(refs.label);
  
    refs.value = multiline
        ? $('<textarea class="textarea stdiff-macros__input stdiff-macros__input--value" rows="2"></textarea>')
        : $('<input type="text" class="text_pole stdiff-macros__input stdiff-macros__input--value">');
  
    refs.value.val(entry.value ?? '').attr('placeholder', placeholderValue);
    $main.append(refs.value);
    $row.append($main);
    columnIndex += 1;
  
    if (allowWeight) {
        refs.weight = createWeightInput(entry.weight ?? 1, weightOptions);
        $row.append(
            $('<div class="stdiff-macros__cell stdiff-macros__cell--weight"></div>').append(refs.weight),
        );
        columnIndex += 1;
    }
  
    if (allowToggle) {
        refs.enabled = $('<label class="stdiff-macros__toggle"></label>')
            .append(
                $('<input type="checkbox">')
                    .prop('checked', entry.enabled !== false)
                    .attr('data-field', 'enabled'),
            )
            .append('<span>启用</span>');
        $row.append($('<div class="stdiff-macros__cell stdiff-macros__cell--toggle"></div>').append(refs.enabled));
        columnIndex += 1;
    }
  
    refs.delete = $('<button type="button" class="menu_button menu_button--danger stdiff-macros__delete" title="删除条目"></button>')
        .attr('data-action', 'delete')
        .append('<i class="fa-solid fa-trash"></i>');
    $row.append(refs.delete);
    columnIndex += 1;
  
    // 为不同列组合动态设置 grid 模板，避免在缺列时出现不理想的空位与压缩
    const columns = [];
    if (draggable) columns.push('auto');                         // 可拖动
    columns.push('minmax(160px, 1fr)');                          // 主输入（标签+内容）
    if (allowWeight) columns.push('minmax(80px, 120px)');        // 权重
    if (allowToggle) columns.push('minmax(72px, 100px)');        // 启用
    columns.push('auto');                                        // 删除
    $row.css('grid-template-columns', columns.join(' '));
    $row.css('--stdiff-macros-columns', columnIndex); // 兼容旧样式变量
  
    return { $row, refs };
}

/**
 * 创建权重输入。
 * @param {number} value
 * @param {WeightInputOptions} options
 * @returns {JQuery}
 */
export function createWeightInput(value = 1, options = {}) {
    const {
        min = 0,
        max = 999999,
        step = 0.01,
        precision = 4,
        placeholder = '权重',
    } = options;

    const formatted = formatWeight(value, precision);

    return $('<input type="number" class="text_pole stdiff-macros__input stdiff-macros__input--weight">')
        .attr({
            min,
            max,
            step,
            placeholder,
        })
        .val(formatted);
}

/**
 * 绑定权重输入校验。
 * @param {JQuery<HTMLInputElement>} $input
 * @param {WeightInputOptions & { onCommit?: (value:number) => void }} options
 * @returns {() => void} 解绑函数
 */
export function bindWeightInput($input, options = {}) {
    const {
        min = 0,
        max = Number.POSITIVE_INFINITY,
        precision = 4,
        onCommit,
    } = options;

    const handlerNs = '.stdiffMacrosWeight';
    const commit = () => {
        const safeValue = clampWeight($input.val(), { min, max, precision });
        $input.val(safeValue);
        if (typeof onCommit === 'function') {
            onCommit(Number(safeValue));
        }
    };

    $input
        .off(handlerNs)
        .on(`change${handlerNs} blur${handlerNs}`, commit)
        .on(`keydown${handlerNs}`, (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            }
        });

    return () => {
        $input.off(handlerNs);
    };
}

/**
 * 绑定文本输入提交
 * @param {JQuery} $input
 * @param {{ trim?: boolean, onCommit?: (value:string) => void }} options
 * @returns {() => void}
 */
export function bindTextInput($input, options = {}) {
    const { trim = true, onCommit } = options;
    const handlerNs = '.stdiffMacrosText';

    const commit = () => {
        const raw = $input.val();
        const value = typeof raw === 'string' && trim ? raw.trim() : raw;
        if (typeof onCommit === 'function') {
            onCommit(value);
        }
    };

    $input
        .off(handlerNs)
        .on(`blur${handlerNs}`, commit)
        .on(`keydown${handlerNs}`, (event) => {
            if (event.key === 'Enter' && !(event.ctrlKey || event.shiftKey)) {
                event.preventDefault();
                commit();
                event.currentTarget.blur();
            }
        });

    return () => $input.off(handlerNs);
}

/**
 * 绑定多行自适应高度
 * @param {JQuery<HTMLTextAreaElement>} $textarea
 * @param {{ maxHeight?: number }} options
 * @returns {() => void}
 */
export function bindAutoResize($textarea, options = {}) {
    const { maxHeight = 360 } = options;
    const handlerNs = '.stdiffMacrosAutoResize';

    const resize = () => {
        const el = $textarea[0];
        if (!el) return;
        el.style.height = 'auto';
        const next = Math.min(el.scrollHeight + 4, maxHeight);
        el.style.height = `${next}px`;
    };

    $textarea.off(handlerNs).on(`input${handlerNs}`, resize);
    resize();

    return () => $textarea.off(handlerNs);
}

/**
 * 绑定删除按钮
 * @param {JQuery<HTMLButtonElement>} $button
 * @param {{ message?: string, onConfirm: () => void }} options
 * @returns {() => void}
 */
export function bindDeleteButton($button, options = {}) {
    const { message = '确认删除？', onConfirm } = options;
    const handlerNs = '.stdiffMacrosDelete';

    // 不再使用浏览器确认框，直接执行删除回调，具体的提示交由调用侧负责
    $button.off(handlerNs).on(`click${handlerNs}`, (event) => {
        event.preventDefault();
        try {
            if (typeof onConfirm === 'function') {
                onConfirm();
            }
        } catch (error) {
            console.warn(TAG, '删除操作失败', error);
        }
    });

    return () => $button.off(handlerNs);
}

/**
 * 绑定启用开关。
 * @param {JQuery<HTMLInputElement>} $checkbox
 * @param {{ onChange?: (value:boolean) => void }} options
 * @returns {() => void}
 */
export function bindToggle($checkbox, options = {}) {
    const handlerNs = '.stdiffMacrosToggle';

    $checkbox.off(handlerNs).on(`change${handlerNs}`, (event) => {
        const value = $(event.currentTarget).is(':checked');
        if (typeof options.onChange === 'function') {
            options.onChange(value);
        }
    });

    return () => $checkbox.off(handlerNs);
}

/**
 * 显示字段错误。
 * @param {JQuery} $element
 * @param {string} message
 */
export function setFieldError($element, message) {
    if (!$element || !$element.length) return;
    $element.addClass('is-error');
    $element.attr('data-error', message);
}

/**
 * 清除字段错误。
 * @param {JQuery} $element
 */
export function clearFieldError($element) {
    if (!$element || !$element.length) return;
    $element.removeClass('is-error');
    $element.removeAttr('data-error');
}

/**
 * 滚动元素进入视图
 * @param {JQuery} $element
 * @param {{ behavior?: ScrollBehavior, block?: ScrollLogicalPosition }} options
 */
export function scrollIntoView($element, options = {}) {
    const el = $element?.[0];
    if (!el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({
        behavior: options.behavior ?? 'smooth',
        block: options.block ?? 'center',
    });
}

/* -------------------------------------------------------------------------- */
/* 内部工具                                                                    */
/* -------------------------------------------------------------------------- */

function createHandlerSet() {
    return {
        createGroup: null,
        duplicateGroup: null,
        deleteGroup: null,
        importData: null,
        exportData: null,
        preview: null,
        openDocs: null,
    };
}

function ensureHandlerSet(tab) {
    assertValidTab(tab);
    toolbarHandlers[tab] ??= createHandlerSet();
    return toolbarHandlers[tab];
}

function assertValidTab(tab) {
    if (!Object.values(MACRO_KEYS).includes(tab)) {
        throw new Error(`${TAG} 不支持的标签：${tab}`);
    }
}

function clampWeight(rawValue, { min, max, precision }) {
    const numeric = Number.parseFloat(rawValue);
    if (!Number.isFinite(numeric)) {
        return formatWeight(min, precision);
    }
    const clamped = Math.min(Math.max(numeric, min), max);
    return formatWeight(clamped, precision);
}

/**
 * 将数值格式化为字符串
 * @param {number} value
 * @param {number} precision
 * @returns {string}
 */
export function formatWeight(value, precision = 4) {
    if (!Number.isFinite(value)) return '0';
    const factor = 10 ** precision;
    const rounded = Math.round(value * factor) / factor;
    return rounded.toString();
}

function createToolbarButton(iconClass, label, action, options = {}) {
    const { tone = 'default' } = options;
    return $('<button type="button" class="menu_button stdiff-macros-toolbar__button"></button>')
        .toggleClass(`menu_button--${tone}`, tone && tone !== 'default')
        .attr('data-action', action)
        .append(`<i class="${iconClass}" aria-hidden="true"></i>`)
        .append(`<span>${label}</span>`);
}

export function notify(ctx, message, type = 'info') {
    const notifier = ctx?.ui?.notify ?? window?.stdiffNotify ?? window?.notify;
    if (typeof notifier === 'function') {
        notifier(message, type);
        return;
    }

    if (window?.toastr && typeof window.toastr[type] === 'function') {
        window.toastr[type](message);
        return;
    }

    if (type === 'error') {
        console.error(TAG, message);
    } else {
        console.log(TAG, message);
    }
}

/**
 * 打开宏文档弹窗：加载 ST-Diff/macros.md，使用酒馆 markdown渲染（showdown + DOMPurify）转换为html，
 * 然后通过callGenericPopup展示。若缺少 md 渲染，则回退为纯文本显示
 *
 * 运行时直接从扩展目录读取 md，并使用酒馆全局的 showdown 管线进行渲染。
 * 若任一依赖缺失（showdown / DOMPurify / callGenericPopup），则不抛出到调用侧  而是回退为纯文本弹窗
 *
 * @param {ReturnType<typeof import('../../../index.js')['getCtx']>} ctx
 * @param {'roulette'|'cascade'} [tab] 当前激活的标签，用于在弹窗中滚动到对应小节
 */
export async function openMacrosDocs(ctx, tab) {
    try {
        // 优先方案（更新）：若模板目录存在 Markdown 且宿主具备 showdown，则优先用 Markdown 渲染，便于测试/本地化
        try {
            const tmplMdResHead = await fetch('/scripts/extensions/third-party/ST-Diff/presentation/templates/macros-docs.md', { cache: 'no-cache' });
            if (tmplMdResHead?.ok) {
                const tmplMd = await tmplMdResHead.text();
                const htmlFromMd = renderMarkdownToHtmlSafe(tmplMd);

                const content = document.createElement('div');
                content.className = 'stdiff-doc stdiff-doc--macros';
                content.innerHTML = htmlFromMd;

                const callPopup = resolveCallGenericPopup(ctx);
                const popupType = resolvePopupType(ctx);
                const onOpen = createDocsOnOpenHandler(tab);

                await callPopup(content, popupType, '', {
                    wide: true,
                    large: true,
                    allowVerticalScrolling: true,
                    leftAlign: true,
                    onOpen,
                });
                return;
            }
        } catch (mdFirstErr) {
            console.debug(TAG, 'markdown 渲染检测失败，尝试 HTML 模板', mdFirstErr);
        }

        // 次方案：加载预编译的html模板，避免运行时依赖 showdown/DOMPurify，获得更快的弹窗展示
        // 模板路径与主面板一致：third-party/ST-Diff/presentation/templates/macros-docs.html
        const base = 'third-party/ST-Diff/presentation/templates';
        if (ctx?.renderExtensionTemplateAsync) {
            try {
                const tplHtml = await ctx.renderExtensionTemplateAsync(base, 'macros-docs');
                if (tplHtml && typeof tplHtml === 'string') {
                    const content = document.createElement('div');
                    content.className = 'stdiff-doc stdiff-doc--macros';
                    content.innerHTML = tplHtml;

                    const callPopup = resolveCallGenericPopup(ctx);
                    const popupType = resolvePopupType(ctx);
                    const onOpen = createDocsOnOpenHandler(tab);

                    await callPopup(content, popupType, '', {
                        wide: true,
                        large: true,
                        allowVerticalScrolling: true,
                        leftAlign: true,
                        onOpen,
                    });
                    return; // 模板成功则直接返回
                }
            } catch (e) {
                console.debug(TAG, '预编译文档模板不可用，尝试加载模板目录中的 Markdown', e);
            }
        }

        // 尝试从模板目录加载 md（macros-docs.md），若存在则用酒馆 md 渲染
        try {
            const tmplMdRes = await fetch('/scripts/extensions/third-party/ST-Diff/presentation/templates/macros-docs.md', { cache: 'no-cache' });
            if (tmplMdRes?.ok) {
                const tmplMd = await tmplMdRes.text();
                const htmlFromMd = renderMarkdownToHtmlSafe(tmplMd);

                const content = document.createElement('div');
                content.className = 'stdiff-doc stdiff-doc--macros';
                content.innerHTML = htmlFromMd;

                const callPopup = resolveCallGenericPopup(ctx);
                const popupType = resolvePopupType(ctx);
                const onOpen = createDocsOnOpenHandler(tab);

                await callPopup(content, popupType, '', {
                    wide: true,
                    large: true,
                    allowVerticalScrolling: true,
                    leftAlign: true,
                    onOpen,
                });
                return;
            }
        } catch (e2) {
            console.debug(TAG, '模板目录 Markdown 不可用，继续使用根目录 macros.md', e2);
        }

        // 回退方案：运行时加载根目录 md 并使用酒馆的 showdown + DOMPurify 渲染
        const response = await fetch(MACROS_DOC_URL, { cache: 'no-cache' });
        if (!response?.ok) {
            throw new Error(`请求宏文档失败：HTTP ${response.status}`);
        }

        const markdown = await response.text();
        const html = renderMarkdownToHtmlSafe(markdown);

        const content = document.createElement('div');
        content.className = 'stdiff-doc stdiff-doc--macros';
        content.innerHTML = html;

        const callPopup = resolveCallGenericPopup(ctx);
        const popupType = resolvePopupType(ctx);
        const onOpen = createDocsOnOpenHandler(tab);

        await callPopup(content, popupType, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            leftAlign: true,
            onOpen,
        });
    } catch (error) {
        console.warn(TAG, '打开宏文档失败，回退为纯文本展示', error);
        const fallbackText = '无法加载宏文档（macros.md / 预编译模板）。\n\n错误信息：' + (error?.message || String(error));

        try {
            const callPopup = resolveCallGenericPopup(ctx);
            const popupType = resolvePopupType(ctx);

            await callPopup(
                `<pre class="stdiff-doc stdiff-doc--fallback">${escapeHtml(fallbackText)}</pre>`,
                popupType,
                '',
                {
                    wide: true,
                    large: false,
                    allowVerticalScrolling: true,
                    leftAlign: true,
                },
            );
        } catch (innerError) {
            // 连弹窗都不可用时，只能最后写日志
            console.error(TAG, '宏文档回退弹窗也失败', innerError);
        }
    }
}

/**
 * 使用酒馆提供的showdown + DOMPurify（若存在）将 md 转换为 html
 * 若缺少任一依赖，则退回为简单的 <pre> 文本
 *
 * @param {string} markdown
 * @returns {string}
 */
function renderMarkdownToHtmlSafe(markdown) {
    const showdownGlobal = window.showdown;
    const domPurifyGlobal = window.DOMPurify;

    if (showdownGlobal && typeof showdownGlobal.Converter === 'function') {
        try {
            const converter = new showdownGlobal.Converter();
            let rawHtml = converter.makeHtml(markdown);

            if (domPurifyGlobal && typeof domPurifyGlobal.sanitize === 'function') {
                rawHtml = domPurifyGlobal.sanitize(rawHtml);
            }

            return rawHtml;
        } catch (error) {
            console.warn(TAG, 'Markdown 渲染失败，使用纯文本回退', error);
        }
    }

    // 回退：简单转义 + 保留换行
    return `<pre class="stdiff-doc stdiff-doc--fallback">${escapeHtml(markdown)}</pre>`;
}

/**
 * 解析可用的callGenericPopup。
 * 优先使用ctx.callGenericPopup，其次使用全局window.callGenericPopup。
 *
 * @param {any} ctx
 * @returns {(content:any, type:any, inputValue?:string, options?:any) => Promise<any>}
 */
function resolveCallGenericPopup(ctx) {
    const fromCtx = ctx?.callGenericPopup;
    if (typeof fromCtx === 'function') {
        return fromCtx.bind(ctx);
    }

    const fromWindow = window.callGenericPopup;
    if (typeof fromWindow === 'function') {
        return fromWindow;
    }

    throw new Error('宿主缺少 callGenericPopup，无法展示宏文档。');
}

/**
 * 解析POPUP_TYPE.TEXT
 *
 * @param {any} ctx
 * @returns {number}
 */
function resolvePopupType(ctx) {
    const typeFromCtx = ctx?.POPUP_TYPE?.TEXT;
    if (typeof typeFromCtx !== 'undefined') {
        return typeFromCtx;
    }

    const typeFromWindow = window.POPUP_TYPE?.TEXT;
    if (typeof typeFromWindow !== 'undefined') {
        return typeFromWindow;
    }

    // 默认值：TEXT = 1（见popup.js定义）
    return 1;
}

/**
 * 创建文档弹窗的onOpen回调，在弹出后滚动到对应小节
 *
 * @param {'roulette'|'cascade'} [tab]
 * @returns {(popup:any) => void}
 */
function createDocsOnOpenHandler(tab) {
    const targetId = tab === MACRO_KEYS.CASCADE
        ? 'stdiff-doc-cascade'
        : 'stdiff-doc-roulette';

    return (popup) => {
        try {
            const root = popup?.content || popup?.dlg?.querySelector?.('.popup-content') || null;
            if (!root) return;

            const anchor = root.querySelector?.(`#${targetId}`);
            if (anchor && typeof anchor.scrollIntoView === 'function') {
                anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } catch (error) {
            console.warn(TAG, '文档弹窗 onOpen 处理失败', error);
        }
    };
}

/**
 * 简单的html转义，用于fallback模式
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&' + 'amp;')
        .replace(/</g, '&' + 'lt;')
        .replace(/>/g, '&' + 'gt;')
        .replace(/"/g, '&' + 'quot;')
        .replace(/'/g, '&#39;');
}

/* -------------------------------------------------------------------------- */
/* 全量导入/导出：两个宏 + 全部组                                                 */
/* -------------------------------------------------------------------------- */

function stripGroupRuntimeFields(group) {
    const cloned = JSON.parse(JSON.stringify(group || {}));
    if (cloned && typeof cloned === 'object') {
        delete cloned.metadata;
    }
    return cloned;
}

function buildFullMacrosSnapshot(state) {
    const rouletteGroups = Object.values(state?.roulette?.groups || {}).map(stripGroupRuntimeFields);
    const cascadeGroups = Object.values(state?.cascade?.groups || {}).map(stripGroupRuntimeFields);
    return {
        version: Number.isFinite(state?.version) ? state.version : 1,
        enabled: state?.enabled !== false,
        roulette: {
            enabled: state?.roulette?.enabled !== false,
            preventRepeat: state?.roulette?.preventRepeat === true,
            activeGroupId: state?.roulette?.activeGroupId || (rouletteGroups[0]?.id || ''),
            groups: rouletteGroups,
        },
        cascade: {
            enabled: state?.cascade?.enabled !== false,
            activeGroupId: state?.cascade?.activeGroupId || (cascadeGroups[0]?.id || ''),
            groups: cascadeGroups,
        },
    };
}

function exportAllMacrosFile(ctx, state) {
    const full = buildFullMacrosSnapshot(state);
    const payload = { macros: full };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ST-Diff-macros.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify(ctx, '已导出宏模块全量配置文件。', 'info');
}

function importAllMacrosFile(ctx, state, onDone) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';

    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) { input.remove(); return; }

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result ?? '');
                const parsed = JSON.parse(text);
                const root = parsed?.macros || parsed;

                if (!root || typeof root !== 'object') {
                    throw new Error('文件不包含 macros 配置');
                }

                // 顶层开关
                if (typeof root.enabled === 'boolean') {
                    state.enabled = root.enabled;
                }
                if (Number.isFinite(root.version)) {
                    state.version = root.version;
                }

                // 轮盘
                if (root.roulette && typeof root.roulette === 'object') {
                    if (Array.isArray(root.roulette.groups)) {
                        importModule(ctx, state, MACRO_KEYS.ROULETTE, { groups: root.roulette.groups });
                    }
                    if (typeof root.roulette.enabled === 'boolean') {
                        state.roulette.enabled = root.roulette.enabled;
                    }
                    if (typeof root.roulette.preventRepeat === 'boolean') {
                        state.roulette.preventRepeat = root.roulette.preventRepeat;
                    }
                    if (typeof root.roulette.activeGroupId === 'string' && root.roulette.activeGroupId) {
                        state.roulette.activeGroupId = root.roulette.activeGroupId;
                    }
                }

                // 瀑布
                if (root.cascade && typeof root.cascade === 'object') {
                    if (Array.isArray(root.cascade.groups)) {
                        importModule(ctx, state, MACRO_KEYS.CASCADE, { groups: root.cascade.groups });
                    }
                    if (typeof root.cascade.enabled === 'boolean') {
                        state.cascade.enabled = root.cascade.enabled;
                    }
                    if (typeof root.cascade.activeGroupId === 'string' && root.cascade.activeGroupId) {
                        state.cascade.activeGroupId = root.cascade.activeGroupId;
                    }
                }

                // 持久化
                try { saveMacrosState(ctx); } catch {}
                notify(ctx, '宏模块全量配置导入完成。', 'success');
                if (typeof onDone === 'function') onDone();
            } catch (error) {
                console.warn(TAG, '导入宏模块全量配置失败', error);
                notify(ctx, `导入失败：${error?.message ?? error}`, 'error');
            } finally {
                input.remove();
            }
        };
        reader.readAsText(file, 'utf-8');
    }, { once: true });

    document.body.appendChild(input);
    input.click();
}

/**
 * @typedef {Object} ToolbarHandlerSet
 * @property {(payload: ToolbarActionPayload) => void|null} createGroup
 * @property {(payload: ToolbarActionPayload) => void|null} duplicateGroup
 * @property {(payload: ToolbarActionPayload) => void|null} deleteGroup
 * @property {(payload: ToolbarActionPayload) => void|null} importData
 * @property {(payload: ToolbarActionPayload) => void|null} exportData
 * @property {(payload: ToolbarActionPayload) => void|null} preview
 * @property {(payload: ToolbarActionPayload) => void|null} openDocs
 *
 * @typedef {Object} ToolbarActionPayload
 * @property {any} ctx
 * @property {import('../../state/manager.js').MacrosState} state
 * @property {'roulette'|'cascade'} tab
 * @property {() => void} requestSave
 * @property {(tab:string, options?:{save?:boolean}) => void} switchTab
 * @property {JQuery.Event} [event]
 *
 * @typedef {Object} WeightInputOptions
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {number} [precision]
 * @property {string} [placeholder]
 *
 * @typedef {Object} ListRowRefs
 * @property {JQuery} [drag]
 * @property {JQuery} [label]
 * @property {JQuery} [value]
 * @property {JQuery} [weight]
 * @property {JQuery} [enabled]
 * @property {JQuery} [delete]
 */
