/**
 * Daemon liveness probe — confirms an endpoint at our path is actually
 * Brisk's daemon, not some unrelated process that reused the socket /
 * named pipe after a crash.
 *
 * Reference: browser-harness/_ipc.py:105-158 (`ping`, `identify`).
 *   Mirrors their idea of "ping + read-back PID" to detect PID reuse
 *   in restart paths.
 */

import { ipcRequest } from './client.js';

/**
 * Returns true iff some process answers `{meta: 'ping'}` with
 * `{pong: true, ...}` on the configured endpoint.
 *
 * Distinguishes "no daemon" (connect fails) from "stale endpoint"
 * (connect succeeds but no pong). Both return false; check the second
 * via {@link identifyIpcDaemon} if you need the live PID.
 */
export async function pingIpc(name: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const resp = await ipcRequest(name, { meta: 'ping' }, { timeoutMs });
    return isPongResponse(resp);
  } catch {
    return false;
  }
}

/**
 * Get the PID of the live daemon, or `null` if unreachable or impersonated.
 *
 * Use this before sending SIGTERM in a restart flow — protects against
 * killing an unrelated process whose PID we happen to find in a stale
 * pid file.
 *
 * Strict numeric validation: rejects bool (since `typeof true === 'object'`
 * is false in JS but `typeof true === 'number'` is also false, the danger
 * is upstream JSON producers — we explicit-check `Number.isInteger` and
 * range; mirrors browser-harness/_ipc.py:140-153.
 */
export async function identifyIpcDaemon(name: string, timeoutMs = 1000): Promise<number | null> {
  let resp: unknown;
  try {
    resp = await ipcRequest(name, { meta: 'ping' }, { timeoutMs });
  } catch {
    return null;
  }
  if (!isPongResponse(resp)) return null;
  const pid = (resp as { pid?: unknown }).pid;
  // POSIX: 0 means "every process in the calling group" for kill(2);
  // negative numbers have signal-broadcast semantics. C pid_t is signed
  // 32-bit; values outside that range break os.kill() before our cleanup.
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid < 2 ** 31) {
    return pid;
  }
  return null;
}

function isPongResponse(v: unknown): v is { pong: true } {
  return (
    typeof v === 'object' && v !== null && 'pong' in v && (v as { pong: unknown }).pong === true
  );
}
