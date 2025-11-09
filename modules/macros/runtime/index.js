import { MACRO_KEYS } from '../constants.js';
import { execute as executeRoulette, evaluateSync as evaluateRouletteSync } from './roulette.js';
import { execute as executeCascade, evaluateSync as evaluateCascadeSync } from './cascade.js';
import { createEvaluator } from './evaluator.js';

const TAG = '[ST-Diff][macros]';
/**
 * 跟踪此扩展注册的宏，避免取消注册酒馆原生宏。
 * 我们存储创建的具体宏键（例如"roulette_<id>"）以便后续安全注销。
 */
const OWNED_KEYS = new Set();

/**
 * 获取宿主提供的注册与注销函数（使用酒馆的 getContext() ）。
 * @param {any} ctx
 * @returns {{ register: ((key:string, value:string|Function) => void) | null, unregister: ((key:string) => void) | null }}
 */
function resolveHostAdapter(ctx) {
  let register = null;
  let unregister = null;

  if (typeof ctx?.registerMacro === 'function') {
    register = ctx.registerMacro.bind(ctx);
  }
  if (typeof ctx?.unregisterMacro === 'function') {
    unregister = ctx.unregisterMacro.bind(ctx);
  }

  return { register, unregister };
}

/**
 * 注册 ST-Diff 的“键式宏”：
 * 为每个 roulette 宏组注册键名：roulette_<groupId>，值为同步函数，返回加权选取后的文本。
 * 注意：宿主 evaluateMacros() 不支持带参数处理器，所以只能按键名逐组注册。
 * @param {any} ctx
 * @param {{ getState: () => import('../state/manager.js').MacrosState | null, saveState?: () => void }} stateBridge
 */
export function registerMacros(ctx, stateBridge) {
  const { register } = resolveHostAdapter(ctx);
  if (!register) {
    console.warn(`${TAG} 宿主环境缺少 registerMacro，注册中止。`);
    return;
  }

  const state = stateBridge.getState?.();
  if (!state) {
    console.warn(`${TAG} 状态不存在或未初始化，跳过宏注册。`);
    return;
  }

  try {
    // 逐组注册：{{roulette_<id>}}
    if (state.roulette && state.roulette.groups) {
      for (const [groupId] of Object.entries(state.roulette.groups)) {
        const macroKey = `roulette_${groupId}`;
        // 同步执行器：返回已展开的最终文本
        const handler = () => {
          try {
            return evaluateRouletteSync({
              ctx,
              state,
              groupId,
              fallback: `{{${macroKey}}}`,
            });
          } catch (error) {
            console.warn(`${TAG} 运行宏 ${macroKey} 失败`, error);
            return `{{${macroKey}}}`;
          }
        };

        register(macroKey, handler);
        OWNED_KEYS.add(macroKey);
      }
    }

    // 逐组注册：{{cascade_<id>}}
    if (state.cascade && state.cascade.groups) {
      for (const [groupId] of Object.entries(state.cascade.groups)) {
        const macroKey = `cascade_${groupId}`;
        const handler = () => {
          try {
            return evaluateCascadeSync({
              ctx,
              state,
              groupId,
              fallback: `{{${macroKey}}}`,
            });
          } catch (error) {
            console.warn(`${TAG} 运行宏 ${macroKey} 失败`, error);
            return `{{${macroKey}}}`;
          }
        };

        register(macroKey, handler);
        OWNED_KEYS.add(macroKey);
      }
    }
  } catch (error) {
    console.warn(`${TAG} 注册键式宏失败`, error);
  }
}

/**
 * 注销 ST-Diff 扩展注册的宏实现（仅注销本扩展创建的键）。
 * @param {any} ctx
 */
export function unregisterMacros(ctx) {
  const { unregister } = resolveHostAdapter(ctx);
  if (!unregister) {
    return;
  }

  const keys = Array.from(OWNED_KEYS);
  for (const key of keys) {
    try {
      unregister(key);
    } catch (error) {
      console.warn(`${TAG} 注销宏 ${key} 失败`, error);
    }
  }
  OWNED_KEYS.clear();
}