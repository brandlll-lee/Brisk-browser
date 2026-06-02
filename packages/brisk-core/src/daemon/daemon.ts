/**
 * Daemon — in-memory state holder over a CdpBackend.
 *
 * Wraps a single connected CdpBackend with:
 *   • the active page session  (sessionId, targetId)
 *   • a rolling event tap      (RingBuffer<CdpEventLog>)
 *   • the currently-open native dialog (alert/confirm/prompt/beforeunload)
 *   • a JSON-line `handle(req)` entry that mirrors the browser-harness
 *     IPC daemon — so the same wire shape works whether we serve it
 *     over MCP, IPC, or in-process direct calls.
 *
 * NOT a process — that's `DaemonServer` (server.ts) which wires this
 * class to an `@brisk/ipc` listener. Keeping the state machine separate
 * from transport keeps it unit-testable with a plain mock backend.
 *
 * Lineage: browser-harness daemon.py Daemon class (lines 182-356).
 * Deliberately leaner: no token-guard (IPC layer enforces),
 * no ping (IPC pingIpc handles), no `set_session`+`Network.disable`
 * concurrency dance for in-process callers (helpers can do their own
 * sequencing without the 5-second IPC budget).
 */

import {
  asBriskError,
  type BriskError,
  briskError,
  type CdpEventLog,
  type ConnectionStatusResponse,
  type CurrentTabResponse,
  type DialogInfo,
  type DialogResponse,
  type ErrorResponse,
  type EventsResponse,
  type IpcRequest,
  type IpcResponse,
  isBriskError,
  type OkResponse,
  type PongResponse,
  type SessionResponse,
} from '@brisk/types';

import type { BackendLogger, CdpBackendApi, Disposable } from '../cdp/types.js';
import {
  ConsoleCollector,
  type ConsoleCollectorOptions,
  type GetLogsOptions,
  type GetLogsResult,
} from '../console/collector.js';
import { attachFirstPage, disableOldSessionNetwork, enableDefaultDomains } from './attach.js';
import { RingBuffer } from './buffer.js';

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_EVENT_BUFFER = 500;
const DEFAULT_VERSION = '0.1.0';

/**
 * 🐴 ZWJ-safe tab-marker prefix. Same emoji browser-harness uses
 * (daemon.py:249) so users see a familiar marker if they migrate.
 */
const TAB_MARKER = '\u{1F434}';
const TAB_MARK_JS = `if(!document.title.startsWith('${TAB_MARKER}'))document.title='${TAB_MARKER} '+document.title`;

// ─── Options ────────────────────────────────────────────────────────

export interface DaemonOptions {
  /** Max events to buffer between drains. Default 500. */
  readonly eventBufferSize?: number;

  /** Whether to prefix the tab title with 🐴 so the user can see it's attached. */
  readonly markTabs?: boolean;

  /**
   * Version string returned by `meta: 'ping'`. Lets clients verify
   * compatibility before sending CDP commands.
   */
  readonly version?: string;

  /**
   * Auto-recover from stale-session errors by re-attaching to the first
   * page. Mirrors browser-harness daemon.py:352-355. Default: true.
   * Set false for hermetic tests that want to assert the exact error.
   */
  readonly autoReattachOnStaleSession?: boolean;

  /** Logger sink. Defaults to no-op (safe for MCP stdio mode). */
  readonly logger?: BackendLogger;

  /** ConsoleCollector tuning. */
  readonly console?: ConsoleCollectorOptions;
}

// ─── Class ───────────────────────────────────────────────────────────

