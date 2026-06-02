/**
 * @brisk/core/cdp — CDP backend, discovery, and types.
 */

export { CdpBackend } from './backend.js';
export {
  type DiscoveryOptions,
  defaultProfileDirs,
  discoverCdpEndpoint,
} from './discovery.js';
export type {
  AttachOptions,
  BackendLogger,
  CdpAnyEventListener,
  CdpBackendApi,
  CdpBackendOptions,
  CdpEndpoint,
  CdpErrorResponse,
  CdpEvent,
  CdpEventListener,
  CdpMessage,
  CdpProtocolError,
  CdpRequest,
  CdpResponse,
  CdpSession,
  CdpSessionEventListener,
  CdpSuccessResponse,
  CdpTarget,
  CdpTargetType,
  Disposable,
  PageInfoResult,
  ScreenshotOptions,
} from './types.js';
