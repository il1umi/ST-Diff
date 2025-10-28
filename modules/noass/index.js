import { ensureState } from './state/state.js';
import { bindUI, unbindUI } from './ui/binder.js';
import { registerCompletion, unregisterCompletion } from './runtime/completion.js';
import {
  initWorldbook,
  teardownWorldbook,
  exportWorldbookSnapshot,
  subscribeWorldbookSnapshot,
  unsubscribeWorldbookSnapshot,
  resetWorldbookCache,
  setWorldbookLogAdapter,
  warnWorldbookIssue,
  debugWorldbookLog,
} from './runtime/wibridge/index.js';
import { setRefreshStoredDataView, runWorldbookDryRun } from './runtime/mergeBlock.js';

let currentCtx = null;
let currentState = null;
let refreshStoredDataView = null;

/**
 * 清空当前挂载周期内的钩子引用，避免重复 mount 时出现状态残留。
 */
function resetRuntimeHooks() {
  refreshStoredDataView = null;
  setRefreshStoredDataView(null);
  setWorldbookLogAdapter({ append: null, reset: null });
}

/**
 * 初始化 noass 模块：构建 UI、注册 completion 监听并接入世界书运行时。
 *
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx SillyTavern 扩展上下文
 * @returns {Promise<void>}
 */
export async function mount(ctx) {
  currentCtx = ctx;
  currentState = ensureState(ctx);

  const binderDeps = {
    setRefreshStoredDataView: (fn) => {
      refreshStoredDataView = typeof fn === 'function' ? fn : null;
      setRefreshStoredDataView(refreshStoredDataView);
    },
    exportWorldbookSnapshot,
    subscribeWorldbookSnapshot,
    unsubscribeWorldbookSnapshot,
    resetWorldbookCache,
    setWorldbookLogAdapter,
    warnWorldbookIssue,
    debugWorldbookLog,
    runWorldbookDryRun: (context) => runWorldbookDryRun(context || ctx),
  };

  const bound = bindUI(ctx, currentState, binderDeps);
  if (!bound) {
    console.warn('[ST-Diff][noass] 未找到 UI 容器，挂载跳过');
    resetRuntimeHooks();
    return;
  }

  await initWorldbook(ctx);

  registerCompletion(ctx, currentState, {
    refreshStoredDataView: () => refreshStoredDataView?.(),
  });
}

/**
 * 卸载 noass 模块：注销事件、拆除 UI，并还原运行时缓存。
 *
 * @param {ReturnType<typeof import('../../index.js')['getCtx']>} ctx SillyTavern 扩展上下文
 * @returns {Promise<void>}
 */
export async function unmount(ctx) {
  unregisterCompletion(ctx);
  unbindUI();
  resetRuntimeHooks();
  resetWorldbookCache({ notify: false, resetSubscribers: true });
  await teardownWorldbook(ctx);

  currentCtx = null;
  currentState = null;
}