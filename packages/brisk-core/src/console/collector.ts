/**
 * ConsoleCollector — buffer per-session console / exception / Log entries.
 *
 * Mirrors BrowserOS's `apps/server/src/browser/console-collector.ts`
 * (see references/) but keyed on CDP sessionId instead of an internal
 * pageId — Brisk's daemon has only one active page session at a time
 * but helpers can spawn iframe sessions which want their own buffer.
 *
 * The collector subscribes to `cdp.onAny` once and routes by sessionId.
 * Buffer per session is bounded (FIFO eviction) so a chatty page never
 * blows up memory.
 *
 * 来源:
 *   BrowserOS console-collector.ts:69-219
 *   Chromium DevTools Protocol Runtime + Log domain docs
 */

import type { CdpBackendApi, Disposable } from '../cdp/types.js';

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface ConsoleEntry {
  readonly source: 'console' | 'exception' | 'browser';
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly url?: string;
  readonly lineNumber?: number;
  /** Best-effort wall-clock; falls back to local Date.now() when CDP doesn't include one. */
  readonly timestamp: number;
}

export interface GetLogsOptions {
  readonly level?: ConsoleLevel;
  readonly search?: string;
  readonly limit?: number;
  readonly clear?: boolean;
}

export interface GetLogsResult {
  readonly entries: readonly ConsoleEntry[];
  readonly totalCount: number;
}

const LEVEL_PRIORITY: Record<ConsoleLevel, number> = {
  error: 0,
  warning: 1,
  info: 2,
  debug: 3,
};

const CONSOLE_TYPE_TO_LEVEL: Record<string, ConsoleLevel> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  warn: 'warning',
  log: 'info',
  info: 'info',
  dir: 'info',
  dirxml: 'info',
  table: 'info',
  count: 'info',
  timeEnd: 'info',
  debug: 'debug',
  trace: 'debug',
  clear: 'debug',
  startGroup: 'debug',
  startGroupCollapsed: 'debug',
  endGroup: 'debug',
  profile: 'debug',
  profileEnd: 'debug',
};

const LOG_LEVEL_MAP: Record<string, ConsoleLevel> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  verbose: 'debug',
};

const DEFAULT_BUFFER = 1_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

export interface ConsoleCollectorOptions {
  /** Max entries kept per session before FIFO eviction. Default 1000. */
  readonly bufferPerSession?: number;
}

export class ConsoleCollector {
  private readonly buffers = new Map<string, ConsoleEntry[]>();
  private readonly bufferSize: number;
  private disposer: Disposable | null = null;

  constructor(cdp: CdpBackendApi, options: ConsoleCollectorOptions = {}) {
    this.bufferSize = options.bufferPerSession ?? DEFAULT_BUFFER;
    this.disposer = cdp.onAny((method, params, sessionId) => {
      if (!sessionId) return;
      switch (method) {
        case 'Runtime.consoleAPICalled':
          this.handleConsoleAPI(sessionId, params);
          break;
        case 'Runtime.exceptionThrown':
          this.handleException(sessionId, params);
          break;
        case 'Log.entryAdded':
          this.handleLogEntry(sessionId, params);
          break;
        case 'Page.frameNavigated':
          this.handleNavigation(sessionId, params);
          break;
        default:
          break;
      }
    });
  }

  dispose(): void {
    if (this.disposer) {
      this.disposer();
      this.disposer = null;
    }
    this.buffers.clear();
  }

  // ─── Query ───────────────────────────────────────────────────────

