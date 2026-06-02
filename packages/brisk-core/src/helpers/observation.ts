/**
 * Observation primitives — screenshot, page geometry, JS eval, event drain.
 *
 * "Screenshot first" is Brisk's core LLM-vision strategy: every helper
 * here optimizes for the agent reading a single PNG + page_info
 * snapshot, not for low-level DOM scraping. Mirrors browser-harness
 * helpers.py's visual section (capture_screenshot at line 269 and
 * page_info at line 166 are the gravity wells the harness orbits).
 *
 * Helper count target: 6 (captureScreenshot, pageInfo, js, dom,
 * drainEvents, getConsoleLogs). W2 ships captureScreenshot / pageInfo /
 * js / drainEvents — the heaviest 4 — and leaves dom + console logs
 * to W3 once the daemon's event buffer has been exercised under load.
 */

import { briskError, type CdpEventLog, err, ok, type Result } from '@brisk/types';

import { CDP_REQUEST_TIMEOUT_MS } from '../constants.js';
import { runCdp } from './_internal.js';
import type { HelperContext, HelperResult } from './types.js';

// ─── captureScreenshot ───────────────────────────────────────────────

export interface CaptureScreenshotArgs {
  /** Image format. Default 'png'. */
  readonly format?: 'png' | 'jpeg' | 'webp';
  /** JPEG quality 0-100 (jpeg only). */
  readonly quality?: number;
  /** Capture beyond the visible viewport (full page). Default false. */
  readonly fullPage?: boolean;
  /** Speed-over-quality encoding. Useful for >2 hz screenshot polling. */
  readonly optimizeForSpeed?: boolean;
  /** Capture a specific region of the page. */
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
}

export interface CaptureScreenshotResult {
  /** Raw image bytes — caller writes to disk / encodes to data: URL. */
  readonly bytes: Uint8Array;
  readonly format: 'png' | 'jpeg' | 'webp';
}

/**
 * Capture a PNG (default) of the attached tab's viewport.
 *
 * Internally calls `Page.captureScreenshot` with the latest 2026 wire
 * shape — captureBeyondViewport / optimizeForSpeed / clip / format /
 * quality — as documented at
 *   https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot
 *
 * Returns raw bytes, not a file path; the caller decides storage.
 * Browser-harness helpers.py:269-281 always writes to disk, which
 * hurts in MCP-over-stdio scenarios where we'd rather hand the
 * agent a base64 blob inline.
 */
export async function captureScreenshot(
  ctx: HelperContext,
  args: CaptureScreenshotArgs = {},
): Promise<HelperResult<CaptureScreenshotResult>> {
  const format = args.format ?? 'png';
  if (args.quality !== undefined && (args.quality < 0 || args.quality > 100)) {
    return err(
      briskError('HELPER_INVALID_ARGS', `quality must be in [0, 100], got ${args.quality}`),
    );
  }
  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: args.fullPage ?? false,
    optimizeForSpeed: args.optimizeForSpeed ?? false,
  };
  if (args.quality !== undefined) params.quality = args.quality;
  if (args.clip !== undefined) params.clip = args.clip;

  return runCdp(async () => {
    // Backgrounded headless tabs can stop compositing and leave
    // Page.captureScreenshot hanging until the CDP request timeout.
    // Page.bringToFront is the smallest reliable compositor wake-up;
    // keep it best-effort so the screenshot call remains the authority.
    await ctx.daemon.callCdp('Page.bringToFront').catch(() => undefined);
    const r = await ctx.daemon.callCdp<{ data: string }>('Page.captureScreenshot', params);
    return {
      bytes: Buffer.from(r.data, 'base64'),
      format,
    };
  });
}

// ─── pageInfo ────────────────────────────────────────────────────────

export interface PageInfoResultFull {
  readonly url: string;
  readonly title: string;
  /** Viewport width in CSS px. */
  readonly w: number;
  /** Viewport height in CSS px. */
  readonly h: number;
  /** scrollX in CSS px. */
  readonly sx: number;
  /** scrollY in CSS px. */
  readonly sy: number;
  /** Document scrollWidth — page width including non-visible columns. */
  readonly pw: number;
  /** Document scrollHeight — page height including non-visible rows. */
  readonly ph: number;
}

export type PageInfoResultUnion =
  | { readonly kind: 'page'; readonly info: PageInfoResultFull }
  | {
      readonly kind: 'dialog';
      readonly dialog: NonNullable<ReturnType<HelperContext['daemon']['getPendingDialog']>>;
    };

