/**
 * Brisk CDP wire types — minimal subset we touch directly.
 *
 * Full CDP API has 650+ commands and 200+ types; we don't import the whole
 * thing. We model just the boundary types crossing the brisk-core ↔
 * caller seam. Within brisk-core's CDP backend the wire format is just
 * `unknown` JSON-RPC payloads.
 */

// ─── Connection ─────────────────────────────────────────────────────

export interface CdpEndpoint {
  /** Full WebSocket URL, e.g. ws://127.0.0.1:9222/devtools/browser/<id> */
  readonly webSocketDebuggerUrl: string;
  /** HTTP host:port form, e.g. 127.0.0.1:9222 */
  readonly host: string;
  /** Browser product string, e.g. "Chrome/148.0.7778.97" */
  readonly browser?: string;
  /** Protocol-Version returned by /json/version */
  readonly protocolVersion?: string;
  /** User-Agent of the browser */
  readonly userAgent?: string;
}

// ─── Target ─────────────────────────────────────────────────────────

export interface CdpTarget {
  readonly targetId: string;
  readonly type: CdpTargetType;
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
  readonly canAccessOpener?: boolean;
  readonly openerId?: string;
  readonly openerFrameId?: string;
  readonly browserContextId?: string;
  readonly webSocketDebuggerUrl?: string;
}

export type CdpTargetType =
  | 'page'
  | 'iframe'
  | 'worker'
  | 'shared_worker'
  | 'service_worker'
  | 'browser'
  | 'webview'
  | 'other'
  | 'background_page'
  | 'tab';

// ─── Session ────────────────────────────────────────────────────────

export interface CdpSession {
  readonly sessionId: string;
  readonly targetId: string;
}

/**
 * Tags exchanged at attach time so the daemon can verify it didn't
 * accidentally attach to the omnibox popup (CDP race well documented
 * in browser-harness comments).
 */
export interface AttachOptions {
  readonly waitForLoad?: boolean;
  readonly excludeOmniboxPopup?: boolean;
}

// ─── Error ──────────────────────────────────────────────────────────

export interface CdpProtocolError {
  /** JSON-RPC error code */
  readonly code: number;
  /** Human-readable error string */
  readonly message: string;
  /** CDP-domain-specific data */
  readonly data?: string;
  /** Method we were calling when this fired (added by brisk-core) */
  readonly briskMethod?: string;
}

// ─── Capture / Screenshot ───────────────────────────────────────────

export interface ScreenshotOptions {
  readonly format?: 'png' | 'jpeg' | 'webp';
  readonly quality?: number;
  readonly fullPage?: boolean;
  /** Max long-edge dimension in CSS pixels. Defaults to 1800 — many LLM
   *  vision endpoints refuse images larger than this. */
  readonly maxDim?: number;
  readonly clip?: { x: number; y: number; width: number; height: number; scale: number };
}

// ─── Viewport / page info ───────────────────────────────────────────

export interface PageInfoResult {
  readonly url: string;
  readonly title: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
  };
  readonly scroll: { readonly x: number; readonly y: number };
  readonly document: { readonly width: number; readonly height: number };
  readonly readyState: 'loading' | 'interactive' | 'complete';
  /** Surfaced when a JS dialog is pending (alert/confirm/prompt/beforeunload). */
  readonly dialog?: { readonly type: string; readonly message: string };
}
