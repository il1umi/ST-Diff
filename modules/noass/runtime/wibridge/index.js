/**
 * @file 汇总世界书桥接域的导出，供 orchestrator 与 UI 调用。
 */
import {
  initializeWorldbookIntegration,
  teardownWorldbookIntegration,
  exportWorldbookSnapshot,
  subscribeWorldbookSnapshot,
  unsubscribeWorldbookSnapshot,
  resetWorldbookCache,
} from './cache.js';
import {
  setWorldbookLogAdapter,
  setWorldbookDebug,
  debugWorldbookLog,
  warnWorldbookIssue,
  DRY_RUN_STATUS,
  createDryRunContext,
  finalizeDryRunContext,
  cloneMessageArray,
  getWorldbookLogAdapter,
} from './state.js';
import { attachDryRunHelpers, injectWorldbookSentinels } from './sentinel.js';
import {
  dispatchWorldbookSegments,
  applyWorldbookSegmentDispatch,
  normalizeWorldbookContent,
  normalizeWorldbookFragment,
} from './dispatch.js';

export {
  initializeWorldbookIntegration as initWorldbook,
  teardownWorldbookIntegration as teardownWorldbook,
  exportWorldbookSnapshot,
  subscribeWorldbookSnapshot,
  unsubscribeWorldbookSnapshot,
  resetWorldbookCache,
  setWorldbookLogAdapter,
  setWorldbookDebug,
  debugWorldbookLog,
  warnWorldbookIssue,
  DRY_RUN_STATUS,
  createDryRunContext,
  finalizeDryRunContext,
  cloneMessageArray,
  getWorldbookLogAdapter,
  attachDryRunHelpers,
  injectWorldbookSentinels,
  dispatchWorldbookSegments,
  applyWorldbookSegmentDispatch,
  normalizeWorldbookContent,
  normalizeWorldbookFragment,
};