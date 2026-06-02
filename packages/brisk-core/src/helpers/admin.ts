/**
 * Admin primitives — connection status, dialog inspection, daemon reset.
 *
 * Equivalent to browser-harness's `connection_status` / `pending_dialog`
 * / `restart_daemon` IPC operations, but exposed at the helper layer so
 * MCP tools can consume them without round-tripping through IPC.
 *
 * `restartDaemon` is intentionally narrow in V0.1.0: we don't fork a
 * fresh Node process — Brisk's daemon is single-process — so the helper
 * tears down the CDP socket, reconnects, and re-attaches. Equivalent
 * outcome from the agent's perspective.
 */

import { briskError, type ConnectionStatusResponse, type DialogInfo, err, ok } from '@brisk/types';

import type { HelperContext, HelperResult } from './types.js';

// ─── connectionStatus ─────────────────────────────────────────────

export type ConnectionStatusResult = Pick<
  ConnectionStatusResponse,
  'status' | 'version' | 'userAgent'
> & {
  readonly sessionId: string | null;
  readonly targetId: string | null;
};

/**
 * Snapshot the daemon's connection: is the WebSocket up? what page is
 * attached? what's the underlying Chrome version?
 *
 * Cheap — a single `Browser.getVersion` round-trip plus local state.
 */
export async function connectionStatus(
  ctx: HelperContext,
): Promise<HelperResult<ConnectionStatusResult>> {
  const session = ctx.daemon.getSession();
  if (!ctx.cdp.isConnected()) {
    return ok({
      status: 'disconnected',
      sessionId: session.sessionId,
      targetId: session.targetId,
    });
  }
  try {
    const v = await ctx.cdp.send<{ product?: string; userAgent?: string }>('Browser.getVersion');
    return ok({
      status: 'connected',
      sessionId: session.sessionId,
      targetId: session.targetId,
      ...(typeof v.product === 'string' ? { version: v.product } : {}),
      ...(typeof v.userAgent === 'string' ? { userAgent: v.userAgent } : {}),
    });
  } catch (cause) {
    return err(
      briskError('CDP_DISCONNECTED', `Browser.getVersion failed: ${(cause as Error).message}`, {
        cause: cause as Error,
      }),
    );
  }
}

// ─── pendingDialog ─────────────────────────────────────────────────

export interface PendingDialogResult {
  readonly dialog: DialogInfo | null;
}

/**
 * Get the currently open JavaScript dialog (alert/confirm/prompt/
 * beforeunload), if any. Tracked by the daemon via `Page.javascriptDialogOpening`
 * / `Page.javascriptDialogClosed`.
 *
 * Pure read — no CDP traffic.
 */
export async function pendingDialog(
  ctx: HelperContext,
): Promise<HelperResult<PendingDialogResult>> {
  return Promise.resolve(ok({ dialog: ctx.daemon.getPendingDialog() }));
}

// ─── restartDaemon ─────────────────────────────────────────────────

export interface RestartDaemonArgs {
  /**
   * Reconnect-only — do NOT re-attach to a fresh page after the socket
   * comes back. Useful when the caller wants to handle attach manually.
   * Default false.
   */
  readonly skipReattach?: boolean;
}

export interface RestartDaemonResult {
  readonly reconnected: boolean;
  readonly sessionId: string | null;
  readonly targetId: string | null;
}

/**
 * Force the CDP socket to reconnect.
 *
 * Brisk V0.1.0 daemon is single-process: we tear down the WebSocket,
 * `connect()` re-runs discovery, and (unless `skipReattach`) we attach
 * to the first real tab again. Future Chromium-embedded build will
 * make this a no-op since the daemon and Chrome share a process.
 */
export async function restartDaemon(
  ctx: HelperContext,
  args: RestartDaemonArgs = {},
): Promise<HelperResult<RestartDaemonResult>> {
  try {
    await ctx.cdp.disconnect();
  } catch (cause) {
    return err(
      briskError('CDP_DISCONNECTED', `disconnect failed: ${(cause as Error).message}`, {
        cause: cause as Error,
      }),
    );
  }
  try {
    await ctx.cdp.connect();
  } catch (cause) {
    return err(
      briskError('CDP_NOT_CONNECTED', `reconnect failed: ${(cause as Error).message}`, {
        cause: cause as Error,
      }),
    );
  }

  if (!args.skipReattach) {
    try {
      await ctx.daemon.attachFirstRealPage();
    } catch (cause) {
      return err(
        briskError(
          'BROWSER_NOT_FOUND',
          `attach after reconnect failed: ${(cause as Error).message}`,
          {
            cause: cause as Error,
          },
        ),
      );
    }
  }

  const session = ctx.daemon.getSession();
  return ok({
    reconnected: true,
    sessionId: session.sessionId,
    targetId: session.targetId,
  });
}
