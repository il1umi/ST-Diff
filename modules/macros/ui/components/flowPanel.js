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
    createDefaultFlowItem,
    createDefaultFlowGroup,
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
import { execute as executeFlow } from '../../runtime/flow.js';
import { createEvaluator } from '../../runtime/evaluator.js';

const TAG = '[ST-Diff][macros:UI:flow]';

/**
 * 渲染 Flow 宏面板。
 * @param {any} ctx
 * @param {import('../../state/manager.js').MacrosState} state
 * @param {{ $container: JQuery, requestSave: () => void, requestRefresh: () => void }} context
 * @returns {() => void} 清理函数
 */
export function renderFlowPanel(ctx, state, context) {
    const { $container, requestSave, requestRefresh } = context;
    const cleanupStack = [];
    const evaluator = createEvaluator(ctx);

    const getActiveGroup = () => {
        const groupId = state?.flow?.activeGroupId;
        return state?.flow?.groups?.[groupId] || null;
    };

    let group = getActiveGroup();

    if (!group) {
        const $placeholder = $('<div class="stdiff-macros-empty"></div>')
            .text('未找到 Flow宏 组，请在面板顶部的组导航条新建。');
        $container.append($placeholder);
        return () => $placeholder.remove();
    }

    const unregisterToolbar = registerToolbarHandlers(MACRO_KEYS.FLOW, {
        preview: () => runPreview(),
        openDocs: () => openMacrosDocs(ctx, MACRO_KEYS.FLOW),
    });
    cleanupStack.push(unregisterToolbar);

    const $form = $('<div class="stdiff-macros-form"></div>');

    /* 组导航条（上一组 / 指示 / 下一组 / 新建 / 复制 / 删除） */
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
        const ids = Object.keys(state.flow.groups);
        const idx = Math.max(0, ids.indexOf(state.flow.activeGroupId));
        $indexLabel.text(`${idx + 1} / ${ids.length}`);
        $prevBtn.prop('disabled', ids.length <= 1 || idx <= 0);
        $nextBtn.prop('disabled', ids.length <= 1 || idx >= ids.length - 1);
    };

    const groupbarNs = '.stdiffMacrosGroupbarFlow';
    $prevBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.flow.groups);
        const idx = ids.indexOf(state.flow.activeGroupId);
        if (idx > 0) {
            state.flow.activeGroupId = ids[idx - 1];
            saveMacrosState(ctx);
            requestSave();
            requestRefresh();
        }
    });
    $nextBtn.off(groupbarNs).on(`click${groupbarNs}`, (e) => {
        e.preventDefault();
        const ids = Object.keys(state.flow.groups);
        const idx = ids.indexOf(state.flow.activeGroupId);
        if (idx < ids.length - 1) {
            state.flow.activeGroupId = ids[idx + 1];
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
    Object.values(state.flow.groups).forEach((item) => {
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
        .attr('placeholder', '用于模板调用的标识，如 qxs')
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
    const $minWrapper = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">最小个数</label>');
    const $minInput = $('<input type="number" class="text_pole stdiff-macros-form__control stdiff-macros-form__control--compact">')
        .attr({ min: 0, max: 100, step: 1 })
        .val(group.range?.min ?? 1);
    const $maxWrapper = $('<label class="stdiff-macros-form__label stdiff-macros-form__label--inline">最大个数</label>');
    const $maxInput = $('<input type="number" class="text_pole stdiff-macros-form__control stdiff-macros-form__control--compact">')
        .attr({ min: 0, max: 100, step: 1 })
        .val(group.range?.max ?? 1);
    $rangeRow.append($minWrapper, $minInput, $maxWrapper, $maxInput);

    /* ---------------------------- 拼接与开关 ---------------------------- */

    const $joinerRow = $('<div class="stdiff-macros-form__row"></div>');
    const $joinerLabel = $('<label class="stdiff-macros-form__label">连接符 (Joiner)</label>');
    const $joinerInput = $('<input type="text" class="text_pole stdiff-macros-form__control">')
        .attr('placeholder', '例如 →（默认空）')
        .attr('maxlength', 64)
        .val(group.joiner ?? '');
    $joinerRow.append($joinerLabel, $joinerInput);

    const $flagsRow = $('<div class="stdiff-macros-form__row stdiff-macros-form__row--inline"></div>');
    const $preventToggle = $('<label class="stdiff-macros-switch"></label>')
        .append(
            $('<input type="checkbox">').prop('checked', group.preventRepeat === true),
        )
        .append('<span>禁止连续重复</span>');
    $flagsRow.append($preventToggle);

    /* ---------------------------- 候选列表 ---------------------------- */

    const $listHeader = $('<div class="stdiff-macros-list__header"></div>').append('<strong>候选条目</strong>');
    const $addItemBtn = $('<button type="button" class="menu_button stdiff-macros__add-entry"><i class="fa-solid fa-circle-plus"></i><span>添加条目</span></button>');
    $listHeader.append($addItemBtn);

    const $list = $('<div class="stdiff-macros__list"></div>');

    /* ---------------------------- 预览区域 ---------------------------- */

    const $previewHeader = $('<div class="stdiff-macros-preview__header"></div>').append('<strong>预览</strong>');
    const $preview = $('<div class="stdiff-macros__preview stdiff-macros__preview--idle">点击工具栏「预览结果」以生成示例。</div>');

    $form.append($groupRow, $idRow, $nameRow, $descRow, $rangeRow, $joinerRow, $flagsRow);
    $container.append($form, $listHeader, $list, $previewHeader, $preview);

    cleanupStack.push(() => {
        $form.remove();
        $listHeader.remove();
        $list.remove();
        $previewHeader.remove();
        $preview.remove();
    });

    const rebuildGroupSelectOptions = (selectedId = state.flow.activeGroupId) => {
        const previousScroll = $groupSelect.scrollTop();
        const previousValue = $groupSelect.val();

        $groupSelect.empty();
        Object.values(state.flow.groups).forEach((item) => {
            $groupSelect.append(
                $('<option></option>')
                    .val(item.id)
                    .text(item.label || item.id),
            );
        });

        if (selectedId && state.flow.groups[selectedId]) {
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

    const refreshActiveGroup = () => {
        group = getActiveGroup();
    };

    const refreshPanelView = (options = {}) => {
        const { rebuildItems = true } = options;

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
        $joinerInput.val(group.joiner ?? '');
        $preventToggle.find('input').prop('checked', group.preventRepeat === true);

        if (rebuildItems) {
            renderItemRows();
        }

        markPreviewDirty();
        updateGroupbarIndex();
    };

    bindForm();
    refreshPanelView({ rebuildItems: true });

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

    function cloneGroup(source) {
        return JSON.parse(JSON.stringify(source));
    }

    function commitGroup(mutator, options = {}) {
        const { rebuildItems = true } = options;
        const current = getActiveGroup();
        if (!current) return;

        const draft = cloneGroup(current);
        const result = typeof mutator === 'function' ? mutator(draft) : null;
        const next = result || draft;

        try {
            setGroup(ctx, state, MACRO_KEYS.FLOW, next);
            refreshActiveGroup();
            refreshPanelView({ rebuildItems });
            requestSave();
        } catch (error) {
            handleError(error);
            requestRefresh();
        }
    }

    function updateItem(itemId, updater) {
        commitGroup((draft) => {
            draft.items = draft.items.map((item) => {
                if (item.id !== itemId) return item;
                const updated = typeof updater === 'function' ? updater({ ...item }) : { ...item, ...updater };
                updated.id = item.id;
                return updated;
            });
        }, { rebuildItems: false });
        markPreviewDirty();
    }

    function removeItem(itemId) {
        const current = getActiveGroup();
        if (!current) return;
        if (current.items.length <= 1) {
            notify(ctx, '至少需要保留一个候选条目。', 'warning');
            return;
        }
        commitGroup((draft) => {
            draft.items = draft.items.filter((item) => item.id !== itemId);
        }, { rebuildItems: true });
        markPreviewDirty();
    }

    function addItem() {
        const newItem = createDefaultFlowItem(`条目 ${group.items.length + 1}`, 1);
        commitGroup((draft) => {
            draft.items.push(newItem);
        }, { rebuildItems: true });

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
        const id = generateUniqueGroupId();
        const template = createDefaultFlowGroup(id);
        try {
            setGroup(ctx, state, MACRO_KEYS.FLOW, template);
            state.flow.activeGroupId = template.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildItems: true });
            requestRefresh();
            notify(ctx, `已创建 Flow宏 组「${template.label}」`, 'success');
        } catch (error) {
            handleError(error, '创建 Flow宏 组失败');
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
        clone.items = (clone.items || []).map((item) => ({
            ...item,
            id: generateId('flow-item'),
        }));
        try {
            setGroup(ctx, state, MACRO_KEYS.FLOW, clone);
            state.flow.activeGroupId = clone.id;
            saveMacrosState(ctx);
            refreshPanelView({ rebuildItems: true });
            requestRefresh();
            notify(ctx, `已复制 Flow宏 组为「${clone.label}」`, 'success');
        } catch (error) {
            handleError(error, '复制 Flow宏 组失败');
        }
    }

    function handleDeleteGroup() {
        const target = getActiveGroup();
        if (!target) {
            notify(ctx, '没有可删除的宏组。', 'warning');
            return;
        }
        try {
            deleteGroup(ctx, state, MACRO_KEYS.FLOW, target.id);
            saveMacrosState(ctx);
            refreshPanelView({ rebuildItems: true });
            requestRefresh();
            notify(ctx, '已删除 Flow宏 组。', 'success');
        } catch (error) {
            handleError(error, '删除失败');
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
            const result = await executeFlow({
                ctx,
                state,
                evaluator,
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
                    importModule(ctx, state, MACRO_KEYS.FLOW, json);
                    saveMacrosState(ctx);
                    refreshPanelView({ rebuildItems: true });
                    requestRefresh();
                    notify(ctx, '已从文件导入 Flow宏 配置。', 'success');
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
            const snapshot = exportModule(state, MACRO_KEYS.FLOW);
            const json = JSON.stringify(snapshot, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const safeId = (state?.flow?.activeGroupId || 'flow').replace(/[\\/:*?"<>|]/g, '_');
            const a = document.createElement('a');
            a.href = url;
            a.download = `ST-Diff-flow-${safeId}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            notify(ctx, '已导出 Flow宏 配置文件。', 'info');
        } catch (error) {
            handleError(error, '导出失败');
        }
    }

    function generateUniqueGroupId(base = 'flowGroup') {
        let suffix = '';
        let attempts = 0;
        let candidate;
        do {
            candidate = `${base}${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '');
            if (!candidate || state.flow.groups[candidate]) {
                suffix = `_${++attempts}`;
                candidate = null;
            }
        } while (!candidate || state.flow.groups[candidate]);
        return candidate;
    }

    function generateUniqueLabel(base) {
        let candidate = base;
        let index = 2;
        const existingLabels = new Set(Object.values(state.flow.groups).map((item) => item.label));
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
        const idNs = '.stdiffMacrosFlowId';
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
                renameGroup(ctx, state, MACRO_KEYS.FLOW, group.id, raw);
                clearFieldError($idInput);
                rebuildGroupSelectOptions(raw);
                $groupSelect.val(raw);
                saveMacrosState(ctx);
                requestSave();
                requestRefresh();
                notify(ctx, `已将调用名改为「${raw}」。模板请用 {{flow_${raw}}}`, 'success');
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

        const detachDesc = bindAutoResize($descInput, { maxHeight: 480 });
        cleanupStack.push(detachDesc);

        const descNs = '.stdiffMacrosFlowDesc';
        $descInput
            .off(descNs)
            .on(`blur${descNs}`, () => {
                commitGroup((draft) => {
                    draft.description = String($descInput.val() ?? '');
                });
            })
            .on(`input${descNs}`, () => clearFieldError($descInput));
        cleanupStack.push(() => $descInput.off(descNs));

        const rangeNs = '.stdiffMacrosFlowRange';
        const commitRange = () => {
            const min = clampInteger($minInput.val(), { min: 0, max: 100 });
            const max = clampInteger($maxInput.val(), { min: 0, max: 100 });
            if (min === null || max === null) {
                setFieldError($minInput, '请输入 0-100 的整数');
                setFieldError($maxInput, '请输入 0-100 的整数');
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

        const joinerNs = '.stdiffMacrosFlowJoiner';
        $joinerInput
            .off(joinerNs)
            .on(`blur${joinerNs}`, () => {
                commitGroup((draft) => {
                    draft.joiner = String($joinerInput.val() ?? '');
                });
            })
            .on(`input${joinerNs}`, () => clearFieldError($joinerInput));
        cleanupStack.push(() => $joinerInput.off(joinerNs));

        const detachPreventToggle = bindToggle($preventToggle.find('input'), {
            onChange: (value) => {
                commitGroup((draft) => {
                    draft.preventRepeat = value === true;
                });
            },
        });
        cleanupStack.push(detachPreventToggle);

        const groupSelectNs = '.stdiffMacrosFlowGroupSelect';
        $groupSelect
            .off(groupSelectNs)
            .on(`change${groupSelectNs}`, (event) => {
                const nextId = String($(event.currentTarget).val());
                if (!nextId || !state.flow.groups[nextId]) {
                    setFieldError($groupSelect, '选择的宏组不存在');
                    return;
                }
                if (state.flow.activeGroupId === nextId) return;
                state.flow.activeGroupId = nextId;
                clearFieldError($groupSelect);
                saveMacrosState(ctx);
                requestSave();
                requestRefresh();
            });
        cleanupStack.push(() => $groupSelect.off(groupSelectNs));

        const addNs = '.stdiffMacrosFlowAddItem';
        $addItemBtn
            .off(addNs)
            .on(`click${addNs}`, (event) => {
                event.preventDefault();
                addItem();
                scrollIntoView($list, { behavior: 'smooth', block: 'end' });
            });
        cleanupStack.push(() => $addItemBtn.off(addNs));
    }

    function renderItemRows() {
        $list.empty();
        group.items.forEach((item) => {
            const { $row, refs } = createListRow(item, {
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
                onCommit: (value) => updateItem(item.id, { weight: value }),
            });
            cleanupStack.push(detachWeight);

            const detachLabel = bindTextInput(refs.label, {
                trim: true,
                onCommit: (value) => updateItem(item.id, { label: value }),
            });
            cleanupStack.push(detachLabel);

            const detachValueResize = bindAutoResize(refs.value, { maxHeight: 600 });
            cleanupStack.push(detachValueResize);

            const valueNs = `.stdiffMacrosFlowValue-${item.id}`;
            refs.value
                .off(valueNs)
                .on(`blur${valueNs}`, () => {
                    updateItem(item.id, { value: String(refs.value.val() ?? '') });
                })
                .on(`input${valueNs}`, () => clearFieldError(refs.value));
            cleanupStack.push(() => refs.value.off(valueNs));

            const detachToggle = bindToggle(refs.enabled.find('input'), {
                onChange: (value) => updateItem(item.id, { enabled: value }),
            });
            cleanupStack.push(detachToggle);

            const detachDelete = bindDeleteButton(refs.delete, {
                message: '确定删除该条目？',
                onConfirm: () => removeItem(item.id),
            });
            cleanupStack.push(detachDelete);

            $list.append($row);
        });

        if (!group.items.length) {
            $list.append('<div class="stdiff-macros-empty">暂无条目，请点击「添加条目」。</div>');
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