/**
 * @brisk/core/daemon — in-memory state holder over CdpBackend.
 */

export {
  type AttachedTarget,
  attachFirstPage,
  disableOldSessionNetwork,
  enableDefaultDomains,
  isRealPage,
} from './attach.js';
export { RingBuffer } from './buffer.js';
export { Daemon, type DaemonOptions } from './daemon.js';
