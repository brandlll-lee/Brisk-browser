/**
 * @brisk/core/helpers — browser primitives wrapping CDP.
 *
 * Full helper roster (32 functions across 6 domains):
 *   • navigation  : goto, newTab, switchTab, closeTab, listTabs,
 *                   currentTab, ensureRealTab, iframeTarget         (8)
 *   • observation : captureScreenshot, pageInfo, js, drainEvents    (4 so far; +dom, +getConsoleLogs in later)
 *   • input       : clickAtXY, typeText, fillInput, pressKey, scroll,
 *                   dispatchKey, uploadFile, hoverAtXY, selectOption  (9)
 *   • waits       : wait, waitForLoad, waitForElement, waitForNetworkIdle (4)
 *   • network     : (planned)
 *   • admin       : (planned)
 */

export {
  type ConnectionStatusResult,
  connectionStatus,
  type PendingDialogResult,
  pendingDialog,
  type RestartDaemonArgs,
  type RestartDaemonResult,
  restartDaemon,
} from './admin.js';
export {
  type ClickAtXyArgs,
  type ClickAtXyResult,
  clickAtXY,
  type DispatchKeyArgs,
  type DispatchKeyResult,
  dispatchKey,
  type FillInputArgs,
  type FillInputResult,
  fillInput,
  type HoverAtXyArgs,
  type HoverAtXyResult,
  hoverAtXY,
  type PressKeyArgs,
  type PressKeyResult,
  pressKey,
  type ScrollArgs,
  type ScrollResult,
  type SelectOptionArgs,
  type SelectOptionResult,
  scroll,
  selectOption,
  type TypeTextArgs,
  type TypeTextResult,
  typeText,
  type UploadFileArgs,
  type UploadFileResult,
  uploadFile,
} from './input.js';
export {
  type CloseTabArgs,
  type CloseTabResult,
  type CurrentTabResult,
  closeTab,
  currentTab,
  type EnsureRealTabResult,
  ensureRealTab,
  type GotoArgs,
  type GotoResult,
  goto,
  type IframeTargetArgs,
  type IframeTargetResult,
  iframeTarget,
  type ListTabsArgs,
  listTabs,
  type NewTabArgs,
  type NewTabResult,
  newTab,
  type SwitchTabArgs,
  type SwitchTabResult,
  switchTab,
  type TabInfo,
} from './navigation.js';

export {
  type CdpRawArgs,
  type CdpRawResult,
  cdpRaw,
  type HttpGetArgs,
  type HttpGetResult,
  httpGet,
} from './network.js';
export {
  type CaptureScreenshotArgs,
  type CaptureScreenshotResult,
  captureScreenshot,
  type DomArgs,
  type DomResult,
  type DrainEventsResult,
  dom,
  drainEvents,
  type GetConsoleLogsArgs,
  type GetConsoleLogsResult,
  getConsoleLogs,
  type JsArgs,
  type JsResult,
  js,
  type PageInfoResultFull,
  type PageInfoResultUnion,
  pageInfo,
} from './observation.js';

export type { HelperContext, HelperResult } from './types.js';

export {
  type WaitArgs,
  type WaitForElementArgs,
  type WaitForElementResult,
  type WaitForLoadArgs,
  type WaitForLoadResult,
  type WaitForNetworkIdleArgs,
  type WaitForNetworkIdleResult,
  type WaitResult,
  wait,
  waitForElement,
  waitForLoad,
  waitForNetworkIdle,
} from './waits.js';
