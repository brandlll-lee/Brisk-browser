/**
 * @brisk/ipc — cross-platform IPC for Brisk.
 *
 * Linux/macOS: Unix domain socket at `${tmpdir()}/brisk-<name>.sock`.
 * Windows: named pipe at `\\.\pipe\brisk-<name>`.
 *
 * Wire format: JSON-line (one JSON value + `\n` framing).
 *
 * @example Server
 * ```ts
 * import { createIpcServer } from '@brisk/ipc';
 * const server = await createIpcServer('default', async (req) => {
 *   if (req && typeof req === 'object' && (req as any).meta === 'ping') {
 *     return { pong: true, pid: process.pid };
 *   }
 *   return { error: 'not_implemented' };
 * });
 * console.log('listening at', server.endpoint);
 * ```
 *
 * @example One-shot client
 * ```ts
 * import { ipcRequest } from '@brisk/ipc';
 * const resp = await ipcRequest('default', { meta: 'ping' });
 * ```
 */

export type { IpcClient, IpcRequestOptions } from './client.js';
export { connectIpc, ipcRequest } from './client.js';
export { ipcPath, isWindowsPipe } from './paths.js';
export { identifyIpcDaemon, pingIpc } from './ping.js';
export type { DecoderOptions } from './protocol.js';
export {
  decodeFrame,
  encodeFrame,
  FRAME_TERMINATOR,
  FRAME_TERMINATOR_BYTE,
  LineDecoder,
  MAX_FRAME_BYTES,
} from './protocol.js';
export type { IpcServer, IpcServerOptions, RequestHandler } from './server.js';
export { createIpcServer } from './server.js';
