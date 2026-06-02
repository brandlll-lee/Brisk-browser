/**
 * Shared types for brisk-core helpers.
 *
 * A helper is a thin async function that:
 *   • takes a `HelperContext` (cdp + daemon) and typed args,
 *   • performs ONE or a small number of CDP round-trips,
 *   • returns `Result<T>` — explicit success/failure for MCP layers.
 *
 * Helpers MUST NOT silently retry. They are the layer the LLM
 * inspects directly; their error messages are the LLM's tracelog.
 * Mirrors the browser-harness helper.py philosophy (504 lines, no
 * retry loops — only `wait_for_*` polls).
 */

import type { Result } from '@brisk/types';

import type { CdpBackendApi } from '../cdp/types.js';
import type { Daemon } from '../daemon/daemon.js';

export interface HelperContext {
  /** Direct CDP socket. Use when the helper needs a method scoped to a
   * non-default session (iframe target) or a Target.* call. */
  readonly cdp: CdpBackendApi;
  /** Daemon — call `.callCdp()` for default-session passthroughs that
   * want stale-session recovery, Target.* guards, etc. */
  readonly daemon: Daemon;
}

/** A helper's return type alias for readability at call sites. */
export type HelperResult<T> = Result<T>;