const PAGE_INFO_JS =
  'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})';

/**
 * Viewport + scroll + page-size snapshot.
 *
 * If a native dialog is open, returns `{kind: 'dialog', dialog}`
 * instead — the page's JS thread is frozen until the dialog is
 * handled, so `Runtime.evaluate` would deadlock until then. Mirrors
 * browser-harness page_info (helpers.py:166-176).
 */
export async function pageInfo(ctx: HelperContext): Promise<HelperResult<PageInfoResultUnion>> {
  const dialog = ctx.daemon.getPendingDialog();
  if (dialog) return ok({ kind: 'dialog', dialog });

  return runCdp(async () => {
    // The expression itself wraps the dict in JSON.stringify (so we
    // get a string out of returnByValue), then we parse it on this
    // side. Mirrors browser-harness helpers.py:175-176.
    const raw = await evaluateForJson<unknown>(ctx, PAGE_INFO_JS);
    if (typeof raw !== 'string') {
      throw briskError(
        'CDP_PROTOCOL_ERROR',
        `pageInfo: expected stringified JSON, got ${typeof raw}`,
      );
    }
    const info = JSON.parse(raw) as PageInfoResultFull;
    return { kind: 'page', info } as const;
  });
}

// ─── js (Runtime.evaluate) ───────────────────────────────────────────

export interface JsArgs {
  readonly expression: string;
  /** Resolve a returned Promise before responding. Default true. */
  readonly awaitPromise?: boolean;
  /**
   * Override timeout for this evaluation (default = CDP_REQUEST_TIMEOUT_MS).
   * Helpful for long-running JS (e.g. extracting from a huge table).
   */
  readonly timeoutMs?: number;
  /** Run inside an iframe / worker — supply its target's sessionId. */
  readonly sessionId?: string;
}

export interface JsResult {
  readonly value: unknown;
}

/**
 * Evaluate a JS expression in the attached tab (or an iframe via
 * `sessionId`). Auto-wraps top-level `return` so callers can write
 * `const x = 1; return x` without a manual IIFE (browser-harness
 * helpers.py:439-444).
 *
 * Throws `BriskError('CDP_PROTOCOL_ERROR')` if Chrome reports an
 * `exceptionDetails` — the message includes line/column when Chrome
 * surfaces them. This mirrors helpers.py:93-104 verbatim.
 */
export async function js(ctx: HelperContext, args: JsArgs): Promise<HelperResult<JsResult>> {
  if (typeof args.expression !== 'string' || args.expression.length === 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'js: expression must be a non-empty string'));
  }
  const expr = hasTopLevelReturn(args.expression)
    ? `(function(){${args.expression}})()`
    : args.expression;
  return runCdp(async () => {
    const value = await evaluateForJson<unknown>(ctx, expr, {
      awaitPromise: args.awaitPromise ?? true,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    });
    return { value };
  });
}

// ─── drainEvents ─────────────────────────────────────────────────────

export interface DrainEventsResult {
  readonly events: readonly CdpEventLog[];
}

/**
 * Get and clear the daemon's CDP event buffer.
 *
 * `wait_for_network_idle` and `getConsoleLogs` (W3) consume from this
 * — anything not drained gets evicted at 500 events. Mirrors
 * browser-harness `drain_events` (helpers.py:57).
 */
export async function drainEvents(ctx: HelperContext): Promise<HelperResult<DrainEventsResult>> {
  return Promise.resolve(ok({ events: ctx.daemon.drainEvents() }));
}

// ─── dom (DOM.querySelector / DOM.getDocument) ────────────────────────

export interface DomArgs {
  /**
   * CSS selector to match. When omitted, the helper returns the whole
   * document tree (DOM.getDocument depth = -1, pierce = true).
   */
  readonly selector?: string;
  /** Document depth. -1 for the whole tree. Default 2. */
  readonly depth?: number;
  /** Whether to descend into shadow DOM and iframes. Default true. */
  readonly pierce?: boolean;
  /** Run inside a specific session (iframe). */
  readonly sessionId?: string;
}

export interface DomResult {
  /** `nodeId` of the document (selector omitted) or the matched element. */
  readonly nodeId: number | null;
  /** Backing CDP Node tree (when no selector) or matched node info (with selector). */
  readonly tree?: Record<string, unknown>;
}