  getLogs(sessionId: string, opts: GetLogsOptions = {}): GetLogsResult {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || buffer.length === 0) return { entries: [], totalCount: 0 };
    const levelThreshold = LEVEL_PRIORITY[opts.level ?? 'info'];
    let filtered = buffer.filter((e) => LEVEL_PRIORITY[e.level] <= levelThreshold);
    if (opts.search) {
      const term = opts.search.toLowerCase();
      filtered = filtered.filter((e) => e.text.toLowerCase().includes(term));
    }
    const totalCount = filtered.length;
    const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const entries = filtered.slice(-limit);
    if (opts.clear) this.buffers.set(sessionId, []);
    return { entries, totalCount };
  }

  /** Aggregate across all sessions (use when the caller doesn't care which). */
  getAllLogs(opts: GetLogsOptions = {}): GetLogsResult {
    const combined: ConsoleEntry[] = [];
    for (const buf of this.buffers.values()) combined.push(...buf);
    combined.sort((a, b) => a.timestamp - b.timestamp);
    return this.filterAndReturn(combined, opts);
  }

  clear(sessionId?: string): void {
    if (sessionId) this.buffers.set(sessionId, []);
    else this.buffers.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private filterAndReturn(buffer: ConsoleEntry[], opts: GetLogsOptions): GetLogsResult {
    const levelThreshold = LEVEL_PRIORITY[opts.level ?? 'info'];
    let filtered = buffer.filter((e) => LEVEL_PRIORITY[e.level] <= levelThreshold);
    if (opts.search) {
      const term = opts.search.toLowerCase();
      filtered = filtered.filter((e) => e.text.toLowerCase().includes(term));
    }
    const totalCount = filtered.length;
    const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    return { entries: filtered.slice(-limit), totalCount };
  }

  private addEntry(sessionId: string, entry: ConsoleEntry): void {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(sessionId, buffer);
    }
    if (buffer.length >= this.bufferSize) buffer.shift();
    buffer.push(entry);
  }

  private handleConsoleAPI(sessionId: string, params: Readonly<Record<string, unknown>>): void {
    const type = typeof params.type === 'string' ? (params.type as string) : 'log';
    const level = CONSOLE_TYPE_TO_LEVEL[type] ?? 'info';
    const args = Array.isArray(params.args) ? (params.args as Array<Record<string, unknown>>) : [];
    const text = serializeArgs(args);
    const stack = params.stackTrace as
      | { callFrames?: Array<{ url?: string; lineNumber?: number }> }
      | undefined;
    const frame = stack?.callFrames?.[0];
    const entry: ConsoleEntry = {
      source: 'console',
      level,
      text,
      ...(frame?.url ? { url: frame.url } : {}),
      ...(typeof frame?.lineNumber === 'number' ? { lineNumber: frame.lineNumber } : {}),
      timestamp: numericTimestamp(params.timestamp),
    };
    this.addEntry(sessionId, entry);
  }

  private handleException(sessionId: string, params: Readonly<Record<string, unknown>>): void {
    const details = params.exceptionDetails as
      | {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
          stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
        }
      | undefined;
    const text = details?.exception?.description ?? details?.text ?? 'unknown exception';
    const entry: ConsoleEntry = {
      source: 'exception',
      level: 'error',
      text,
      ...(details?.url
        ? { url: details.url }
        : details?.stackTrace?.callFrames?.[0]?.url
          ? { url: details.stackTrace.callFrames[0].url }
          : {}),
      ...(typeof details?.lineNumber === 'number' ? { lineNumber: details.lineNumber } : {}),
      timestamp: numericTimestamp(params.timestamp),
    };
    this.addEntry(sessionId, entry);
  }

  private handleLogEntry(sessionId: string, params: Readonly<Record<string, unknown>>): void {
    const entryParams = params.entry as
      | { level?: string; text?: string; url?: string; lineNumber?: number; timestamp?: number }
      | undefined;
    if (!entryParams || typeof entryParams.text !== 'string') return;
    const level = LOG_LEVEL_MAP[entryParams.level ?? ''] ?? 'info';
    const entry: ConsoleEntry = {
      source: 'browser',
      level,
      text: entryParams.text,
      ...(entryParams.url ? { url: entryParams.url } : {}),
      ...(typeof entryParams.lineNumber === 'number' ? { lineNumber: entryParams.lineNumber } : {}),
      timestamp: numericTimestamp(entryParams.timestamp),
    };
    this.addEntry(sessionId, entry);
  }

  private handleNavigation(sessionId: string, params: Readonly<Record<string, unknown>>): void {
    const frame = params.frame as { parentId?: string } | undefined;
    if (!frame) return;
    if (!frame.parentId) this.buffers.set(sessionId, []);
  }
}

function serializeArgs(args: Array<Record<string, unknown>>): string {
  return args
    .map((arg) => {
      if (arg.type === 'string' && typeof arg.value === 'string') return arg.value;
      if (arg.value !== undefined) return String(arg.value);
      return (arg.description as string | undefined) ?? `[${String(arg.type)}]`;
    })
    .join(' ');
}

function numericTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // CDP timestamps are sometimes in seconds, sometimes in monotonic-ish
    // milliseconds. Anything < 10^12 we treat as seconds.
    return value > 1e12 ? value : value * 1000;
  }
  return Date.now();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