const NOOP_LOGGER: BackendLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class Daemon {
  private readonly cdp: CdpBackendApi;
  private readonly events: RingBuffer<CdpEventLog>;
  private readonly version: string;
  private readonly markTabs: boolean;
  private readonly autoReattach: boolean;
  private readonly logger: BackendLogger;
  private readonly startedAt: number;

  /** Active page session id, or null when detached. */
  private sessionId: string | null = null;
  /** Active page target id, or null when detached. */
  private targetId: string | null = null;
  /** Currently-open JS dialog, or null. */
  private dialog: DialogInfo | null = null;

  private eventTapDisposer: Disposable | null = null;
  private readonly consoleCollector: ConsoleCollector;
  private started = false;
  private stopped = false;

  constructor(cdp: CdpBackendApi, options: DaemonOptions = {}) {
    this.cdp = cdp;
    this.events = new RingBuffer<CdpEventLog>(options.eventBufferSize ?? DEFAULT_EVENT_BUFFER);
    this.version = options.version ?? DEFAULT_VERSION;
    this.markTabs = options.markTabs ?? true;
    this.autoReattach = options.autoReattachOnStaleSession ?? true;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.startedAt = Date.now();
    this.consoleCollector = new ConsoleCollector(cdp, options.console ?? {});
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Bring the daemon up: attach to a real page and start the event tap.
   *
   * Throws if no real page can be attached AND auto-create fails (e.g.
   * Chrome dropped the socket mid-attach). Idempotent: calling twice
   * just refreshes the attached target.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw briskError('CDP_NOT_CONNECTED', 'Daemon already stopped; create a new instance');
    }
    if (!this.started) {
      this.installEventTap();
      this.started = true;
    }

    await this.attachFirstRealPage();
  }

  /**
   * Tear down: dispose the event tap, drop session refs. Does NOT
   * disconnect the underlying CdpBackend — the caller may want to
   * reuse it (e.g. swap to a fresh daemon). Idempotent.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.eventTapDisposer) {
      this.eventTapDisposer();
      this.eventTapDisposer = null;
    }
    this.consoleCollector.dispose();
    this.events.clear();
    this.sessionId = null;
    this.targetId = null;
    this.dialog = null;
  }

  // ─── Console ───────────────────────────────────────────────────

  /**
   * Fetch console / exception / browser-log entries collected for a
   * session. Pass `null` (or omit) to aggregate across every active
   * session in the daemon — useful when the agent doesn't know which
   * frame produced the log.
   */
  getConsoleLogs(sessionId: string | null | undefined, opts: GetLogsOptions = {}): GetLogsResult {
    if (sessionId) return this.consoleCollector.getLogs(sessionId, opts);
    return this.consoleCollector.getAllLogs(opts);
  }

  /** Clear the buffered console output for a session (or all if omitted). */
  clearConsoleLogs(sessionId?: string): void {
    this.consoleCollector.clear(sessionId);
  }

  // ─── Public state accessors ──────────────────────────────────────

  /** Get + clear the buffered event log. */
  drainEvents(): readonly CdpEventLog[] {
    return this.events.drain();
  }

  /** Snapshot the buffered events without clearing. */
  snapshotEvents(): readonly CdpEventLog[] {
    return this.events.snapshot();
  }

  /** Currently-open native dialog, or null. */
  getPendingDialog(): DialogInfo | null {
    return this.dialog;
  }

  /** Active session ids. */
  getSession(): { readonly sessionId: string | null; readonly targetId: string | null } {
    return { sessionId: this.sessionId, targetId: this.targetId };
  }

  // ─── Re-attach ───────────────────────────────────────────────────

  /**
   * Re-run attach. Used internally by stale-session recovery and by
   * the `meta: 'attach_first_page'` IPC request.
   */
  async attachFirstRealPage(): Promise<void> {
    const res = await attachFirstPage(this.cdp);
    if (!res.ok) throw res.error;
    this.sessionId = res.value.sessionId;
    this.targetId = res.value.targetId;
    await enableDefaultDomains(this.cdp, this.sessionId, 4000, this.logger);
    this.fireAndForgetMarkTab(this.sessionId);
    this.logger.info(
      `Daemon attached target=${this.targetId} session=${this.sessionId} url=${trim(res.value.url, 80)}`,
    );
  }

  // ─── In-process CDP helper ───────────────────────────────────────

  /**
   * In-process shortcut to send a CDP method through the same dispatch
   * path as `handle({ method, ... })` — i.e. with stale-session recovery,
   * Target.* guards, and default sessionId injection. Unwraps the
   * IpcResponse for ergonomic helper code.
   *
   * Helpers (brisk-core/helpers/*) prefer this over reaching into
   * cdp.sendOnSession directly so the recovery semantics stay in one
   * place — daemon.handle.
   */
  async callCdp<T = Readonly<Record<string, unknown>>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<T> {
    const req: IpcRequest =
      sessionId !== undefined
        ? { method, ...(params !== undefined ? { params } : {}), sessionId }
        : { method, ...(params !== undefined ? { params } : {}) };
    const resp = await this.handle(req);
    if ('error' in resp) {
      const e = resp.error;
      if (isBriskError(e)) throw e;
      throw briskError('CDP_PROTOCOL_ERROR', typeof e === 'string' ? e : 'Unknown CDP error');
    }
    if ('result' in resp) return resp.result as T;
    throw briskError('CDP_PROTOCOL_ERROR', `callCdp: unexpected response shape for ${method}`);
  }

  // ─── IPC entry ───────────────────────────────────────────────────

  /**
   * Main dispatch — equivalent to browser-harness daemon.py:261-356.
   *
   * Returns an `IpcResponse`. NEVER throws; protocol-level errors are
   * surfaced as `ErrorResponse`. This contract is what lets the IPC
   * server be a thin shell that just writes the JSON to the socket.
   */
  async handle(req: IpcRequest): Promise<IpcResponse> {
    try {
      if ('meta' in req) {
        return await this.handleMeta(req);
      }
      return await this.handleCdpPassthrough(req);
    } catch (cause) {
      const e = asBriskError(cause, 'CDP_PROTOCOL_ERROR');
      this.logger.warn(`daemon handle failed: ${e.code}: ${e.message}`);
      return makeError(req.id, e);
    }
  }

  // ─── Meta dispatch ───────────────────────────────────────────────

  private async handleMeta(req: Extract<IpcRequest, { meta: string }>): Promise<IpcResponse> {
    switch (req.meta) {
      case 'ping':
        return this.handlePing(req.id);
      case 'drain_events':
        return this.handleDrainEvents(req.id);
      case 'session':
        return this.handleSession(req.id);
      case 'current_tab':
        return this.handleCurrentTab(req.id);
      case 'connection_status':
        return this.handleConnectionStatus(req.id);
      case 'pending_dialog':
        return this.handlePendingDialog(req.id);
      case 'attach_first_page':
        return this.handleAttachFirstPage(req.id);
      case 'set_session':
        return this.handleSetSession(req);
      case 'shutdown':
        return this.handleShutdown(req.id);
      default: {
        const _exhaustive: never = req;
        void _exhaustive;
        return makeError(
          undefined,
          briskError(
            'IPC_PROTOCOL_ERROR',
            `Unknown meta operation: ${(req as { meta: string }).meta}`,
          ),
        );
      }
    }
  }

  private handlePing(id: number | undefined): PongResponse {
    return {
      ...(id !== undefined ? { id } : {}),
      pong: true,
      pid: process.pid,
      version: this.version,
      startedAt: this.startedAt,
    };
  }

  private handleDrainEvents(id: number | undefined): EventsResponse {
    return {
      ...(id !== undefined ? { id } : {}),
      events: this.events.drain(),
    };
  }

  private handleSession(id: number | undefined): SessionResponse {
    return {
      ...(id !== undefined ? { id } : {}),
      sessionId: this.sessionId,
      targetId: this.targetId,
    };
  }

  private async handleCurrentTab(id: number | undefined): Promise<IpcResponse> {
    if (!this.targetId) {
      return makeError(id, briskError('HELPER_NO_ACTIVE_PAGE', 'Daemon is not attached to a tab'));
    }
    try {
      const info = await this.cdp.send<{
        targetInfo: { targetId: string; url?: string; title?: string };
      }>('Target.getTargetInfo', { targetId: this.targetId });
      const ti = info.targetInfo;
      const resp: CurrentTabResponse = {
        ...(id !== undefined ? { id } : {}),
        targetId: ti.targetId,
        sessionId: this.sessionId,
        page: { title: ti.title ?? '', url: ti.url ?? '' },
      };
      return resp;
    } catch (cause) {
      return makeError(id, asBriskError(cause, 'CDP_DISCONNECTED'));
    }
  }

  private async handleConnectionStatus(id: number | undefined): Promise<IpcResponse> {
    if (!this.cdp.isConnected()) {
      const resp: ConnectionStatusResponse = {
        ...(id !== undefined ? { id } : {}),
        status: 'disconnected',
      };
      return resp;
    }
    if (!this.targetId) {
      const resp: ConnectionStatusResponse = {
        ...(id !== undefined ? { id } : {}),
        status: 'connected',
      };
      return resp;
    }
    try {
      const v = await this.cdp.send<{ product?: string; userAgent?: string }>('Browser.getVersion');
      const resp: ConnectionStatusResponse = {
        ...(id !== undefined ? { id } : {}),
        status: 'connected',
        ...(typeof v.product === 'string' ? { version: v.product } : {}),
        ...(typeof v.userAgent === 'string' ? { userAgent: v.userAgent } : {}),
      };
      return resp;
    } catch (cause) {
      return makeError(id, asBriskError(cause, 'CDP_DISCONNECTED'));
    }
  }

  private handlePendingDialog(id: number | undefined): DialogResponse {
    return {
      ...(id !== undefined ? { id } : {}),
      dialog: this.dialog,
    };
  }

  private async handleAttachFirstPage(id: number | undefined): Promise<IpcResponse> {
    try {
      await this.attachFirstRealPage();
      const resp: SessionResponse = {
        ...(id !== undefined ? { id } : {}),
        sessionId: this.sessionId,
        targetId: this.targetId,
      };
      return resp;
    } catch (cause) {
      return makeError(id, asBriskError(cause, 'CDP_PROTOCOL_ERROR'));
    }
  }

  private async handleSetSession(
    req: Extract<IpcRequest, { meta: 'set_session' }>,
  ): Promise<IpcResponse> {
    const oldSession = this.sessionId;
    const newSession = req.sessionId;
    this.sessionId = newSession;
    if (req.targetId) this.targetId = req.targetId;

    // Parallel: disable old session's Network + enable new session's domains.
    // Keeps the IPC-level wall clock close to a single CDP round trip even
    // on a remote daemon (browser-harness daemon.py:309-328).
    const tasks: Promise<unknown>[] = [];
    if (oldSession && oldSession !== newSession) {
      tasks.push(disableOldSessionNetwork(this.cdp, oldSession, 2000, this.logger));
    }
    tasks.push(enableDefaultDomains(this.cdp, newSession, 4000, this.logger));
    await Promise.all(tasks);

    this.fireAndForgetMarkTab(newSession);

    const resp: SessionResponse = {
      ...(req.id !== undefined ? { id: req.id } : {}),
      sessionId: this.sessionId,
      targetId: this.targetId,
    };
    return resp;
  }

  private handleShutdown(id: number | undefined): OkResponse {
    this.shutdown();
    return {
      ...(id !== undefined ? { id } : {}),
      result: { ok: true },
    };
  }

  // ─── CDP passthrough ─────────────────────────────────────────────

  private async handleCdpPassthrough(
    req: Extract<IpcRequest, { method: string }>,
  ): Promise<IpcResponse> {
    const { method, params } = req;
    // Browser-level Target.* calls MUST NOT carry a session id — see
    // attach.ts comment + backend.ts sendOnSession guard for the
    // full footgun rationale.
    const explicit = req.sessionId;
    const sid: string | undefined = method.startsWith('Target.')
      ? undefined
      : (explicit ?? this.sessionId ?? undefined);

    try {
      const result =
        sid !== undefined
          ? await this.cdp.sendOnSession(sid, method, params)
          : await this.cdp.send(method, params);
      return makeOk(req.id, result);
    } catch (cause) {
      const err = asBriskError(cause, 'CDP_PROTOCOL_ERROR');
      // Stale-session auto-recovery — see daemon.py:352-355.
      const usedDefaultSession = sid !== undefined && sid === this.sessionId;
      if (this.autoReattach && err.code === 'CDP_SESSION_NOT_FOUND' && usedDefaultSession) {
        this.logger.warn(`stale session ${sid}, re-attaching first page`);
        try {
          await this.attachFirstRealPage();
          const fresh = this.sessionId;
          if (fresh === null) return makeError(req.id, err);
          const result = await this.cdp.sendOnSession(fresh, method, params);
          return makeOk(req.id, result);
        } catch (recover) {
          return makeError(req.id, asBriskError(recover, 'CDP_PROTOCOL_ERROR'));
        }
      }
      return makeError(req.id, err);
    }
  }

  // ─── Event tap ───────────────────────────────────────────────────

  private installEventTap(): void {
    this.eventTapDisposer = this.cdp.onAny((method, params, sessionId) => {
      const entry: CdpEventLog = {
        method,
        params,
        ...(sessionId !== undefined ? { sessionId } : {}),
        timestamp: Date.now(),
      };
      this.events.push(entry);

      if (method === 'Page.javascriptDialogOpening') {
        this.dialog = this.coerceDialog(params);
      } else if (method === 'Page.javascriptDialogClosed') {
        this.dialog = null;
      } else if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') {
        // Async mark-tab refresh; ignore failure.
        if (this.markTabs && this.sessionId !== null) {
          this.fireAndForgetMarkTab(this.sessionId);
        }
      }
    });
  }

  private coerceDialog(params: Readonly<Record<string, unknown>>): DialogInfo | null {
    const type = params.type;
    const message = params.message;
    if (
      (type === 'alert' || type === 'confirm' || type === 'prompt' || type === 'beforeunload') &&
      typeof message === 'string'
    ) {
      const dlg: DialogInfo = {
        type,
        message,
        url: typeof params.url === 'string' ? params.url : '',
        hasBrowserHandler:
          typeof params.hasBrowserHandler === 'boolean' ? params.hasBrowserHandler : false,
        ...(typeof params.defaultPrompt === 'string'
          ? { defaultPrompt: params.defaultPrompt }
          : {}),
      };
      return dlg;
    }
    return null;
  }

  private fireAndForgetMarkTab(sessionId: string): void {
    if (!this.markTabs) return;
    void this.cdp
      .sendOnSession(sessionId, 'Runtime.evaluate', { expression: TAB_MARK_JS })
      .catch(() => {
        // Cosmetic only — don't escalate failures.
      });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function makeOk(id: number | undefined, result: unknown): OkResponse {
  return {
    ...(id !== undefined ? { id } : {}),
    result,
  };
}

function makeError(id: number | undefined, error: BriskError): ErrorResponse {
  return {
    ...(id !== undefined ? { id } : {}),
    error,
  };
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Re-export isBriskError so consumers don't need a separate import for narrowing.
export { isBriskError };