/**
 * Inspect the DOM. Two modes:
 *   • no selector → `DOM.getDocument` (entire tree)
 *   • selector    → `DOM.getDocument` (depth 1) + `DOM.querySelector`
 *
 * Returns nodeId so the agent can chain into `DOM.describeNode`, etc.
 * Lineage: browser-harness helpers.py:`cdp("DOM.getDocument", ...)`
 * pattern (line 461 fillInput uses it) — we surface the same primitives.
 */
export async function dom(
  ctx: HelperContext,
  args: DomArgs = {},
): Promise<HelperResult<DomResult>> {
  const depth = args.depth ?? (args.selector ? 1 : 2);
  const pierce = args.pierce ?? true;
  const sessionParam = args.sessionId !== undefined ? args.sessionId : undefined;

  return runCdp(async () => {
    const doc = await callCdpSession<{ root: Record<string, unknown> }>(
      ctx,
      'DOM.getDocument',
      { depth, pierce },
      sessionParam,
    );
    const rootNode = doc.root;
    if (!args.selector) {
      return {
        nodeId: typeof rootNode.nodeId === 'number' ? rootNode.nodeId : null,
        tree: rootNode,
      };
    }
    const rootNodeId = typeof rootNode.nodeId === 'number' ? rootNode.nodeId : null;
    if (rootNodeId === null) {
      throw briskError('CDP_PROTOCOL_ERROR', 'DOM.getDocument returned no rootNodeId');
    }
    const qs = await callCdpSession<{ nodeId: number }>(
      ctx,
      'DOM.querySelector',
      { nodeId: rootNodeId, selector: args.selector },
      sessionParam,
    );
    if (!qs.nodeId) {
      return { nodeId: null };
    }
    const describe = await callCdpSession<{ node: Record<string, unknown> }>(
      ctx,
      'DOM.describeNode',
      { nodeId: qs.nodeId, depth, pierce },
      sessionParam,
    );
    return { nodeId: qs.nodeId, tree: describe.node };
  });
}

function callCdpSession<T>(
  ctx: HelperContext,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined,
): Promise<T> {
  if (sessionId !== undefined) {
    return ctx.cdp.sendOnSession<T>(sessionId, method, params);
  }
  return ctx.daemon.callCdp<T>(method, params);
}

// ─── getConsoleLogs ──────────────────────────────────────────────────

export interface GetConsoleLogsArgs {
  /** Minimum severity. Default 'info' (info + warn + error). */
  readonly level?: 'error' | 'warning' | 'info' | 'debug';
  /** Substring filter (case-insensitive). */
  readonly search?: string;
  /** Max entries to return. Default 100, max 1000. */
  readonly limit?: number;
  /** Clear the buffer after reading. Default false. */
  readonly clear?: boolean;
  /** Pass an iframe sessionId to get its logs; otherwise daemon-wide. */
  readonly sessionId?: string;
}

export interface GetConsoleLogsResult {
  readonly entries: ReadonlyArray<{
    readonly source: 'console' | 'exception' | 'browser';
    readonly level: 'error' | 'warning' | 'info' | 'debug';
    readonly text: string;
    readonly url?: string;
    readonly lineNumber?: number;
    readonly timestamp: number;
  }>;
  readonly totalCount: number;
  readonly returnedCount: number;
}

/**
 * Fetch buffered console output for the attached page (or any
 * iframe via `sessionId`). The buffer is filled by the daemon's
 * `ConsoleCollector`, which subscribes to `Runtime.consoleAPICalled`,
 * `Runtime.exceptionThrown`, and `Log.entryAdded` for every session.
 *
 * Lineage: BrowserOS tools/console.ts:51-94.
 */
export async function getConsoleLogs(
  ctx: HelperContext,
  args: GetConsoleLogsArgs = {},
): Promise<HelperResult<GetConsoleLogsResult>> {
  const result = ctx.daemon.getConsoleLogs(args.sessionId ?? ctx.daemon.getSession().sessionId, {
    ...(args.level ? { level: args.level } : {}),
    ...(args.search ? { search: args.search } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.clear !== undefined ? { clear: args.clear } : {}),
  });
  return ok({
    entries: result.entries,
    totalCount: result.totalCount,
    returnedCount: result.entries.length,
  });
}

// ─── Internal ────────────────────────────────────────────────────────

interface EvalOptions {
  readonly awaitPromise?: boolean;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
}

