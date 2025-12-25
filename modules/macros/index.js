import { ensureMacrosState, saveMacrosState } from './state/manager.js';
import { registerMacros, unregisterMacros } from './runtime/index.js';
import { mountPromptPostProcessor } from './runtime/promptPostProcessor.js';
import { mountMacrosUI, unmountMacrosUI } from './ui/index.js';

/**
 * @typedef {ReturnType<typeof ensureMacrosState>} MacrosState
 */

/** @type {MacrosState | null} */
let currentState = null;
/** @type {ReturnType<typeof import('../../index.js')['getCtx']>} */
let currentCtx = null;
/** @type {null | (() => void)} */
let cleanupPromptPost = null;

/**
 * 挂载宏模块：根据模块独立开关（macros.enabled）注册或注销宏，并挂载 UI。
 * 不再同步或代理“启用世界书对比 / 启用 noass”的全局勾选。
 *
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx
 * @returns {Promise<void>}
 */
export async function mount(ctx) {
  currentCtx = ctx;
  currentState = ensureMacrosState(ctx);

  // 按独立开关决定是否注册宏
  try {
    if (currentState?.enabled === true) {
      registerMacros(ctx, {
        getState: () => currentState,
        saveState: () => saveMacrosState(ctx),
      });
    } else {
      unregisterMacros(ctx);
    }
  } catch (error) {
    console.warn('[ST-Diff][macros] 注册/注销宏失败', error);
  }

  // 提示词后处理器（仅影响提示词，不影响聊天显示）
  try {
    if (typeof cleanupPromptPost === 'function') {
      cleanupPromptPost();
      cleanupPromptPost = null;
    }
    cleanupPromptPost = mountPromptPostProcessor(ctx, {
      getState: () => currentState,
    });
  } catch (error) {
    console.warn('[ST-Diff][macros] 提示词后处理器挂载失败', error);
  }

  // 挂载 UI（启用切换逻辑由 Binder 负责）
  try {
    const runtimeHooks = {
      register: () =>
        registerMacros(ctx, {
          getState: () => currentState,
          saveState: () => saveMacrosState(ctx),
        }),
      unregister: () => unregisterMacros(ctx),
    };
    mountMacrosUI(ctx, currentState, runtimeHooks);
  } catch (error) {
    console.warn('[ST-Diff][macros] UI 挂载失败', error);
  }
}

/**
 * 卸载宏模块：注销宏并释放 UI。
 *
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} [ctx]
 * @returns {Promise<void>}
 */
export async function unmount(ctx) {
  try {
    unregisterMacros(ctx ?? currentCtx);
  } catch (error) {
    console.warn('[ST-Diff][macros] 注销宏失败', error);
  }

  try {
    if (typeof cleanupPromptPost === 'function') {
      cleanupPromptPost();
    }
  } catch (error) {
    console.warn('[ST-Diff][macros] 提示词后处理器卸载失败', error);
  } finally {
    cleanupPromptPost = null;
  }

  try {
    unmountMacrosUI();
  } catch (error) {
    console.warn('[ST-Diff][macros] UI 卸载失败', error);
  }

  currentState = null;
  currentCtx = null;
}