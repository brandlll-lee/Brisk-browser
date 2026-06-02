/**
 * Internal CDP wire types used by brisk-core/cdp/*.
 *
 * The cross-package types (CdpEndpoint, CdpTarget, CdpSession, etc.) live
 * in @brisk/types/cdp — re-exported below for convenience. The types in
 * this file are implementation-detail and don't cross the package seam.
 *
 * CDP wire reference:
 *   https://chromedevtools.github.io/devtools-protocol/
 *
 * Each message in JSON-RPC 2.0-ish form:
 *   request:  { id, method, params?, sessionId? }
 *   response: { id, result | error, sessionId? }
 *   event:    { method, params, sessionId? }
 *
 * `flatten: true` mode (Target.attachToTarget) routes session messages
 * through the parent socket via sessionId — vs. spawning a new WebSocket
 * per session. Modern CDP defaults to flat; non-flat is deprecated
 * (https://crbug.com/991325).
 */

export type {
  AttachOptions,
  CdpEndpoint,
  CdpProtocolError,
  CdpSession,
  CdpTarget,
  CdpTargetType,
  PageInfoResult,
  ScreenshotOptions,
} from '@brisk/types/cdp';

import type { CdpProtocolError } from '@brisk/types/cdp';

// ─── Wire types ────────────────────────────────────────────────────

export interface CdpRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface CdpSuccessResponse {
  readonly id: number;
  readonly result: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface CdpErrorResponse {
  readonly id: number;
  readonly error: CdpProtocolError;
  readonly sessionId?: string;
}

export type CdpResponse = CdpSuccessResponse | CdpErrorResponse;

export interface CdpEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export type CdpMessage = CdpResponse | CdpEvent;

// ─── Handler types ────────────────────────────────────────────────

/**
 * Disposable returned from `on()` — call it to detach the listener.
 * Idempotent; calling twice is a no-op.
 */
export type Disposable = () => void;

export type CdpEventListener = (params: Readonly<Record<string, unknown>>) => void;

export type CdpSessionEventListener = (
  params: Readonly<Record<string, unknown>>,
  sessionId: string,
) => void;

/**
 * Listener for ALL CDP events, regardless of method or session scope.
 *
 * Used by the daemon's event tap (see browser-harness daemon.py:248-259
 * for the equivalent — they monkey-patch `_event_registry.handle_event`).
 * Avoid this in helpers: prefer the per-method `on`/`onSession` so the
 * tap doesn't see noise it doesn't care about.
 */
export type CdpAnyEventListener = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
) => void;

// ─── Backend interface ────────────────────────────────────────────

/**
 * Public surface of the CDP backend. Daemon, helpers, and tests depend
 * on this — not on the concrete class — so we can swap implementations
 * (e.g. in-process mock for tests, BrowserOS-style "embedded Chrome
 * subprocess" backend later) without rippling changes.
 */
export interface CdpBackendApi {
  /**
   * Open the WebSocket + start keepalive. Resolves once the socket is
   * open and ready. Throws BriskError on connect failure after the
   * configured retry count.
   */
  connect(): Promise<void>;

  /**
   * Close the WebSocket + stop keepalive + reject all pending requests.
   * Idempotent.
   */
  disconnect(): Promise<void>;

  /** Whether the backend is currently connected to the browser. */
  isConnected(): boolean;

  /**
   * Send a CDP method on the browser-level connection (no sessionId).
   * Used for `Target.*`, `Browser.*` commands.
   */
  send<T = Readonly<Record<string, unknown>>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<T>;

  /**
   * Send a CDP method on a specific session (use after Target.attachToTarget).
   * `Target.*` methods MUST use `send` (no session) — Chrome silently
   * returns the browser target if a session is attached, which is a
   * common footgun documented in browser-harness/daemon.py:343-347.
   */
  sendOnSession<T = Readonly<Record<string, unknown>>>(
    sessionId: string,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<T>;

  /** Subscribe to a browser-level CDP event. Returns disposer. */
  on(method: string, listener: CdpEventListener): Disposable;

  /** Subscribe to a session-scoped CDP event (listener receives sessionId). */
  onSession(method: string, listener: CdpSessionEventListener): Disposable;

  /**
   * Subscribe to EVERY CDP event (both global and session-scoped) — the
   * daemon-grade tap. Returns disposer. Fired alongside per-method `on`
   * and `onSession` listeners; order is global-listeners-first, then any.
   */
  onAny(listener: CdpAnyEventListener): Disposable;
}

// ─── Construction options ─────────────────────────────────────────

export interface CdpBackendOptions {
  /**
   * Either:
   *  - Full WebSocket URL (e.g. ws://127.0.0.1:9222/devtools/browser/<uuid>)
   *  - Result of `discoverCdpEndpoint()` (CdpEndpoint)
   *
   * If a string, the host is preserved (we don't re-discover loopback hosts).
   * If a CdpEndpoint, we may rewrite the host during reconnect attempts so
   * a flapping IPv4/IPv6 stack still works — matches BrowserOS cdp.ts:144-154.
   */
  readonly endpoint: string;

  /**
   * Optional connect-time retry override.
   * Defaults: see constants.ts.
   */
  readonly connectMaxRetries?: number;
  readonly connectRetryDelayMs?: number;
  readonly connectTimeoutMs?: number;

  /** Request timeout override. */
  readonly requestTimeoutMs?: number;

  /** Keepalive overrides. */
  readonly keepaliveIntervalMs?: number;
  readonly keepaliveTimeoutMs?: number;

  /** Reconnect overrides. */
  readonly reconnectMaxRetries?: number;
  readonly reconnectDelayMs?: number;

  /**
   * If true and reconnect fails after max retries, log + throw rather than
   * silently giving up. Default: true. Set false in long-running daemons
   * that want to expose health via /healthz.
   */
  readonly throwOnReconnectExhaustion?: boolean;

  /**
   * Logger sink. Defaults to a no-op so the same backend works inside an
   * MCP-over-stdio process (where console output corrupts the protocol).
   */
  readonly logger?: BackendLogger;
}

export interface BackendLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