async function evaluateForJson<T>(
  ctx: HelperContext,
  expression: string,
  options: EvalOptions = {},
): Promise<T> {
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise ?? true,
  };

  // Per-call timeout via Promise.race. The backend has its own request
  // timeout (CDP_REQUEST_TIMEOUT_MS) — we layer a tighter ceiling here
  // for callers that need it (long table scrapes, etc).
  const timeoutMs = options.timeoutMs ?? CDP_REQUEST_TIMEOUT_MS;

  const evalPromise = options.sessionId
    ? ctx.cdp.sendOnSession<EvaluateResponse>(options.sessionId, 'Runtime.evaluate', params)
    : ctx.daemon.callCdp<EvaluateResponse>('Runtime.evaluate', params);

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          briskError(
            'HELPER_TIMEOUT',
            `Runtime.evaluate timed out after ${timeoutMs}ms; expression: ${snippet(expression)}`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });

  let response: EvaluateResponse;
  try {
    response = await Promise.race([evalPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const result = response.result ?? {};
  if (response.exceptionDetails || result.subtype === 'error') {
    throw briskError(
      'CDP_PROTOCOL_ERROR',
      describeEvalFailure(result, response.exceptionDetails, expression),
    );
  }

  if ('value' in result) return result.value as T;
  if (typeof result.unserializableValue === 'string') {
    return decodeUnserializable(result.unserializableValue) as T;
  }
  return undefined as T;
}

interface EvaluateRemoteObject {
  readonly type?: string;
  readonly subtype?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly className?: string;
}

interface EvaluateExceptionDetails {
  readonly text?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly exception?: EvaluateRemoteObject;
}

interface EvaluateResponse {
  readonly result: EvaluateRemoteObject;
  readonly exceptionDetails?: EvaluateExceptionDetails;
}

function describeEvalFailure(
  result: EvaluateRemoteObject,
  details: EvaluateExceptionDetails | undefined,
  expression: string,
): string {
  let desc = result.description;
  const exc = details?.exception;
  if (!desc && exc && typeof exc === 'object') {
    desc = exc.description;
    if (!desc && 'value' in exc && typeof exc.value !== 'undefined') desc = String(exc.value);
    if (!desc) desc = exc.className;
  }
  if (!desc) desc = details?.text;
  if (!desc) desc = 'JavaScript evaluation failed';
  const line = details?.lineNumber;
  const col = details?.columnNumber;
  const loc = line !== undefined && col !== undefined ? ` at line ${line}, column ${col}` : '';
  return `JavaScript evaluation failed${loc}: ${desc}; expression: ${snippet(expression)}`;
}

function snippet(expression: string, limit = 160): string {
  const oneLine = expression.trim().replace(/\n/g, '\\n');
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 3)}...`;
}

function decodeUnserializable(value: string): unknown {
  switch (value) {
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    case '-0':
      return -0;
    default:
      // BigInt literals end in 'n'. Anything else we don't know — pass it
      // through verbatim so the caller can decide.
      if (value.endsWith('n')) {
        try {
          return BigInt(value.slice(0, -1));
        } catch {
          return value;
        }
      }
      return value;
  }
}

/**
 * Scan a JS expression for a top-level `return` so we can auto-wrap
 * it in an IIFE. Ported byte-for-byte from helpers.py:120-155 — the
 * test suite for that function in browser-harness exercises strings,
 * comments, regex literals, and Unicode identifiers, so we should
 * inherit those edge cases as we add helper tests.
 */
function hasTopLevelReturn(expression: string): boolean {
  const n = expression.length;
  let i = 0;
  type State = 'code' | 'line_comment' | 'block_comment' | 'string';
  let state: State = 'code';
  let quote = '';
  while (i < n) {
    const ch = expression[i];
    const nxt = expression[i + 1] ?? '';
    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') {
        state = 'string';
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '/' && nxt === '/') {
        state = 'line_comment';
        i += 2;
        continue;
      }
      if (ch === '/' && nxt === '*') {
        state = 'block_comment';
        i += 2;
        continue;
      }
      if (expression.startsWith('return', i)) {
        const before = i > 0 ? (expression[i - 1] ?? '') : '';
        const after = i + 6 < n ? (expression[i + 6] ?? '') : '';
        if (!isIdentChar(before) && !isIdentChar(after)) return true;
      }
      i += 1;
      continue;
    }
    if (state === 'line_comment') {
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }
    if (state === 'block_comment') {
      if (ch === '*' && nxt === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        state = 'code';
        quote = '';
      }
      i += 1;
    }
  }
  return false;
}

function isIdentChar(c: string): boolean {
  return c === '_' || /[a-zA-Z0-9]/.test(c);
}

export type { Result };
// Re-exports for callers that want to type-narrow Result without
// importing @brisk/types directly.
export { err, ok };
