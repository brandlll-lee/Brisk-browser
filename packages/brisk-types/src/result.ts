/**
 * Discriminated-union Result type. Used at module boundaries where we
 * prefer explicit failure modes over thrown errors (helpers/, MCP tools/).
 *
 * Style choice: tagged with `ok` boolean for ergonomic narrowing —
 *   if (r.ok) use(r.value); else handle(r.error);
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E = BriskError> = { readonly ok: false; readonly error: E };
export type Result<T, E = BriskError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Brisk's canonical error shape. Carries a machine-readable `code` plus
 * a human-readable `message`. The `cause` chain is preserved so we can
 * walk it in logs (cause must be either an Error or a BriskError).
 */
export interface BriskError {
  readonly code: BriskErrorCode;
  readonly message: string;
  readonly cause?: Error | BriskError;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type BriskErrorCode =
  // Connection / lifecycle
  | 'CDP_NOT_CONNECTED'
  | 'CDP_DISCONNECTED'
  | 'CDP_TIMEOUT'
  | 'CDP_PROTOCOL_ERROR'
  | 'CDP_TARGET_NOT_FOUND'
  | 'CDP_SESSION_NOT_FOUND'
  | 'BROWSER_NOT_FOUND'
  | 'BROWSER_LAUNCH_FAILED'
  // IPC
  | 'IPC_LISTEN_FAILED'
  | 'IPC_CONNECT_FAILED'
  | 'IPC_PROTOCOL_ERROR'
  | 'IPC_TIMEOUT'
  // MCP
  | 'MCP_INVALID_TRANSPORT'
  | 'MCP_ORIGIN_REJECTED'
  | 'MCP_TOOL_NOT_FOUND'
  | 'MCP_TOOL_INVALID_INPUT'
  // Helpers
  | 'HELPER_TIMEOUT'
  | 'HELPER_NO_ACTIVE_PAGE'
  | 'HELPER_INVALID_ARGS'
  | 'HELPER_INVALID_SELECTOR'
  // Skills
  | 'SKILL_NOT_FOUND'
  | 'SKILL_INVALID'
  | 'SKILL_DB_ERROR'
  | 'SKILL_WORKSPACE_LOCKED'
  // Generic
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'INVALID_STATE';

export function briskError(
  code: BriskErrorCode,
  message: string,
  options?: { cause?: Error | BriskError; details?: Record<string, unknown> },
): BriskError {
  // Build a minimal object with exactOptionalPropertyTypes-friendly fields.
  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // field that's typed without `| undefined`, so we conditionally include
  // them rather than always writing `cause: options?.cause`.
  const e: { -readonly [K in keyof BriskError]: BriskError[K] } = {
    code,
    message,
  };
  if (options?.cause !== undefined) e.cause = options.cause;
  if (options?.details !== undefined) e.details = Object.freeze({ ...options.details });
  return e;
}

/** Convert a thrown Error / unknown value into a BriskError safely. */
export function asBriskError(
  thrown: unknown,
  fallbackCode: BriskErrorCode = 'INTERNAL_ERROR',
): BriskError {
  if (isBriskError(thrown)) return thrown;
  if (thrown instanceof Error) {
    return briskError(fallbackCode, thrown.message, { cause: thrown });
  }
  return briskError(fallbackCode, typeof thrown === 'string' ? thrown : 'Unknown error');
}

export function isBriskError(v: unknown): v is BriskError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    'message' in v &&
    typeof (v as { code: unknown }).code === 'string' &&
    typeof (v as { message: unknown }).message === 'string'
  );
}
