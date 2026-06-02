/**
 * Brisk IPC protocol — JSON-line over POSIX unix socket / Windows named pipe.
 *
 * Wire format: each message is a single JSON object followed by `\n`.
 * Messages MUST NOT contain embedded newlines (the consumer splits on `\n`
 * boundaries before parsing — mirrors the MCP stdio framing rule).
 */

import type { BriskError } from './result.js';

// ─── Request types ──────────────────────────────────────────────────

/**
 * IPC requests are either:
 *   - a raw CDP passthrough (has `method`), or
 *   - a meta operation (has `meta`)
 *
 * Format-compatible with browser-harness's daemon IPC so we can
 * reuse its integration test fixtures during development.
 */
export type IpcRequest = CdpPassthroughRequest | MetaRequest;

export interface CdpPassthroughRequest {
  readonly id?: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly targetId?: string;
}

export type MetaRequest =
  | { readonly id?: number; readonly meta: 'ping' }
  | { readonly id?: number; readonly meta: 'shutdown' }
  | { readonly id?: number; readonly meta: 'connection_status' }
  | { readonly id?: number; readonly meta: 'drain_events' }
  | { readonly id?: number; readonly meta: 'session' }
  | { readonly id?: number; readonly meta: 'current_tab' }
  | {
      readonly id?: number;
      readonly meta: 'set_session';
      readonly sessionId: string;
      readonly targetId?: string;
    }
  | { readonly id?: number; readonly meta: 'pending_dialog' }
  | { readonly id?: number; readonly meta: 'attach_first_page' };

// ─── Response types ─────────────────────────────────────────────────

export type IpcResponse =
  | OkResponse
  | ErrorResponse
  | EventsResponse
  | PongResponse
  | SessionResponse
  | CurrentTabResponse
  | DialogResponse
  | ConnectionStatusResponse;

export interface OkResponse {
  readonly id?: number;
  readonly result: unknown;
}

export interface ErrorResponse {
  readonly id?: number;
  readonly error: string | BriskError;
}

export interface EventsResponse {
  readonly id?: number;
  readonly events: readonly CdpEventLog[];
}

export interface PongResponse {
  readonly id?: number;
  readonly pong: true;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: number;
}

export interface SessionResponse {
  readonly id?: number;
  readonly sessionId: string | null;
  readonly targetId: string | null;
}

export interface CurrentTabResponse {
  readonly id?: number;
  readonly targetId: string | null;
  readonly sessionId: string | null;
  readonly page: { readonly title: string; readonly url: string } | null;
}

export interface DialogResponse {
  readonly id?: number;
  readonly dialog: DialogInfo | null;
}

export interface ConnectionStatusResponse {
  readonly id?: number;
  readonly status: 'connected' | 'disconnected' | 'connecting' | 'reconnecting';
  readonly cdpEndpoint?: string;
  readonly version?: string;
  readonly userAgent?: string;
}

// ─── Domain types ───────────────────────────────────────────────────

export interface CdpEventLog {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
  readonly timestamp: number;
}

export interface DialogInfo {
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  readonly message: string;
  readonly defaultPrompt?: string;
  readonly url: string;
  readonly hasBrowserHandler: boolean;
}
