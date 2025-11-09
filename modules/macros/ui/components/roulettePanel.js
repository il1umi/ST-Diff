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
} from './shared.js';
import {
    createDefaultRouletteEntry,
    createDefaultRouletteGroup,
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
import { execute as executeRoulette } from '../../runtime/roulette.js';
import { createEvaluator } from '../../runtime/evaluator.js';

const DOC_URL = 'https://docs.sillytavern.app/extensions/st-diff/macros/roulette';
const TAG = '[ST-Diff][macros:UI:roulette]';

/**
 * 渲染Roulette宏 面板。
 * @param {any} ctx
 * @param {import('../../state/manager.js').MacrosState} state
 * @param {{ $container: JQuery, requestSave: () => void, requestRefresh: () => void }} context
 * @returns {() => void} 清理函数
 */
export function renderRoulettePanel(ctx, state, context) {
    const { $container, requestSave, requestRefresh } = context;
    const cleanupStack = [];
    const evaluator = createEvaluator(ctx);

    const getActiveGroup = () => {
        const groupId = state?.roulette?.activeGroupId;
        return state?.roulette?.groups?.[groupId] || null;
    };

    let group = getActiveGroup();

    if (!group) {
        const $empty = $('<div class="stdiff-macros-empty"></div>')
                    .text('未找到 Roulette宏 组，请在面板顶部的组导航条新建。');
        $container.append($empty);
        return () => {
            $empty.remove();
        };
    }

    const unregisterToolbar = registerToolbarHandlers(MACRO_KEYS.ROULETTE, {
        createGroup: () => handleCreateGroup(),
        duplicateGroup: () => handleDuplicateGroup(),
        deleteGroup: () => handleDeleteGroup(),
        importData: () => handleImport(),
        exportData: () => handleExport(),
        preview: () => runPreview(),
        openDocs: () => window.open(DOC_URL, '_blank', 'noopener'),
    });
    cleanupStack.push(unregisterToolbar);

    // 嵌套 .stdiff-macros-pane 会被 CSS 隐藏，改为直接将内容附加到外层容器
    const $form = $('<div class="stdiff-macros-form"></div>');

    /* 组导航（上一组 / 指示 / 下一组 / 新建 / 复制 / 删除） */
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
        const ids = Object.keys(state.roulette.groups);
        const idx = Math.max(0, ids.indexOf(state.roulette.activeGroupId));
        $indexLabel.text(`${idx + 1} / ${ids.length}`);
        $prevBtn.prop('disabled', ids.length <= 1 || idx <= 0);
        $nextBtn.prop('disabled', ids.length <= 1 || idx >= ids.length - 1);
    };

    const groupbarNs = '.stdiffMacrosGroupbarRoulette';
    $prevBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.roulette.groups);
        const idx = ids.indexOf(state.roulette.activeGroupId);
        if (idx > 0) {
            state.roulette.activeGroupId = ids[idx - 1];
            saveMacrosState(ctx);
            requestSave();
            requestRefresh();
        }
    });
    $nextBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.roulette.groups);
        const idx = ids.indexOf(state.roulette.activeGroupId);
        if (idx < ids.length - 1) {
            state.roulette.activeGroupId = ids[idx + 1];
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

    const $groupRow = $('<div class="stdiff-macros-form__row"></div>');
    const $groupLabel = $('<label class="stdiff-macros-form__label">宏组</label>');
    const $groupSelect = $('<select class="select stdiff-macros-form__control"></select>');
    Object.values(state.roulette.groups).forEach((item) => {
        $groupSelect.append(
            $('<option></option>')
                .val(item.id)
                .text(item.label || item.id),
        );
    });
    $groupSelect.val(group.id);
    $groupRow.append($groupLabel).append($groupSelect);

    // 可编辑“调用名(ID)”
    const $idRow = $('<div class="stdiff-macros-form__row"></div>');
    const $idLabel = $('<label class="stdiff-macros-form__label">调用名（ID）</label>');
    const $idInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '用于模板调用的标识，如 myPrize')
        .attr('maxlength', 32)
        .val(group.id);
    $idRow.append($idLabel).append($idInput);

    const $nameRow = $('<div class="stdiff-macros-form__row"></div>');
    const $nameLabel = $('<label class="stdiff-macros-form__label">名称</label>');
    const $nameInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '用于识别的显示名称')
        .val(group.label ?? '');
    $nameRow.append($nameLabel).append($nameInput);

    const $descRow = $('<div class="stdiff-macros-form__row"></div>');
    const $descLabel = $('<label class="stdiff-macros-form__label">描述</label>');
    const $descInput = $('<textarea class="textarea stdiff-macros-form__control" rows="2"></textarea>')
        .attr('placeholder', '可选描述，便于记录来源或用途')
        .val(group.description ?? '');
    $descRow.append($descLabel).append($descInput);

    const $flagRow = $('<div class="stdiff-macros-form__row stdiff-macros-form__row--inline"></div>');
    const $preventToggle = $('<label class="stdiff-macros-switch"></label>').append(
        $('<input type="checkbox">').prop('checked', group.preventRepeat === true),
    ).append('<span>禁止连续重复</span>');
    $flagRow.append($preventToggle);

    const $listHeader = $('<div class="stdiff-macros-list__header"></div>').append('<strong>候选条目</strong>');
    const $addEntryButton = $('<button type="button" class="menu_button stdiff-macros__add-entry"><i class="fa-solid fa-circle-plus"></i><span>添加条目</span></button>');
    $listHeader.append($addEntryButton);

    const $list = $('<div class="stdiff-macros__list"></div>');

    const $previewHeader = $('<div class="stdiff-macros-preview__header"></div>').append('<strong>预览</strong>');
    const $preview = $('<div class="stdiff-macros__preview stdiff-macros__preview--idle" data-role="preview">点击工具栏「预览结果」以生成示例。</div>');

    $form.append($groupRow, $idRow, $nameRow, $descRow, $flagRow);
    $container.append($form, $listHeader, $list, $previewHeader, $preview);

    cleanupStack.push(() => {
        $form.remove();
        $listHeader.remove();
        $list.remove();
        $previewHeader.remove();
        $preview.remove();
    });

    const rebuildGroupSelectOptions = (selectedId = state.roulette.activeGroupId) => {
        const previousScroll = $groupSelect.scrollTop();
        const previousValue = $groupSelect.val();

        $groupSelect.empty();
        Object.values(state.roulette.groups).forEach((item) => {
            $groupSelect.append(
                $('<option></option>')
                    .val(item.id)
                    .text(item.label || item.id),
            );
        });

        if (selectedId && state.roulette.groups[selectedId]) {
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
        const { rebuildEntries = true } = options;

        console.debug(TAG, 'refreshPanelView invoked', {
            rebuildEntries,
            activeGroupId: state?.roulette?.activeGroupId,
            groupKeys: Object.keys(state?.roulette?.groups ?? {}),
        });

        refreshActiveGroup();
        group = getActiveGroup();
        if (!group) {
            console.debug(TAG, 'refreshPanelView fallback: no active group', {
                activeGroupId: state?.roulette?.activeGroupId,
            });
            requestRefresh();
            return;
        }

        rebuildGroupSelectOptions(group.id);
        console.debug(TAG, 'refreshPanelView binding data', {
            groupId: group.id,
            entryCount: group.entries?.length ?? 0,
        });
        $idInput.val(group.id);
        $nameInput.val(group.label ?? '');
        $descInput.val(group.description ?? '');
        $preventToggle.find('input').prop('checked', group.preventRepeat === true);

        if (rebuildEntries) {
            renderEntryRows();
        }

        markPreviewDirty();
        // 统一与Cascade行为：刷新后同步组索引与上一/下一禁用态
        updateGroupbarIndex();
    };

    bindForm();
    refreshPanelView({ rebuildEntries: true });

    /* --------------------------------- Helpers -------------------------------- */

    function handleError(error, defaultMessage = '操作失败') {
        if (error instanceof MacroStateError) {
            notify(ctx, error.message || defaultMessage, 'error');
        } else if (error) {
            notify(ctx, defaultMessage, 'error');
            console.warn(TAG, error);
        } else {
            notify(ctx, defaultMessage, 'error');
        }
    }

    function refreshActiveGroup() {
        const previousId = group?.id;
        group = getActiveGroup();
        console.debug(TAG, 'refreshActiveGroup', {
            previousId,
            nextId: group?.id,
            activeGroupId: state?.roulette?.activeGroupId,
            groupKeys: Object.keys(state?.roulette?.groups ?? {}),
        });
    }

    function cloneGroup(source) {
        return JSON.parse(JSON.stringify(source));
    }

    function commitGroup(transform, options = {}) {
        const { rebuildEntries = true } = options;
        const current = getActiveGroup();
        if (!current) {
            console.debug(TAG, 'commitGroup skipped: no active group', { rebuildEntries });
            return;
        }

        console.debug(TAG, 'commitGroup start', {
            rebuildEntries,
            currentId: current.id,
            activeGroupId: state?.roulette?.activeGroupId,
            entryCount: current.entries?.length ?? 0,
        });

        const draft = cloneGroup(current);
        const next = transform(draft) || draft;

        try {
            setGroup(ctx, state, MACRO_KEYS.ROULETTE, next);
            refreshActiveGroup();
            refreshPanelView({ rebuildEntries });
            requestSave();
            console.debug(TAG, 'commitGroup complete', {
                nextId: next.id,
                rebuildEntries,
                activeGroupId: state?.roulette?.activeGroupId,
            });
        } catch (error) {
            console.debug(TAG, 'commitGroup error', { nextId: next.id, message: error?.message });
            handleError(error);
            requestRefresh();
        }
    }

    function updateEntry(entryId, updater) {
        commitGroup((draft) => {
            draft.entries = draft.entries.map((item) => {
                if (item.id !== entryId) return item;
                const updated = typeof updater === 'function' ? updater({ ...item }) : { ...item, ...updater };
                updated.id = item.id;
                return updated;
            });
        }, { rebuildEntries: false });
        markPreviewDirty();
    }

    function removeEntry(entryId) {
        const current = getActiveGroup();
        if (!current) return;
        if (current.entries.length <= 1) {
            notify(ctx, '至少需要保留一个候选条目。', 'warning');
            return;
        }
        commitGroup((draft) => {
            draft.entries = draft.entries.filter((item) => item.id !== entryId);
        }, { rebuildEntries: true });
        markPreviewDirty();
    }

    function addEntry() {
        const newEntry = createDefaultRouletteEntry(`条目 ${group.entries.length + 1}`, 1);
        commitGroup((draft) => {
            draft.entries.push(newEntry);
        }, { rebuildEntries: true });

        markPreviewDirty();

        requestAnimationFrame(() => {
            const $lastRow = $list.children('.stdiff-macros__row').last();
            if ($lastRow.length) {
                scrollIntoView($lastRow, { behavior: 'smooth', block: 'end' });
            } else {
                scrollIntoView($list, { behavior: 'smooth', block: 'end' });
            }
        });
    }

    function handleCreateGroup() {
        const newId = generateUniqueGroupId();
        const template = createDefaultRouletteGroup(newId);
        console.debug(TAG, 'handleCreateGroup start', {
            proposedId: newId,
            currentActive: state?.roulette?.activeGroupId,
            existingIds: Object.keys(state?.roulette?.groups ?? {}),
        });
        // 采用默认标签；创建后以酒馆风格提示
        try {
            setGroup(ctx, state, MACRO_KEYS.ROULETTE, template);
            state.roulette.activeGroupId = template.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildEntries: true });
            requestRefresh();
            notify(ctx, `已创建 Roulette宏 组「${template.label}」`, 'success');
            console.debug(TAG, 'handleCreateGroup success', {
                newId: template.id,
                label: template.label,
                activeGroupId: state?.roulette?.activeGroupId,
                keys: Object.keys(state?.roulette?.groups ?? {}),
            });
        } catch (error) {
            console.debug(TAG, 'handleCreateGroup error', {
                attemptedId: template.id,
                message: error?.message,
            });
            handleError(error, '创建 Roulette宏 组失败');
        }
    }

    function handleDuplicateGroup() {
        const source = getActiveGroup();
        if (!source) {
            notify(ctx, '没有可复制的宏组。', 'warning');
            return;
        }
        const dup = cloneGroup(source);
        dup.id = generateUniqueGroupId(source.id);
        dup.label = generateUniqueLabel(`${source.label || source.id} 副本`);
        dup.entries = dup.entries.map((entry) => ({
            ...entry,
            id: generateId('roulette-entry'),
        }));
        try {
            setGroup(ctx, state, MACRO_KEYS.ROULETTE, dup);
            state.roulette.activeGroupId = dup.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildEntries: true });
            requestRefresh();
            notify(ctx, `已复制 Roulette宏 组为「${dup.label}」`, 'success');
        } catch (error) {
            handleError(error, '复制失败');
        }
    }

    function handleDeleteGroup() {
        const target = getActiveGroup();
        if (!target) {
            notify(ctx, '没有可删除的宏组。', 'warning');
            return;
        }
        // 删除时使用酒馆提示
        try {
            deleteGroup(ctx, state, MACRO_KEYS.ROULETTE, target.id);
            saveMacrosState(ctx);
            refreshPanelView({ rebuildEntries: true });
            requestRefresh();
            notify(ctx, '已删除 Roulette宏 组。', 'success');
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
                    importModule(ctx, state, MACRO_KEYS.ROULETTE, json);
                    saveMacrosState(ctx);
                    refreshPanelView({ rebuildEntries: true });
                    requestRefresh();
                    notify(ctx, '已从文件导入 Roulette宏 配置。', 'success');
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
            const snapshot = exportModule(state, MACRO_KEYS.ROULETTE);
            const json = JSON.stringify(snapshot, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const safeId = (state?.roulette?.activeGroupId || 'roulette').replace(/[\\/:*?"<>|]/g, '_');
            const a = document.createElement('a');
            a.href = url;
            a.download = `ST-Diff-roulette-${safeId}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            notify(ctx, '已导出 Roulette宏 配置文件。', 'info');
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
        $preview
            .removeClass('stdiff-macros__preview--idle is-error is-success')
            .addClass('is-loading')
            .text('正在生成预览……');
        try {
            const result = await executeRoulette({
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
                .removeClass('is-loading stdiff-macros__preview--idle')
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

    function generateUniqueGroupId(base = 'rouletteGroup') {
        let suffix = '';
        let attempts = 0;
        let candidate;
        do {
            candidate = `${base}${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '');
            if (!candidate || state.roulette.groups[candidate]) {
                suffix = `_${++attempts}`;
                candidate = null;
            }
        } while (!candidate || state.roulette.groups[candidate]);
        return candidate;
    }

    function generateUniqueLabel(base) {
        let candidate = base;
        let index = 2;
        const existingLabels = new Set(Object.values(state.roulette.groups).map((item) => item.label));
        while (existingLabels.has(candidate)) {
            candidate = `${base} ${index++}`;
        }
        return candidate;
    }

    /* --------------------------------- Form Bindings -------------------------------- */

    function bindForm() {
        // 绑定“调用名(ID)”重命名
        const idNs = '.stdiffMacrosId';
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
                renameGroup(ctx, state, MACRO_KEYS.ROULETTE, group.id, raw);
                clearFieldError($idInput);
                // 刷新下拉与活动组
                rebuildGroupSelectOptions(raw);
                $groupSelect.val(raw);
                saveMacrosState(ctx);
                requestSave();
                requestRefresh();
                notify(ctx, `已将调用名改为「${raw}」。模板请用 {{roulette_${raw}}}`, 'success');
            } catch (error) {
                setFieldError($idInput, error?.message || '重命名失败');
                $idInput.val(group.id);
                handleError(error, '重命名失败');
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
        cleanupStack.push(() => $idInput.off(idNs));

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

        const detachDescResize = bindAutoResize($descInput, { maxHeight: 480 });
        cleanupStack.push(detachDescResize);

        const descNs = '.stdiffMacrosDesc';
        $descInput
            .off(descNs)
            .on(`blur${descNs}`, () => {
                commitGroup((draft) => {
                    draft.description = String($descInput.val() ?? '');
                });
            })
            .on(`input${descNs}`, () => {
                clearFieldError($descInput);
            });
        cleanupStack.push(() => $descInput.off(descNs));

        const detachPrevent = bindToggle($preventToggle.find('input'), {
            onChange: (value) => {
                commitGroup((draft) => {
                    draft.preventRepeat = value === true;
                });
            },
        });
        cleanupStack.push(detachPrevent);

        const selectNs = '.stdiffMacrosGroupSelect';
        $groupSelect
            .off(selectNs)
            .on(`change${selectNs}`, (event) => {
                const nextId = String($(event.currentTarget).val());
                if (!nextId || !state.roulette.groups[nextId]) {
                    setFieldError($groupSelect, '选择的宏组不存在');
                    return;
                }
                if (state.roulette.activeGroupId === nextId) return;
                state.roulette.activeGroupId = nextId;
                clearFieldError($groupSelect);
                saveMacrosState(ctx);
                requestSave();
                requestRefresh();
            });
        cleanupStack.push(() => $groupSelect.off(selectNs));

        const addNs = '.stdiffMacrosAddEntry';
        $addEntryButton
            .off(addNs)
            .on(`click${addNs}`, (event) => {
                event.preventDefault();
                addEntry();
                scrollIntoView($list, { behavior: 'smooth', block: 'end' });
            });
        cleanupStack.push(() => $addEntryButton.off(addNs));
    }

    function renderEntryRows() {
        $list.empty();
        group.entries.forEach((entry) => {
            const { $row, refs } = createListRow(entry, {
                allowToggle: true,
                allowWeight: true,
                multiline: true,
                draggable: false,
                placeholderLabel: '条目标签（可选，用于列表识别）',
                placeholderValue: '输出内容或宏表达式',
                weightOptions: { min: 0, max: 1_000_000, step: 0.01, precision: 4 },
            });

            const detachWeight = bindWeightInput(refs.weight, {
                min: 0,
                max: 1_000_000,
                precision: 4,
                onCommit: (value) => updateEntry(entry.id, { weight: value }),
            });
            cleanupStack.push(detachWeight);

            const detachLabel = bindTextInput(refs.label, {
                trim: true,
                onCommit: (value) => updateEntry(entry.id, { label: value }),
            });
            cleanupStack.push(detachLabel);

            const detachValueResize = bindAutoResize(refs.value, { maxHeight: 600 });
            cleanupStack.push(detachValueResize);

            const valueNs = `.stdiffMacrosValue-${entry.id}`;
            refs.value
                .off(valueNs)
                .on(`blur${valueNs}`, () => {
                    updateEntry(entry.id, { value: String(refs.value.val() ?? '') });
                })
                .on(`input${valueNs}`, () => clearFieldError(refs.value));
            cleanupStack.push(() => refs.value.off(valueNs));

            const detachToggle = bindToggle(refs.enabled.find('input'), {
                onChange: (val) => updateEntry(entry.id, { enabled: val }),
            });
            cleanupStack.push(detachToggle);

            const detachDelete = bindDeleteButton(refs.delete, {
                message: '确定删除该条目？',
                onConfirm: () => removeEntry(entry.id),
            });
            cleanupStack.push(detachDelete);

            $list.append($row);
        });

        if (!group.entries.length) {
            $list.append('<div class="stdiff-macros-empty">暂无条目，请点击「添加条目」。</div>');
        }
    }

    return () => {
        cleanupStack.forEach((fn) => {
            if (typeof fn === 'function') {
                try { fn(); } catch (error) { console.warn(TAG, '清理失败', error); }
            }
        });
    };
}