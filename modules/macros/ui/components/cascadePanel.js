
import { MACRO_KEYS } from '../../constants.js';
import {
    registerToolbarHandlers,
    createListRow,
    bindWeightInput,
    bindTextInput,
    bindAutoResize,
    bindDeleteButton,
    bindToggle,
    notify,
    scrollIntoView,
    clearFieldError,
    setFieldError,
    openMacrosDocs,
} from './shared.js';
import {
    createDefaultCascadeGroup,
    createDefaultCascadeOption,
} from '../../state/defaults.js';
import {
    setGroup,
    deleteGroup,
    exportModule,
    importModule,
    MacroStateError,
    saveMacrosState,
    renameGroup,
} from '../../state/manager.js';
import { generateId } from '../../runtime/utils.js';
import { execute as executeCascade } from '../../runtime/cascade.js';
import { createEvaluator } from '../../runtime/evaluator.js';

const SORT_OPTIONS = [
    { value: 'none', label: '保持顺序' },
    { value: 'asc', label: '升序排序' },
    { value: 'desc', label: '降序排序' },
];
const TAG = '[ST-Diff][macros:UI:cascade]';

/**
 * 渲染 Cascade宏面板
 * @param {any} ctx
 * @param {import('../../state/manager.js').MacrosState} state
 * @param {{ $container: JQuery, requestSave: () => void, requestRefresh: () => void }} context
 * @returns {() => void}
 */
