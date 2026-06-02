/**
 * CDP backend — a single long-lived WebSocket to Chrome's browser-level
 * debug endpoint, multiplexing per-session messages by `sessionId`.
 *
 * Design ported from BrowserOS apps/server/src/browser/backends/cdp.ts
 * (https://github.com/browseros/browseros, 516 lines) with three changes:
 *   1. Uses Node's built-in `globalThis.WebSocket` (Node 22+ stable) instead
 *      of Bun's runtime WebSocket. The Node implementation follows the
 *      same WHATWG spec — open/message/error/close + send + close — so
 *      the surface is identical for our purposes.
 *   2. Errors flow as `BriskError` (machine-readable code + cause chain)
 *      rather than ad-hoc `Error("...")`. Daemon code can pattern-match
 *      `e.code === 'CDP_DISCONNECTED'` to decide whether to reattach.
 *   3. Reconnect exhaustion is reported via a configurable callback
 *      instead of calling `process.exit()`. The daemon decides whether
 *      the failure is fatal (V0.1.0 default: throw upward so the
 *      MCP layer can surface it to the agent).
 *
 * Wire reference: https://chromedevtools.github.io/devtools-protocol/
 * Keepalive: Browser.getVersion (cheap, exists on every Chrome since M22).
 */

import { asBriskError, type BriskError, briskError } from '@brisk/types';

