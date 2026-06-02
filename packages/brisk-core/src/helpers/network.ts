/**
 * Network primitives — out-of-band HTTP and raw CDP passthrough.
 *
 * Two helpers:
 *   • httpGet — plain `fetch()` from the daemon's Node process. Use
 *     when the agent wants a static HTML page or REST API result
 *     WITHOUT spending a tab on it (browser-harness helpers.py:468-485).
 *   • cdpRaw — issue any CDP method with arbitrary params. Escape hatch
 *     for methods we haven't wrapped yet (helpers.py:52-54).
 *
 * Both helpers are intentionally minimal: no retries, no body parsing,
 * no auth wiring. The thin-harness philosophy from §5.1 of the plan.
 */

import { briskError, err, ok, type Result } from '@brisk/types';

import { runCdp } from './_internal.js';
import type { HelperContext, HelperResult } from './types.js';

// ─── httpGet ───────────────────────────────────────────────────────

export interface HttpGetArgs {
  readonly url: string;
  /** Extra request headers. Spread over the defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request timeout in seconds. Default 20. */
  readonly timeoutSeconds?: number;
  /** Force GET / HEAD / POST etc. Default GET. */
  readonly method?: string;
  /** Body for non-GET methods. String only — caller serializes JSON. */
  readonly body?: string;
  /** Cap on response text length (chars). Truncates with `…` suffix. */
  readonly maxLength?: number;
}

export interface HttpGetResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 BriskBrowser/0.1',
  'Accept-Encoding': 'gzip, deflate, br',
};
const DEFAULT_TIMEOUT_S = 20;
const DEFAULT_MAX_LENGTH = 1_000_000; // 1MB of text

/**
 * Plain HTTP GET (or override `method`) from the daemon process.
 *
 * Honors `AbortSignal` via the `AbortController` plumbed here — the
 * `fetch()` request is cancelled if the timeout elapses. We hand the
 * caller decoded text + content-type + headers; if the response is
 * larger than `maxLength`, we truncate and set `truncated: true`.
 */
export async function httpGet(
  _ctx: HelperContext,
  args: HttpGetArgs,
): Promise<HelperResult<HttpGetResult>> {
  if (typeof args.url !== 'string' || args.url.length === 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'httpGet: url must be a non-empty string'));
  }
  const timeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...(args.headers ?? {}) };
    const response = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers,
      ...(args.body !== undefined ? { body: args.body } : {}),
      signal: controller.signal,
      redirect: 'follow',
    });

    const buf = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const maxLength = args.maxLength ?? DEFAULT_MAX_LENGTH;
    const truncated = text.length > maxLength;
    const sliced = truncated ? `${text.slice(0, maxLength)}…` : text;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return ok({
      url: response.url || args.url,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      headers: responseHeaders,
      text: sliced,
      bytes: buf.byteLength,
      truncated,
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      return err(
        briskError('HELPER_TIMEOUT', `httpGet timed out after ${timeoutMs}ms for ${args.url}`),
      );
    }
    return err(
      briskError('CDP_PROTOCOL_ERROR', `httpGet failed: ${(cause as Error).message}`, {
        cause: cause as Error,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── cdpRaw ────────────────────────────────────────────────────────

export interface CdpRawArgs {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * Route to this CDP sessionId. Omit for browser-level methods
   * (Target.*, Browser.*) or to let the daemon default to the
   * attached page session.
   */
  readonly sessionId?: string;
}

export interface CdpRawResult {
  readonly method: string;
  readonly result: unknown;
}

/**
 * Pass-through CDP. The agent should reach for higher-level helpers
 * (goto / clickAtXY / fillInput / …) first; this is the escape hatch
 * for protocol methods Brisk hasn't wrapped yet.
 *
 * Routes through the daemon's `callCdp` so stale-session recovery
 * applies when `sessionId` is omitted. Iframe sessionIds skip recovery
 * (we don't manage their lifecycle).
 */
export async function cdpRaw(
  ctx: HelperContext,
  args: CdpRawArgs,
): Promise<HelperResult<CdpRawResult>> {
  if (typeof args.method !== 'string' || args.method.length === 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'cdpRaw: method must be a non-empty string'));
  }
  return runCdp(async () => {
    const result =
      args.sessionId !== undefined
        ? await ctx.cdp.sendOnSession<unknown>(args.sessionId, args.method, args.params)
        : await ctx.daemon.callCdp<unknown>(args.method, args.params);
    return { method: args.method, result };
  });
}

export type { Result };
