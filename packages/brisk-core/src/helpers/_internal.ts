/**
 * Internal helper utilities — not exported from the package barrel.
 *
 * `requireSession` and the `Result` wrappers live here so the
 * per-domain helper files (navigation/observation/...) stay focused
 * on browser semantics, not boilerplate.
 */

import { asBriskError, briskError, err, ok, type Result } from '@brisk/types';

import type { Daemon } from '../daemon/daemon.js';

/** Pull the active session id from the daemon or fail with `HELPER_NO_ACTIVE_PAGE`. */
export function requireSession(daemon: Daemon): Result<string> {
  const sid = daemon.getSession().sessionId;
  if (!sid) {
    return err(
      briskError(
        'HELPER_NO_ACTIVE_PAGE',
        'No attached page; call daemon.start() or `attach_first_page` first',
      ),
    );
  }
  return ok(sid);
}

/** Run `fn` and coerce any thrown error to a `BriskError`-tagged Result. */
export async function runCdp<T>(
  fn: () => Promise<T>,
  fallbackCode: 'CDP_PROTOCOL_ERROR' | 'HELPER_TIMEOUT' = 'CDP_PROTOCOL_ERROR',
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(asBriskError(cause, fallbackCode));
  }
}