import {
  CDP_CONNECT_MAX_RETRIES,
  CDP_CONNECT_RETRY_DELAY_MS,
  CDP_CONNECT_TIMEOUT_MS,
  CDP_KEEPALIVE_INTERVAL_MS,
  CDP_KEEPALIVE_TIMEOUT_MS,
  CDP_LOOPBACK_HOSTS,
  CDP_RECONNECT_DELAY_MS,
  CDP_RECONNECT_MAX_RETRIES,
  CDP_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import type {
  BackendLogger,
  CdpAnyEventListener,
  CdpBackendApi,
  CdpBackendOptions,
  CdpEventListener,
  CdpMessage,
  CdpSessionEventListener,
  Disposable,
} from './types.js';

// ─── Sleep / logger ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

const NOOP_LOGGER: BackendLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ─── Pending request bookkeeping ───────────────────────────────

interface PendingRequest {
  readonly id: number;
  readonly method: string;
  readonly sessionId?: string;
  readonly resolve: (value: Readonly<Record<string, unknown>>) => void;
  readonly reject: (reason: BriskError) => void;
  readonly timer: NodeJS.Timeout;
}

// ─── Class ─────────────────────────────────────────────────────

export class CdpBackend implements CdpBackendApi {
  private readonly endpoint: string;
  private readonly connectMaxRetries: number;
  private readonly connectRetryDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly keepaliveTimeoutMs: number;
  private readonly reconnectMaxRetries: number;
  private readonly reconnectDelayMs: number;
  private readonly throwOnReconnectExhaustion: boolean;
  private readonly logger: BackendLogger;

  /** Active socket, or null when disconnected. */
  private ws: WebSocket | null = null;
  /** Monotonic per-backend request id. */
  private messageId = 0;
  /** id → pending request. */
  private readonly pending = new Map<number, PendingRequest>();
  /** True between successful onopen and any close. */
  private connected = false;
  /** True after `disconnect()` is called; suppresses reconnect. */
  private disconnecting = false;
  /** True for the duration of an active reconnect loop. */
  private reconnecting = false;
  /** Set when a fresh socket dies mid-reconnect — triggers another loop. */
  private reconnectRequested = false;
  /** Global-scope CDP event handlers (no sessionId). */
  private readonly eventHandlers = new Map<string, CdpEventListener[]>();
  /** Session-scoped CDP event handlers. */
  private readonly sessionEventHandlers = new Map<string, CdpSessionEventListener[]>();
  /** "Any" tap — fires on every CDP event, irrespective of method/session. */
  private readonly anyEventHandlers: CdpAnyEventListener[] = [];
  /** Keepalive timer handle. */
  private keepaliveTimer: NodeJS.Timeout | null = null;
  /**
   * Loopback host that worked last reconnect, tried first next time.
   * Mirrors BrowserOS cdp.ts:51 `preferredDiscoveryHost` but for the WS
   * URL itself — keeps reconnect fast on machines where one host is dead.
   */
  private preferredHost: string | null = null;

  constructor(options: CdpBackendOptions) {
    this.endpoint = options.endpoint;
    this.connectMaxRetries = options.connectMaxRetries ?? CDP_CONNECT_MAX_RETRIES;
    this.connectRetryDelayMs = options.connectRetryDelayMs ?? CDP_CONNECT_RETRY_DELAY_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CDP_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? CDP_REQUEST_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? CDP_KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimeoutMs = options.keepaliveTimeoutMs ?? CDP_KEEPALIVE_TIMEOUT_MS;
    this.reconnectMaxRetries = options.reconnectMaxRetries ?? CDP_RECONNECT_MAX_RETRIES;
    this.reconnectDelayMs = options.reconnectDelayMs ?? CDP_RECONNECT_DELAY_MS;
    this.throwOnReconnectExhaustion = options.throwOnReconnectExhaustion ?? true;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async connect(): Promise<void> {
    let lastErr: BriskError | undefined;
    for (let attempt = 1; attempt <= this.connectMaxRetries; attempt++) {
      try {
        await this.attemptConnect();
        this.startKeepalive();
        return;
      } catch (err) {
        lastErr = asBriskError(err, 'CDP_NOT_CONNECTED');
        this.logger.warn(
          `CDP connect attempt ${attempt}/${this.connectMaxRetries} failed: ${lastErr.message}`,
        );
        if (attempt < this.connectMaxRetries) {
          await sleep(this.connectRetryDelayMs);
        }
      }
    }
    throw briskError(
      'CDP_NOT_CONNECTED',
      `CDP connect failed after ${this.connectMaxRetries} attempts: ${lastErr?.message ?? 'unknown error'}`,
      lastErr ? { cause: lastErr } : {},
    );
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed
      }
      this.ws = null;
      this.connected = false;
    }
    this.rejectPendingRequests(briskError('CDP_DISCONNECTED', 'CDP backend disconnected by user'));
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Send ────────────────────────────────────────────────────

  send<T = Readonly<Record<string, unknown>>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    return this.rawSend(method, params) as Promise<T>;
  }

  sendOnSession<T = Readonly<Record<string, unknown>>>(
    sessionId: string,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    if (method.startsWith('Target.')) {
      // Browser-level Target.* call with a session attached returns the
      // browser target — never what the caller wants. See
      // browser-harness/daemon.py:343-347 for the full footgun story.
      return Promise.reject(
        briskError(
          'CDP_PROTOCOL_ERROR',
          `Target.* methods must be sent without a sessionId; got method=${method}, sessionId=${sessionId}`,
        ),
      );
    }
    return this.rawSend(method, params, sessionId) as Promise<T>;
  }

  // ─── Events ──────────────────────────────────────────────────

  on(method: string, listener: CdpEventListener): Disposable {
    return registerListener(this.eventHandlers, method, listener);
  }

  onSession(method: string, listener: CdpSessionEventListener): Disposable {
    return registerListener(this.sessionEventHandlers, method, listener);
  }

  onAny(listener: CdpAnyEventListener): Disposable {
    this.anyEventHandlers.push(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const idx = this.anyEventHandlers.indexOf(listener);
      if (idx >= 0) this.anyEventHandlers.splice(idx, 1);
    };
  }

  // ─── Implementation ──────────────────────────────────────────

  private async attemptConnect(): Promise<void> {
    const wsUrl = this.resolveWebSocketUrl(this.endpoint);
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(
          briskError(
            'CDP_TIMEOUT',
            `CDP WebSocket connect timeout after ${this.connectTimeoutMs}ms (url=${wsUrl})`,
          ),
        );
      }, this.connectTimeoutMs);
      timer.unref?.();

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opened = true;
        this.ws = ws;
        this.connected = true;
        this.disconnecting = false;
        resolve();
      });

      ws.addEventListener('error', (ev) => {
        // WHATWG-spec error events carry no detail; we serialize what we can.
        const evMessage =
          typeof (ev as { message?: unknown }).message === 'string'
            ? (ev as { message: string }).message
            : 'unknown error';
        if (!opened && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            briskError('CDP_PROTOCOL_ERROR', `CDP WebSocket error during connect: ${evMessage}`),
          );
        }
      });

      ws.addEventListener('close', (ev) => {
        clearTimeout(timer);
        // Stale close from a previous (replaced) socket → ignore.
        if (this.ws !== ws) return;
        this.connected = false;
        this.ws = null;
        const closeMsg = describeCloseEvent(ev);
        if (opened) {
          this.handleUnexpectedClose(closeMsg);
        } else if (!settled) {
          settled = true;
          reject(briskError('CDP_PROTOCOL_ERROR', `CDP WebSocket closed before open: ${closeMsg}`));
        }
      });

      ws.addEventListener('message', (ev) => {
        // Node's WebSocket delivers text messages as string; binary as
        // ArrayBuffer. CDP is text-only, so we cast and bail on binary.
        const data = ev.data;
        if (typeof data === 'string') {
          this.handleMessage(data);
        } else {
          this.logger.warn('CDP received non-string message; dropping');
        }
      });
    });
  }

  private resolveWebSocketUrl(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      if (this.preferredHost) {
        url.hostname = stripBrackets(this.preferredHost);
      }
      return url.toString();
    } catch {
      return endpoint;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      void this.keepalivePing();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private async keepalivePing(): Promise<void> {
    if (!this.ws || !this.connected || this.disconnecting) return;
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.rawSend('Browser.getVersion'),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(briskError('CDP_TIMEOUT', 'CDP keepalive timeout')),
            this.keepaliveTimeoutMs,
          );
          timeoutId.unref?.();
        }),
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      this.logger.warn(`CDP keepalive failed: ${(err as Error).message}`);
      this.handleDeadConnection();
    }
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Force-close a zombie WebSocket that stopped responding but never fired
   * onclose. Triggers the normal reconnection path via handleUnexpectedClose.
   * Mirrors BrowserOS cdp.ts:259-274.
   */
  private handleDeadConnection(): void {
    if (this.disconnecting || this.reconnecting) return;
    this.stopKeepalive();
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.handleUnexpectedClose('keepalive timeout');
  }

  private handleUnexpectedClose(reason: string): void {
    if (this.disconnecting) return;
    this.stopKeepalive();
    this.rejectPendingRequests(briskError('CDP_DISCONNECTED', `CDP WebSocket closed: ${reason}`));
    if (this.reconnecting) {
      // A freshly-opened socket closed before the previous reconnect loop
      // returned. Queue another reconnect so we don't fall into a dead
      // state. Mirrors BrowserOS cdp.ts:284-288.
      this.reconnectRequested = true;
      this.logger.warn('CDP closed while reconnecting, queueing another reconnect');
      return;
    }
    this.logger.error(`CDP closed unexpectedly: ${reason}; reconnecting...`);
    this.reconnecting = true;
    this.reconnectRequested = false;
    this.reconnectLoop().finally(() => {
      this.reconnecting = false;
    });
  }

  private async reconnectLoop(): Promise<void> {
    do {
      this.reconnectRequested = false;
      const ok = await this.reconnectWithRetries();
      if (!ok) return;
    } while (!this.disconnecting && (this.reconnectRequested || !this.connected));
  }

  private async reconnectWithRetries(): Promise<boolean> {
    let lastErr: BriskError | undefined;
    for (let attempt = 1; attempt <= this.reconnectMaxRetries; attempt++) {
      if (this.disconnecting) return false;
      try {
        this.logger.info(`CDP reconnect attempt ${attempt}/${this.reconnectMaxRetries}...`);
        await sleep(this.reconnectDelayMs);
        // Try preferred host first, then cycle through known loopback hosts
        // so reconnect survives a flapping IPv4/IPv6 stack.
        await this.attemptConnectWithLoopbackFallback();
        this.startKeepalive();
        this.logger.info('CDP reconnected');
        return true;
      } catch (err) {
        lastErr = asBriskError(err, 'CDP_DISCONNECTED');
        this.logger.warn(
          `CDP reconnect attempt ${attempt}/${this.reconnectMaxRetries} failed: ${lastErr.message}`,
        );
      }
    }
    const msg = `CDP reconnect failed after ${this.reconnectMaxRetries} attempts: ${lastErr?.message ?? 'unknown'}`;
    this.logger.error(msg);
    if (this.throwOnReconnectExhaustion) {
      throw briskError('CDP_DISCONNECTED', msg, lastErr ? { cause: lastErr } : {});
    }
    return false;
  }

  private async attemptConnectWithLoopbackFallback(): Promise<void> {
    const hostsToTry = this.preferredHost
      ? [this.preferredHost, ...CDP_LOOPBACK_HOSTS.filter((h) => h !== this.preferredHost)]
      : [...CDP_LOOPBACK_HOSTS];

    let lastErr: BriskError | undefined;
    for (const host of hostsToTry) {
      try {
        await this.attemptConnectOnHost(host);
        this.preferredHost = host;
        return;
      } catch (err) {
        lastErr = asBriskError(err, 'CDP_NOT_CONNECTED');
        this.logger.debug(`CDP host ${host} failed: ${lastErr.message}`);
      }
    }
    throw lastErr ?? briskError('CDP_NOT_CONNECTED', 'No loopback host responded');
  }

  private async attemptConnectOnHost(host: string): Promise<void> {
    const original = this.preferredHost;
    this.preferredHost = host;
    try {
      await this.attemptConnect();
    } finally {
      // Restore on failure; success path will overwrite via preferredHost = host.
      if (!this.connected) this.preferredHost = original;
    }
  }

  private rejectPendingRequests(error: BriskError): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pending.clear();
  }

  // ─── Wire ────────────────────────────────────────────────────

  private rawSend(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.ws || !this.connected) {
      return Promise.reject(
        briskError('CDP_NOT_CONNECTED', `Cannot send ${method}: CDP backend is not connected`),
      );
    }
    const id = ++this.messageId;
    const message: Record<string, unknown> = {
      id,
      method,
      params: params ?? {},
    };
    if (sessionId !== undefined) message.sessionId = sessionId;

    const ws = this.ws;
    return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          briskError(
            'CDP_TIMEOUT',
            `CDP request timeout: ${method} (id=${id}) after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        id,
        method,
        ...(sessionId !== undefined ? { sessionId } : {}),
        resolve,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          briskError(
            'CDP_PROTOCOL_ERROR',
            `CDP send failed for ${method}: ${(err as Error).message}`,
            { cause: err as Error },
          ),
        );
        // send() failure means the socket is dead — trigger reconnect.
        this.handleDeadConnection();
      }
    });
  }

  private handleMessage(data: string): void {
    let parsed: CdpMessage;
    try {
      parsed = JSON.parse(data) as CdpMessage;
    } catch (err) {
      this.logger.error(`CDP message JSON parse failed: ${(err as Error).message}`);
      return;
    }

    if ('id' in parsed && typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        // Unmatched id — could be a late response after timeout, or our
        // counter overflowed (unlikely). Log + drop.
        this.logger.debug(`CDP response for unknown id ${parsed.id}`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if ('error' in parsed) {
        pending.reject(
          briskError(
            classifyCdpProtocolError(parsed.error),
            `${parsed.error.message} (method=${pending.method}, code=${parsed.error.code})`,
            { details: { ...parsed.error, briskMethod: pending.method } },
          ),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if ('method' in parsed && typeof parsed.method === 'string') {
      const params = (parsed.params ?? {}) as Readonly<Record<string, unknown>>;
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;

      const globalHandlers = this.eventHandlers.get(parsed.method);
      if (globalHandlers) {
        for (const h of globalHandlers) {
          safeInvoke(h, params, this.logger);
        }
      }
      if (sessionId !== undefined) {
        const sessionHandlers = this.sessionEventHandlers.get(parsed.method);
        if (sessionHandlers) {
          for (const h of sessionHandlers) {
            safeInvokeSession(h, params, sessionId, this.logger);
          }
        }
      }
      if (this.anyEventHandlers.length > 0) {
        // Snapshot length so handlers added during dispatch don't fire this round.
        const n = this.anyEventHandlers.length;
        for (let i = 0; i < n; i++) {
          const h = this.anyEventHandlers[i];
          if (h !== undefined) safeInvokeAny(h, parsed.method, params, sessionId, this.logger);
        }
      }
    }
  }
}

// ─── Module helpers ────────────────────────────────────────────

function registerListener<L>(map: Map<string, L[]>, method: string, listener: L): Disposable {
  const list = map.get(method) ?? [];
  list.push(listener);
  map.set(method, list);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const arr = map.get(method);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) map.delete(method);
  };
}

function safeInvoke(
  listener: CdpEventListener,
  params: Readonly<Record<string, unknown>>,
  logger: BackendLogger,
): void {
  try {
    listener(params);
  } catch (err) {
    logger.error(`CDP event listener threw: ${(err as Error).message}`);
  }
}

function safeInvokeSession(
  listener: CdpSessionEventListener,
  params: Readonly<Record<string, unknown>>,
  sessionId: string,
  logger: BackendLogger,
): void {
  try {
    listener(params, sessionId);
  } catch (err) {
    logger.error(`CDP session event listener threw: ${(err as Error).message}`);
  }
}

function safeInvokeAny(
  listener: CdpAnyEventListener,
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
  logger: BackendLogger,
): void {
  try {
    listener(method, params, sessionId);
  } catch (err) {
    logger.error(`CDP any-event listener threw on ${method}: ${(err as Error).message}`);
  }
}

function describeCloseEvent(ev: unknown): string {
  if (typeof ev !== 'object' || ev === null) return 'unknown close';
  const e = ev as { code?: number; reason?: string; wasClean?: boolean };
  const parts: string[] = [];
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.reason) parts.push(`reason=${e.reason}`);
  if (e.wasClean !== undefined) parts.push(`wasClean=${e.wasClean}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown close';
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * CDP protocol-level error codes (JSON-RPC error.code) → BriskError code.
 * Codes documented at https://chromedevtools.github.io/devtools-protocol/
 * (Error responses section).
 */
function classifyCdpProtocolError(error: { code: number; message: string }) {
  const msg = error.message?.toLowerCase() ?? '';
  if (msg.includes('session with given id not found')) return 'CDP_SESSION_NOT_FOUND' as const;
  if (msg.includes('target with given id not found')) return 'CDP_TARGET_NOT_FOUND' as const;
  return 'CDP_PROTOCOL_ERROR' as const;
}