export function renderCascadePanel(ctx, state, context) {
    const { $container, requestSave, requestRefresh } = context;
    const cleanupStack = [];
    const evaluator = createEvaluator(ctx);

    const getActiveGroup = () => {
        const groupId = state?.cascade?.activeGroupId;
        return state?.cascade?.groups?.[groupId] || null;
    };

    let group = getActiveGroup();
    if (!group) {
        const $placeholder = $('<div class="stdiff-macros-empty"></div>')
            .text('未找到 Cascade宏 组，请在面板顶部的组导航条新建。');
        $container.append($placeholder);
        return () => $placeholder.remove();
    }

    const unregisterToolbar = registerToolbarHandlers(MACRO_KEYS.CASCADE, {
        createGroup: () => handleCreateGroup(),
        duplicateGroup: () => handleDuplicateGroup(),
        deleteGroup: () => handleDeleteGroup(),
        importData: () => handleImport(),
        exportData: () => handleExport(),
        preview: () => runPreview(),
        // 使用共享文档 Helper：根据当前 Tab 打开并定位到 Cascade 小节
        openDocs: () => openMacrosDocs(ctx, MACRO_KEYS.CASCADE),
    });
    cleanupStack.push(unregisterToolbar);

    // 嵌套 .stdiff-macros-pane 会被 CSS 隐藏，改为直接将内容附加到外层容器
    const $form = $('<div class="stdiff-macros-form"></div>');

    /* 方案B：组导航条（上一组 / 指示 / 下一组 / 新建 / 复制 / 删除） */
    const $groupbar = $('<div class="stdiff-macros-groupbar"></div>');
    const $prevBtn = $('<button type="button" class="menu_button stdiff-macros-groupbar__prev"><span>上一组</span></button>');
    const $indexLabel = $('<span class="stdiff-macros-groupbar__index"></span>');
    const $nextBtn = $('<button type="button" class="menu_button stdiff-macros-groupbar__next"><span>下一组</span></button>');
    const $createBtn = $('<button type="button" class="menu_button stdiff-macros-groupbar__create"><span>新建</span></button>');
    const $dupBtn = $('<button type="button" class="menu_button stdiff-macros-groupbar__duplicate"><span>复制</span></button>');
    const $delBtn = $('<button type="button" class="menu_button menu_button--danger stdiff-macros-groupbar__delete"><span>删除</span></button>');

    $groupbar.append($prevBtn, $indexLabel, $('<span class="stdiff-macros-groupbar__spacer"></span>'), $nextBtn, $createBtn, $dupBtn, $delBtn);
    $container.append($groupbar);

    const updateGroupbarIndex = () => {
        const ids = Object.keys(state.cascade.groups);
        const idx = Math.max(0, ids.indexOf(state.cascade.activeGroupId));
        $indexLabel.text(`${idx + 1} / ${ids.length}`);
        $prevBtn.prop('disabled', ids.length <= 1 || idx <= 0);
        $nextBtn.prop('disabled', ids.length <= 1 || idx >= ids.length - 1);
    };

    const groupbarNs = '.stdiffMacrosGroupbarCascade';
    $prevBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.cascade.groups);
        const idx = ids.indexOf(state.cascade.activeGroupId);
        if (idx > 0) {
            state.cascade.activeGroupId = ids[idx - 1];
            saveMacrosState(ctx);
            requestSave();
            requestRefresh();
        }
    });
    $nextBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.cascade.groups);
        const idx = ids.indexOf(state.cascade.activeGroupId);
        if (idx < ids.length - 1) {
            state.cascade.activeGroupId = ids[idx + 1];
            saveMacrosState(ctx);
            requestSave();
            requestRefresh();
        }
    });
    $createBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => { e.preventDefault(); handleCreateGroup(); updateGroupbarIndex(); });
    $dupBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => { e.preventDefault(); handleDuplicateGroup(); updateGroupbarIndex(); });
    $delBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => { e.preventDefault(); handleDeleteGroup(); updateGroupbarIndex(); });

    cleanupStack.push(() => {
        $prevBtn.off(groupbarNs);
        $nextBtn.off(groupbarNs);
        $createBtn.off(groupbarNs);
        $dupBtn.off(groupbarNs);
        $delBtn.off(groupbarNs);
        $groupbar.remove();
    });

    /* ---------------------------- 基础信息 ---------------------------- */

    const $groupRow = $('<div class="stdiff-macros-form__row"></div>');
    const $groupLabel = $('<label class="stdiff-macros-form__label">宏组</label>');
    const $groupSelect = $('<select class="select stdiff-macros-form__control"></select>');
    Object.values(state.cascade.groups).forEach((item) => {
        $groupSelect.append(
            $('<option></option>')
                .val(item.id)
                .text(item.label || item.id),
        );
    });
    $groupSelect.val(group.id);
    $groupRow.append($groupLabel, $groupSelect);

    // 可编辑“调用名(ID)”
    const $idRow = $('<div class="stdiff-macros-form__row"></div>');
    const $idLabel = $('<label class="stdiff-macros-form__label">调用名（ID）</label>');
    const $idInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '用于模板调用的标识，如 myList')
        .attr('maxlength', 32)
        .val(group.id);
    $idRow.append($idLabel, $idInput);

    const $nameRow = $('<div class="stdiff-macros-form__row"></div>');
    const $nameLabel = $('<label class="stdiff-macros-form__label">名称</label>');
    const $nameInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '用于展示的宏组名称')
        .val(group.label ?? '');
    $nameRow.append($nameLabel, $nameInput);

    const $descRow = $('<div class="stdiff-macros-form__row"></div>');
    const $descLabel = $('<label class="stdiff-macros-form__label">描述</label>');
    const $descInput = $('<textarea class="textarea stdiff-macros-form__control" rows="2"></textarea>')
        .attr('placeholder', '可选描述，记录条目来源或用途')
        .val(group.description ?? '');
    $descRow.append($descLabel, $descInput);

    /* ---------------------------- 范围设置 ---------------------------- */

    const $rangeRow = $('<div class="stdiff-macros-form__row stdiff-macros-form__row--split"></div>');
    const $minWrapper = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">最小行数</label>');
    const $minInput = $('<input type="number" class="text_pole stdiff-macros-form__control stdiff-macros-form__control--compact">')
        .attr({ min: 0, max: 500, step: 1 })
        .val(group.range?.min ?? 1);
    const $maxWrapper = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">最大行数</label>');
    const $maxInput = $('<input type="number" class="text_pole stdiff-macros-form__control stdiff-macros-form__control--compact">')
        .attr({ min: 0, max: 500, step: 1 })
        .val(group.range?.max ?? 1);
    $rangeRow.append($minWrapper, $minInput, $maxWrapper, $maxInput);

    /* ---------------------------- 拼接与排序 ---------------------------- */

    const $joinRow = $('<div class="stdiff-macros-form__row"></div>');
    const $joinLabel = $('<label class="stdiff-macros-form__label">拼接符 (Joiner)</label>');
    const $joinInput = $('<textarea class="textarea stdiff-macros-form__control" rows="2"></textarea>')
        .attr('placeholder', '行间拼接符，例如 \\n 或空行')
        .val(group.joiner ?? '\n');
    $joinRow.append($joinLabel, $joinInput);

    // 前缀（每行自动加序号）
    const $prefixRow = $('<div class="stdiff-macros-form__row"></div>');
    const $prefixLabel = $('<label class="stdiff-macros-form__label">前缀</label>');
    const $prefixInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '例如 段落')
        .attr('maxlength', 64)
        .val(group.prefix ?? '');
    $prefixRow.append($prefixLabel, $prefixInput);

    // 前缀合并（默认开启）：当宏的元素以 “前缀:” / “前缀：” 开头时，自动去掉重复前缀
    const $dedupeRow = $('<div class="stdiff-macros-form__row"></div>');
    const $dedupeToggle = $('<label class="stdiff-macros-switch"></label>')
        .append(
            $('<input type="checkbox">')
                .prop('checked', group.dedupePrefix !== false),
        )
        .append('<span>前缀去重</span>');
    $dedupeRow.append($dedupeToggle);

    // 对xml块内的宏进行连续编号：仅影响提示词，没法支持渲染
    const $renumberRow = $('<div class="stdiff-macros-form__row stdiff-macros-form__row--split"></div>');
    const $renumberToggle = $('<label class="stdiff-macros-switch"></label>')
        .append(
            $('<input type="checkbox">')
                .prop('checked', state?.cascade?.renumber?.enabled !== false),
        )
        .append('<span>对xml块内的宏进行连续编号</span>');
    const $renumberLabel = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">标签名</label>');
    const $renumberInput = $('<input type="text" class="text_pole stdiff-macros-form__control stdiff-macros-form__control--compact">')
        .attr('placeholder', 'framework')
        .attr('maxlength', 64)
        .val(state?.cascade?.renumber?.tagName ?? 'framework');
    $renumberRow.append($renumberToggle, $renumberLabel, $renumberInput);

    const $optionsRow = $('<div class="stdiff-macros-form__row stdiff-macros-form__row--split"></div>');
    const $duplicateToggle = $('<label class="stdiff-macros-switch"></label>')
        .append(
            $('<input type="checkbox">')
                .prop('checked', group.allowDuplicate !== false),
        )
        .append('<span>允许重复抽取</span>');
    const $sortSelect = $('<select class="select stdiff-macros-form__control stdiff-macros-form__control--compact"></select>');
    SORT_OPTIONS.forEach((opt) => {
        $sortSelect.append(
            $('<option></option>')
                .val(opt.value)
                .text(opt.label),
        );
    });
    $sortSelect.val(group.sortMode ?? 'none');
    const $sortLabel = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">排序策略</label>');

    $optionsRow.append($duplicateToggle, $sortLabel, $sortSelect);

    /* ---------------------------- 候选列表 ---------------------------- */

    const $listHeader = $('<div class="stdiff-macros-list__header"></div>').append('<strong>候选条目</strong>');
    const $addOptionBtn = $('<button type="button" class="menu_button stdiff-macros__add-entry"><i class="fa-solid fa-circle-plus"></i><span>添加选项</span></button>');
    $listHeader.append($addOptionBtn);

    const $list = $('<div class="stdiff-macros__list"></div>');

    /* ---------------------------- 预览区域 ---------------------------- */

    const $previewHeader = $('<div class="stdiff-macros-preview__header"></div>').append('<strong>预览</strong>');
    const $preview = $('<div class="stdiff-macros__preview stdiff-macros__preview--idle">使用工具栏预览按钮查看示例输出。</div>');

    $form.append($groupRow, $idRow, $nameRow, $descRow, $rangeRow, $joinRow, $prefixRow, $dedupeRow, $renumberRow, $optionsRow);
    $container.append($form, $listHeader, $list, $previewHeader, $preview);
    cleanupStack.push(() => {
        $form.remove();
        $listHeader.remove();
        $list.remove();
        $previewHeader.remove();
        $preview.remove();
    });

    const rebuildGroupSelectOptions = (selectedId = state.cascade.activeGroupId) => {
        const previousScroll = $groupSelect.scrollTop();
        const previousValue = $groupSelect.val();

        $groupSelect.empty();
        Object.values(state.cascade.groups).forEach((item) => {
            $groupSelect.append(
                $('<option></option>')
                    .val(item.id)
                    .text(item.label || item.id),
            );
        });

        if (selectedId && state.cascade.groups[selectedId]) {
            $groupSelect.val(selectedId);
        } else if ($groupSelect.children().length > 0) {
            $groupSelect.prop('selectedIndex', 0);
        } else {
            $groupSelect.val('');
        }

        if (previousValue && !$groupSelect.val()) {
            $groupSelect.val(previousValue);
        }

        $groupSelect.scrollTop(previousScroll);
    };

    const markPreviewDirty = () => {
        $preview
            .removeClass('is-loading is-error is-success')
            .addClass('stdiff-macros__preview--idle')
            .text('配置已更新，点击工具栏「预览结果」查看示例。');
    };

    const refreshPanelView = (options = {}) => {
        const { rebuildOptions = true } = options;

        refreshActiveGroup();
        group = getActiveGroup();
        if (!group) {
            requestRefresh();
            return;
        }

        rebuildGroupSelectOptions(group.id);
        $idInput.val(group.id);
        $nameInput.val(group.label ?? '');
        $descInput.val(group.description ?? '');
        $minInput.val(group.range?.min ?? 0);
        $maxInput.val(group.range?.max ?? 0);
        $joinInput.val(group.joiner ?? '\n');
        $prefixInput.val(group.prefix ?? '');
        $dedupeToggle.find('input').prop('checked', group.dedupePrefix !== false);
        $duplicateToggle.find('input').prop('checked', group.allowDuplicate !== false);
        $sortSelect.val(group.sortMode ?? 'none');

        const renumberEnabled = state?.cascade?.renumber?.enabled !== false;
        $renumberToggle.find('input').prop('checked', renumberEnabled);
        $renumberInput.val(state?.cascade?.renumber?.tagName ?? 'framework');
        $renumberInput.prop('disabled', !renumberEnabled);

        if (rebuildOptions) {
            renderOptionRows();
        }

        markPreviewDirty();
        updateGroupbarIndex();
    };

    bindForm();
    refreshPanelView({ rebuildOptions: true });

    /* -------------------------------------------------------------------------- */
    /*                                   Helpers                                  */
    /* -------------------------------------------------------------------------- */

    function handleError(error, fallbackMessage = '操作失败') {
        if (error instanceof MacroStateError) {
            notify(ctx, error.message || fallbackMessage, 'error');
        } else if (error) {
            notify(ctx, fallbackMessage, 'error');
            console.warn(TAG, error);
        } else {
            notify(ctx, fallbackMessage, 'error');
        }
    }

    function refreshActiveGroup() {
        group = getActiveGroup();
    }

    function cloneGroup(source) {
        return JSON.parse(JSON.stringify(source));
    }

    function commitGroup(mutator, options = {}) {
        const { rebuildOptions = true } = options;
        const current = getActiveGroup();
        if (!current) return;
        const draft = cloneGroup(current);
        const result = typeof mutator === 'function' ? mutator(draft) : null;
        const next = result || draft;
        try {
            setGroup(ctx, state, MACRO_KEYS.CASCADE, next);
            refreshActiveGroup();
            refreshPanelView({ rebuildOptions });
            requestSave();
        } catch (error) {
            handleError(error);
            requestRefresh();
        }
    }

    function updateOption(optionId, updater) {
        commitGroup((draft) => {
            draft.options = draft.options.map((item) => {
                if (item.id !== optionId) return item;
                const updated = typeof updater === 'function' ? updater({ ...item }) : { ...item, ...updater };
                updated.id = item.id;
                return updated;
            });
        }, { rebuildOptions: false });
        markPreviewDirty();
    }

    function removeOption(optionId) {
        const current = getActiveGroup();
        if (!current) return;
        if (current.options.length <= 1) {
            notify(ctx, '至少需要保留一个候选选项。', 'warning');
            return;
        }
        commitGroup((draft) => {
            draft.options = draft.options.filter((item) => item.id !== optionId);
        }, { rebuildOptions: true });
        markPreviewDirty();
    }

    function addOption() {
        const newOption = createDefaultCascadeOption(`条目 ${group.options.length + 1}`, 1);
        commitGroup((draft) => {
            draft.options.push(newOption);
        }, { rebuildOptions: true });
        markPreviewDirty();
        scrollIntoView($list, { behavior: 'smooth', block: 'end' });
    }

    function handleCreateGroup() {
        const id = generateUniqueGroupId();
        const template = createDefaultCascadeGroup(id);
        // 给出酒馆风格提示
        try {
            setGroup(ctx, state, MACRO_KEYS.CASCADE, template);
            state.cascade.activeGroupId = template.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildOptions: true });
            requestRefresh();
            notify(ctx, `已创建 Cascade宏 组「${template.label}」`, 'success');
        } catch (error) {
            handleError(error, '创建 Cascade宏 组失败');
        }
    }

    function handleDuplicateGroup() {
        const source = getActiveGroup();
        if (!source) {
            notify(ctx, '没有可复制的宏组。', 'warning');
            return;
        }
        const clone = cloneGroup(source);
        clone.id = generateUniqueGroupId(source.id);
        clone.label = generateUniqueLabel(`${source.label || source.id} 副本`);
        clone.options = clone.options.map((item) => ({
            ...item,
            id: generateId('cascade-option'),
        }));
        try {
            setGroup(ctx, state, MACRO_KEYS.CASCADE, clone);
            state.cascade.activeGroupId = clone.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildOptions: true });
            requestRefresh();
            notify(ctx, `已复制 Cascade宏 组为「${clone.label}」`, 'success');
        } catch (error) {
            handleError(error, '复制 Cascade宏 组失败');
        }
    }

    function handleDeleteGroup() {
        const target = getActiveGroup();
        if (!target) {
            notify(ctx, '没有可删除的宏组。', 'warning');
            return;
        }
        // 删除使使用酒馆风格弹窗提示
        try {
            deleteGroup(ctx, state, MACRO_KEYS.CASCADE, target.id);
            saveMacrosState(ctx);
            refreshPanelView({ rebuildOptions: true });
            requestRefresh();
            notify(ctx, '已删除 Cascade宏 组。', 'success');
        } catch (error) {
            handleError(error, '删除失败');
        }
    }

    function handleImport() {
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
                    const json = JSON.parse(text);
                    importModule(ctx, state, MACRO_KEYS.CASCADE, json);
                    saveMacrosState(ctx);
                    refreshPanelView({ rebuildOptions: true });
                    requestRefresh();
                    notify(ctx, '已从文件导入 Cascade宏 配置。', 'success');
                } catch (error) {
                    handleError(error, '导入失败');
                } finally {
                    input.remove();
                }
            };
            reader.readAsText(file, 'utf-8');
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    }

    async function handleExport() {
        try {
            const snapshot = exportModule(state, MACRO_KEYS.CASCADE);
            const json = JSON.stringify(snapshot, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const safeId = (state?.cascade?.activeGroupId || 'cascade').replace(/[\\/:*?"<>|]/g, '_');
            const a = document.createElement('a');
            a.href = url;
            a.download = `ST-Diff-cascade-${safeId}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            notify(ctx, '已导出 Cascade宏 配置文件。', 'info');
        } catch (error) {
            handleError(error, '导出失败');
        }
    }

    async function runPreview() {
        const active = getActiveGroup();
        if (!active) {
            notify(ctx, '请选择要预览的宏组。', 'warning');
            return;
        }
        $preview.removeClass('is-error is-success').addClass('is-loading').text('正在生成预览……');
        try {
            const result = await executeCascade({
                ctx,
                state,
                evaluator,
                inlineArgs: null,
                groupId: active.id,
                fallback: '',
                depth: 0,
                environment: {},
            });
            const output = typeof result === 'string' && result.trim() ? result : '(空结果)';
            $preview
                .removeClass('is-loading')
                .addClass('is-success')
                .text(output);
        } catch (error) {
            $preview
                .removeClass('is-loading is-success')
                .addClass('is-error')
                .text('预览失败，请检查日志。');
            handleError(error, '预览失败');
        }
    }

    function generateUniqueGroupId(base = 'cascadeGroup') {
        let suffix = '';
        let attempts = 0;
        let candidate;
        do {
            candidate = `${base}${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '');
            if (!candidate || state.cascade.groups[candidate]) {
                suffix = `_${++attempts}`;
                candidate = null;
            }
        } while (!candidate || state.cascade.groups[candidate]);
        return candidate;
    }

    function generateUniqueLabel(base) {
        let candidate = base;
        let index = 2;
        const existingLabels = new Set(Object.values(state.cascade.groups).map((item) => item.label));
        while (existingLabels.has(candidate)) {
            candidate = `${base} ${index++}`;
        }
        return candidate;
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Bindings                                   */
    /* -------------------------------------------------------------------------- */

    function bindForm() {
        // 绑定“调用名(ID)”重命名
        const idNs = '.stdiffMacrosCascadeId';
        const commitRename = () => {
            const raw = String($idInput.val() ?? '').trim();
            if (!raw) {
                setFieldError($idInput, 'ID 不能为空');
                return;
            }
            if (raw === group.id) {
                clearFieldError($idInput);
                return;
            }
            try {
                renameGroup(ctx, state, MACRO_KEYS.CASCADE, group.id, raw);
                clearFieldError($idInput);
                rebuildGroupSelectOptions(raw);
                $groupSelect.val(raw);
                saveMacrosState(ctx);
                requestSave();
                refreshPanelView({ rebuildOptions: true });
                requestRefresh();
                notify(ctx, `已将调用名改为「${raw}」。模板请用 {{cascade_${raw}}}`, 'success');
            } catch (error) {
                setFieldError($idInput, error?.message || '重命名失败');
                $idInput.val(group.id);
                notify(ctx, error?.message || '重命名失败', 'error');
                console.warn(TAG, error);
            }
        };
        $idInput
            .off(idNs)
            .on(`blur${idNs}`, commitRename)
            .on(`keydown${idNs}`, (e) => {
                if (e.key === 'Enter' && !(e.ctrlKey || e.shiftKey)) {
                    e.preventDefault();
                    commitRename();
                    e.currentTarget.blur();
                }
            })
            .on(`input${idNs}`, () => clearFieldError($idInput));

        const detachName = bindTextInput($nameInput, {
            trim: true,
            onCommit: (value) => {
                clearFieldError($nameInput);
                commitGroup((draft) => {
                    draft.label = value || draft.id;
                });
            },
        });
        cleanupStack.push(detachName);

        const detachDesc = bindAutoResize($descInput, { maxHeight: 480 });
        cleanupStack.push(detachDesc);

        const descNs = '.stdiffMacrosCascadeDesc';
        $descInput
            .off(descNs)
            .on(`blur${descNs}`, () => {
                commitGroup((draft) => {
                    draft.description = String($descInput.val() ?? '');
                });
            })
            .on(`input${descNs}`, () => clearFieldError($descInput));
        cleanupStack.push(() => $descInput.off(descNs));

        const rangeNs = '.stdiffMacrosCascadeRange';
        const commitRange = () => {
            const min = clampInteger($minInput.val(), { min: 0, max: 500 });
            const max = clampInteger($maxInput.val(), { min: 0, max: 500 });
            if (min === null || max === null) {
                setFieldError($minInput, '请输入 0-500 的整数');
                setFieldError($maxInput, '请输入 0-500 的整数');
                return;
            }
            if (min > max) {
                setFieldError($minInput, '最小值不能大于最大值');
                return;
            }
            clearFieldError($minInput);
            clearFieldError($maxInput);
            commitGroup((draft) => {
                draft.range = { min, max };
            });
        };
        $minInput
            .off(rangeNs)
            .on(`change${rangeNs} blur${rangeNs}`, commitRange)
            .on(`input${rangeNs}`, () => clearFieldError($minInput));
        $maxInput
            .off(rangeNs)
            .on(`change${rangeNs} blur${rangeNs}`, commitRange)
            .on(`input${rangeNs}`, () => clearFieldError($maxInput));
        cleanupStack.push(() => {
            $minInput.off(rangeNs);
            $maxInput.off(rangeNs);
        });

        const detachJoinerResize = bindAutoResize($joinInput, { maxHeight: 240 });
        cleanupStack.push(detachJoinerResize);
        const joinNs = '.stdiffMacrosCascadeJoiner';
        $joinInput
            .off(joinNs)
            .on(`blur${joinNs}`, () => {
                commitGroup((draft) => {
                    draft.joiner = String($joinInput.val() ?? '\n');
                });
            });
        cleanupStack.push(() => $joinInput.off(joinNs));

        // 绑定“前缀”输入
        const prefixNs = '.stdiffMacrosCascadePrefix';
        $prefixInput
            .off(prefixNs)
            .on(`blur${prefixNs}`, () => {
                commitGroup((draft) => {
                    draft.prefix = String($prefixInput.val() ?? '');
                });
            })
            .on(`keydown${prefixNs}`, (e) => {
                if (e.key === 'Enter' && !(e.ctrlKey || e.shiftKey)) {
                    e.preventDefault();
                    commitGroup((draft) => {
                        draft.prefix = String($prefixInput.val() ?? '');
                    });
                    e.currentTarget.blur();
                }
            })
            .on(`input${prefixNs}`, () => clearFieldError($prefixInput));
        cleanupStack.push(() => $prefixInput.off(prefixNs));

        const detachDedupeToggle = bindToggle($dedupeToggle.find('input'), {
            onChange: (value) => {
                commitGroup((draft) => {
                    draft.dedupePrefix = value === true;
                });
            },
        });
        cleanupStack.push(detachDedupeToggle);

        const renumberToggleDetach = bindToggle($renumberToggle.find('input'), {
            onChange: (value) => {
                state.cascade.renumber ||= {};
                state.cascade.renumber.enabled = value === true;
                saveMacrosState(ctx);
                requestSave();

                $renumberInput.prop('disabled', state.cascade.renumber.enabled !== true);
            },
        });
        cleanupStack.push(renumberToggleDetach);

        const renumberNs = '.stdiffMacrosCascadeRenumber';
        const commitRenumberTag = () => {
            const value = String($renumberInput.val() ?? '').trim() || 'framework';
            state.cascade.renumber ||= {};
            state.cascade.renumber.tagName = value;
            saveMacrosState(ctx);
            requestSave();
            $renumberInput.val(value);
        };
        $renumberInput
            .off(renumberNs)
            .on(`blur${renumberNs}`, commitRenumberTag)
            .on(`keydown${renumberNs}`, (e) => {
                if (e.key === 'Enter' && !(e.ctrlKey || e.shiftKey)) {
                    e.preventDefault();
                    commitRenumberTag();
                    e.currentTarget.blur();
                }
            });
        cleanupStack.push(() => $renumberInput.off(renumberNs));

        const detachDuplicateToggle = bindToggle($duplicateToggle.find('input'), {
            onChange: (value) => {
                commitGroup((draft) => {
                    draft.allowDuplicate = value === true;
                });
            },
        });
        cleanupStack.push(detachDuplicateToggle);

        const sortNs = '.stdiffMacrosCascadeSort';
        $sortSelect
            .off(sortNs)
            .on(`change${sortNs}`, (event) => {
                const value = String($(event.currentTarget).val());
                if (!SORT_OPTIONS.some((opt) => opt.value === value)) {
                    setFieldError($sortSelect, '不支持的排序策略');
                    return;
                }
                clearFieldError($sortSelect);
                commitGroup((draft) => {
                    draft.sortMode = value;
                });
            });
        cleanupStack.push(() => $sortSelect.off(sortNs));

        const groupSelectNs = '.stdiffMacrosCascadeGroupSelect';
        $groupSelect
            .off(groupSelectNs)
            .on(`change${groupSelectNs}`, (event) => {
                const nextId = String($(event.currentTarget).val());
                if (!nextId || !state.cascade.groups[nextId]) {
                    setFieldError($groupSelect, '选择的宏组不存在');
                    return;
                }
                if (state.cascade.activeGroupId === nextId) return;
                state.cascade.activeGroupId = nextId;
                clearFieldError($groupSelect);
                saveMacrosState(ctx);
                requestSave();
                refreshPanelView({ rebuildOptions: true });
            });
        cleanupStack.push(() => $groupSelect.off(groupSelectNs));

        const addNs = '.stdiffMacrosCascadeAddOption';
        $addOptionBtn
            .off(addNs)
            .on(`click${addNs}`, (event) => {
                event.preventDefault();
                addOption();
            });
        cleanupStack.push(() => $addOptionBtn.off(addNs));
    }

    function renderOptionRows() {
        $list.empty();
        group.options.forEach((option) => {
            const { $row, refs } = createListRow(option, {
                allowToggle: true,
                allowWeight: true,
                multiline: true,
                draggable: false,
                placeholderLabel: '选项标签（可选）',
                placeholderValue: '输出内容或宏表达式',
                weightOptions: { min: 0, max: 1_000_000, step: 0.01, precision: 4 },
            });

            const detachWeight = bindWeightInput(refs.weight, {
                min: 0,
                max: 1_000_000,
                precision: 4,
                onCommit: (value) => updateOption(option.id, { weight: value }),
            });
            cleanupStack.push(detachWeight);

            const detachLabel = bindTextInput(refs.label, {
                trim: true,
                onCommit: (value) => updateOption(option.id, { label: value }),
            });
            cleanupStack.push(detachLabel);

            const detachValueResize = bindAutoResize(refs.value, { maxHeight: 600 });
            cleanupStack.push(detachValueResize);

            const valueNs = `.stdiffMacrosCascadeValue-${option.id}`;
            refs.value
                .off(valueNs)
                .on(`blur${valueNs}`, () => {
                    updateOption(option.id, { value: String(refs.value.val() ?? '') });
                })
                .on(`input${valueNs}`, () => clearFieldError(refs.value));
            cleanupStack.push(() => refs.value.off(valueNs));

            const detachToggle = bindToggle(refs.enabled.find('input'), {
                onChange: (value) => updateOption(option.id, { enabled: value }),
            });
            cleanupStack.push(detachToggle);

            const detachDelete = bindDeleteButton(refs.delete, {
                message: '确定删除该选项？',
                onConfirm: () => removeOption(option.id),
            });
            cleanupStack.push(detachDelete);

            $list.append($row);
        });

        if (!group.options.length) {
            $list.append('<div class="stdiff-macros-empty">暂无选项，请点击「添加选项」。</div>');
        }
    }

    return () => {
        cleanupStack.forEach((fn) => {
            if (typeof fn === 'function') {
                try {
                    fn();
                } catch (error) {
                    console.warn(TAG, '清理失败', error);
                }
            }
        });
    };
}

function clampInteger(rawValue, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return null;
    }

    const parsed = Number.parseInt(
        typeof rawValue === 'number' ? rawValue : String(rawValue).trim(),
        10,
    );

    if (!Number.isFinite(parsed)) {
        return null;
    }

    const clamped = Math.min(Math.max(parsed, min), max);
    return clamped;
}