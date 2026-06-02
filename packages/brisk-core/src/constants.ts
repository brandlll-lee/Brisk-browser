/**
 * Brisk runtime constants — all timeouts / retry counts in one place so
 * they can be reviewed and tuned together rather than hunted across files.
 *
 * Numbers chosen by triangulating:
 *  - browser-harness/daemon.py defaults (battle-tested with thousands of LLMs)
 *  - BrowserOS/shared/constants/{timeouts,limits}.ts (referenced by cdp.ts)
 *  - MCP SDK request-timeout defaults (60s)
 *
 * Override with env vars `BRISK_*_MS` / `BRISK_*_RETRIES` at startup.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── CDP timeouts ────────────────────────────────────────────────
/**
 * WebSocket connect + HTTP /json/version handshake timeout. browser-harness
 * waits 30s for the dedicated automation Chrome to come up, but for an
 * already-running Chrome we should fail fast — 10s is generous.
 */
export const CDP_CONNECT_TIMEOUT_MS = intFromEnv('BRISK_CDP_CONNECT_TIMEOUT_MS', 10_000);

/**
 * One CDP request's max time before we time it out and reject the caller.
 * BrowserOS uses 30s. Long enough for Page.captureScreenshot on full-page
 * captures of giant pages; short enough that a hung session doesn't lock
 * a tool call forever (MCP request timeout is 60s).
 */
export const CDP_REQUEST_TIMEOUT_MS = intFromEnv('BRISK_CDP_REQUEST_TIMEOUT_MS', 30_000);

/**
 * Interval between keepalive Browser.getVersion pings. Chrome's WebSocket
 * server doesn't throttle background tabs the way the page itself does,
 * but a sleeping laptop / wi-fi blip can still leave a zombie TCP socket
 * silent for many minutes. 30s is the BrowserOS value.
 */
export const CDP_KEEPALIVE_INTERVAL_MS = intFromEnv('BRISK_CDP_KEEPALIVE_INTERVAL_MS', 30_000);

/** Max wait for the keepalive ping reply. 5s is generous; >5s = dead. */
export const CDP_KEEPALIVE_TIMEOUT_MS = intFromEnv('BRISK_CDP_KEEPALIVE_TIMEOUT_MS', 5_000);

/** Delay between connect-loop attempts. */
export const CDP_CONNECT_RETRY_DELAY_MS = intFromEnv('BRISK_CDP_CONNECT_RETRY_DELAY_MS', 1_000);

/** Delay between reconnect-loop attempts (after an unexpected close). */
export const CDP_RECONNECT_DELAY_MS = intFromEnv('BRISK_CDP_RECONNECT_DELAY_MS', 1_000);

// ─── CDP retry counts ────────────────────────────────────────────
export const CDP_CONNECT_MAX_RETRIES = intFromEnv('BRISK_CDP_CONNECT_MAX_RETRIES', 5);

export const CDP_RECONNECT_MAX_RETRIES = intFromEnv('BRISK_CDP_RECONNECT_MAX_RETRIES', 10);

// ─── Discovery ───────────────────────────────────────────────────

/**
 * Default Chrome remote-debugging port (the canonical one used by
 * --remote-debugging-port=9222). 9223 is a common fallback we also probe.
 */
export const CDP_DEFAULT_PORT = 9222;

export const CDP_FALLBACK_PORT = 9223;

/**
 * Hosts we try in order when no explicit endpoint is given. IPv4 loopback
 * first (most common), then localhost (resolves via /etc/hosts and can
 * differ on misconfigured machines), then IPv6.
 *
 * Mirrors BrowserOS cdp.ts:23 (LOOPBACK_DISCOVERY_HOSTS).
 */
export const CDP_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;
