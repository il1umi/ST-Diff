import { bindUI, unbindUI } from './binder.js';
import { renderToolbar } from './components/shared.js';
import { renderRoulettePanel } from './components/roulettePanel.js';
import { renderCascadePanel } from './components/cascadePanel.js';
import { renderFlowPanel } from './components/flowPanel.js';

/**
 * 挂载宏模块 UI。
 * @param {ReturnType<typeof import('../../../index.js')['getCtx']>} ctx
 * @param {import('../state/manager.js').MacrosState} state
 * @param {{ register?: () => void, unregister?: () => void }} runtimeHooks
 */
export function mountMacrosUI(ctx, state, runtimeHooks = {}) {
  bindUI(ctx, state, {
    renderToolbar,
    renderRoulettePanel,
    renderCascadePanel,
    renderFlowPanel,
    // 传递运行时钩子到Binder，以响应启用/禁用开关
    registerMacros: typeof runtimeHooks.register === 'function' ? runtimeHooks.register : null,
    unregisterMacros: typeof runtimeHooks.unregister === 'function' ? runtimeHooks.unregister : null,
  });
}

/**
 * 卸载宏模块 UI。
 */
export function unmountMacrosUI() {
  unbindUI();
}