/**
 * Wait primitives — sleep + poll until condition.
 *
 * Four helpers: wait, waitForLoad, waitForElement, waitForNetworkIdle.
 * Mirrors browser-harness helpers.py:358-433.
 *
 * Important: these helpers DO NOT retry the underlying CDP command
 * on failure. They poll a condition. If you want retry semantics,
 * compose this in agent code — that's the "less is more" promise.
 */

import { briskError, err, ok } from '@brisk/types';

import { js } from './observation.js';
import type { HelperContext, HelperResult } from './types.js';

const DEFAULT_POLL_MS = 300;

// ─── wait (sleep) ────────────────────────────────────────────────────

export interface WaitArgs {
  readonly seconds: number;
}

export interface WaitResult {
  readonly waitedSeconds: number;
}

/** Plain sleep. Resolves after `seconds * 1000` ms. */
export async function wait(_ctx: HelperContext, args: WaitArgs): Promise<HelperResult<WaitResult>> {
  if (!Number.isFinite(args.seconds) || args.seconds < 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'wait: seconds must be a non-negative number'));
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, args.seconds * 1000);
    t.unref?.();
  });
  return ok({ waitedSeconds: args.seconds });
}

// ─── waitForLoad ─────────────────────────────────────────────────────

export interface WaitForLoadArgs {
  readonly timeoutSeconds?: number;
  readonly pollMs?: number;
}

export interface WaitForLoadResult {
  readonly ready: boolean;
  readonly waitedMs: number;
}

/**
 * Poll `document.readyState === 'complete'` or timeout (default 15s).
 * Returns `{ready: false}` on timeout, not an error.
 *
 * Mirrors browser-harness wait_for_load (helpers.py:362-368).
 */
export async function waitForLoad(
  ctx: HelperContext,
  args: WaitForLoadArgs = {},
): Promise<HelperResult<WaitForLoadResult>> {
  const timeoutMs = (args.timeoutSeconds ?? 15) * 1000;
  const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await js(ctx, { expression: 'document.readyState' });
    if (r.ok && r.value.value === 'complete') {
      return ok({ ready: true, waitedMs: Date.now() - start });
    }
    await sleep(pollMs);
  }
  return ok({ ready: false, waitedMs: Date.now() - start });
}

// ─── waitForElement ──────────────────────────────────────────────────

export interface WaitForElementArgs {
  readonly selector: string;
  readonly timeoutSeconds?: number;
  /** Require `checkVisibility()` true (computed style + ancestor chain). */
  readonly visible?: boolean;
  readonly pollMs?: number;
  readonly sessionId?: string;
}

export interface WaitForElementResult {
  readonly found: boolean;
  readonly waitedMs: number;
}

/**
 * Poll `document.querySelector(selector)` (optionally `checkVisibility`)
 * until the element exists, or timeout (default 10s).
 *
 * Mirrors browser-harness wait_for_element (helpers.py:370-398).
 */
export async function waitForElement(
  ctx: HelperContext,
  args: WaitForElementArgs,
): Promise<HelperResult<WaitForElementResult>> {
  if (!args.selector) {
    return err(briskError('HELPER_INVALID_SELECTOR', 'waitForElement: selector is required'));
  }
  const timeoutMs = (args.timeoutSeconds ?? 10) * 1000;
  const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
  const sel = JSON.stringify(args.selector);

  // checkVisibility walks the ancestor chain (display/visibility/opacity).
  // Older Chrome (< M105) lacks it; fall back to a per-element style check.
  const expr = args.visible
    ? `(()=>{const e=document.querySelector(${sel});if(!e)return false;if(typeof e.checkVisibility==='function')return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'})()`
    : `!!document.querySelector(${sel})`;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await js(ctx, {
      expression: expr,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    });
    if (r.ok && r.value.value === true) {
      return ok({ found: true, waitedMs: Date.now() - start });
    }
    await sleep(pollMs);
  }
  return ok({ found: false, waitedMs: Date.now() - start });
}

// ─── waitForNetworkIdle ──────────────────────────────────────────────

export interface WaitForNetworkIdleArgs {
  readonly timeoutSeconds?: number;
  readonly idleMs?: number;
  readonly pollMs?: number;
}

export interface WaitForNetworkIdleResult {
  readonly idle: boolean;
  readonly waitedMs: number;
  readonly inflightAtEnd: number;
}

/**
 * Wait until no in-flight Network.* requests AND no Network.* events
 * arrive for `idleMs` ms. Drains the daemon's event buffer in a poll
 * loop; events from non-active sessions (e.g. backgrounded tabs with
 * SSE / WebSocket pollers) are filtered out — see helpers.py:400-433
 * for the long-form rant.
 *
 * Returns `{idle: false}` on timeout (no exception).
 */
export async function waitForNetworkIdle(
  ctx: HelperContext,
  args: WaitForNetworkIdleArgs = {},
): Promise<HelperResult<WaitForNetworkIdleResult>> {
  const timeoutMs = (args.timeoutSeconds ?? 10) * 1000;
  const idleMs = args.idleMs ?? 500;
  const pollMs = args.pollMs ?? 100;
  const start = Date.now();
  let lastActivity = start;
  const inflight = new Set<string>();
  const activeSession = ctx.daemon.getSession().sessionId;

  while (Date.now() - start < timeoutMs) {
    const events = ctx.daemon.drainEvents();
    for (const ev of events) {
      if (activeSession && ev.sessionId !== activeSession) continue;
      const method = ev.method;
      const params = ev.params as Record<string, unknown>;
      if (method === 'Network.requestWillBeSent') {
        const id = String(params.requestId);
        inflight.add(id);
        lastActivity = Date.now();
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight.delete(String(params.requestId));
        lastActivity = Date.now();
      } else if (method.startsWith('Network.')) {
        lastActivity = Date.now();
      }
    }
    if (inflight.size === 0 && Date.now() - lastActivity >= idleMs) {
      return ok({ idle: true, waitedMs: Date.now() - start, inflightAtEnd: 0 });
    }
    await sleep(pollMs);
  }
  return ok({
    idle: false,
    waitedMs: Date.now() - start,
    inflightAtEnd: inflight.size,
  });
}

// ─── helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export { err, ok };
