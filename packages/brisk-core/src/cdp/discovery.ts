/**
 * Find a live Chrome / Chromium / Edge / Brave CDP endpoint to attach to.
 *
 * Discovery cascade (mirrors browser-harness/daemon.py:104-160):
 *
 *   1. Explicit WebSocket URL  — caller-provided, fastest path
 *   2. Explicit HTTP endpoint  — `http://host:port`, we fetch /json/version
 *   3. DevToolsActivePort scan — read the file Chrome writes inside each
 *                                profile's user-data-dir; line 1 = port,
 *                                line 2 = WS path (with leading `/`)
 *   4. Probe known ports       — 9222 then 9223 on loopback
 *
 * The cascade is necessary because Chrome 147+ disables the
 * `/json/version` HTTP endpoint by default on the default user-data-dir
 * (security mitigation), but still writes DevToolsActivePort so DevTools
 * itself can find it. The WS path in that file lets us skip the HTTP
 * step entirely — see daemon.py:144-147.
 */

import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { briskError } from '@brisk/types';
import type { CdpEndpoint } from '@brisk/types/cdp';

import {
  CDP_CONNECT_TIMEOUT_MS,
  CDP_DEFAULT_PORT,
  CDP_FALLBACK_PORT,
  CDP_LOOPBACK_HOSTS,
} from '../constants.js';

// ─── Profile path catalog ──────────────────────────────────────────

/**
 * Default user-data-dirs Chrome/Edge/Brave write `DevToolsActivePort` to.
 *
 * These mirror browser-harness/daemon.py:36-65 exactly — that list is
 * battle-tested across thousands of LLM-driven sessions. Don't remove
 * entries lightly. New entries are easy to add via env var `BRISK_PROFILE_DIRS`.
 *
 * Path layout depends on platform:
 *  - macOS:  ~/Library/Application Support/<Vendor>/<Browser>
 *  - Linux:  ~/.config/<browser>  (+ Flatpak ~/.var/app/<rdns>/...)
 *  - Windows: %LOCALAPPDATA%/<Vendor>/<Browser>/User Data
 *
 * (`os.homedir()` returns `%USERPROFILE%` on Windows, so the relative
 * sub-paths under "AppData/Local/..." resolve correctly on all platforms.)
 */
const DEFAULT_PROFILE_DIRS: readonly string[] = [
  // macOS
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Comet',
  'Library/Application Support/Arc/User Data',
  'Library/Application Support/Dia/User Data',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Microsoft Edge Beta',
  'Library/Application Support/Microsoft Edge Dev',
  'Library/Application Support/Microsoft Edge Canary',
  'Library/Application Support/BraveSoftware/Brave-Browser',
  // Linux
  '.config/google-chrome',
  '.config/chromium',
  '.config/chromium-browser',
  '.config/microsoft-edge',
  '.config/microsoft-edge-beta',
  '.config/microsoft-edge-dev',
  // Linux Flatpak
  '.var/app/org.chromium.Chromium/config/chromium',
  '.var/app/com.google.Chrome/config/google-chrome',
  '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser',
  '.var/app/com.microsoft.Edge/config/microsoft-edge',
  // Windows
  'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Google/Chrome SxS/User Data',
  'AppData/Local/Chromium/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Local/Microsoft/Edge Beta/User Data',
  'AppData/Local/Microsoft/Edge Dev/User Data',
  'AppData/Local/Microsoft/Edge SxS/User Data',
  'AppData/Local/BraveSoftware/Brave-Browser/User Data',
];

/** Resolve the platform-appropriate default profile dirs, absolute paths. */
export function defaultProfileDirs(): readonly string[] {
  const home = homedir();
  const env = process.env['BRISK_PROFILE_DIRS'];
  const extra = env
    ? env
        .split(platform() === 'win32' ? ';' : ':')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  return [...DEFAULT_PROFILE_DIRS.map((rel) => join(home, rel)), ...extra];
}

// ─── Public API ────────────────────────────────────────────────────

export interface DiscoveryOptions {
  /**
   * Explicit WebSocket URL — short-circuits all other discovery.
   * Equivalent to browser-harness's `BU_CDP_WS`.
   */
  readonly wsUrl?: string;

  /**
   * Explicit DevTools HTTP endpoint (e.g. `http://127.0.0.1:9333`).
   * We GET `/json/version` to resolve the live WS URL. Equivalent to
   * browser-harness's `BU_CDP_URL`.
   */
  readonly httpUrl?: string;

  /**
   * Port to probe at the tail of the cascade. Default: 9222. The fallback
   * port 9223 is also probed.
   */
  readonly port?: number;

  /**
   * User-data-dirs to scan for DevToolsActivePort. Defaults to the catalog
   * above — pass `[]` to skip this stage entirely.
   */
  readonly profileDirs?: readonly string[];

  /**
   * Per-attempt fetch timeout. Default: 10s. The outer cascade does not
   * impose a global timeout — caller is responsible for that.
   */
  readonly timeoutMs?: number;
}

/**
 * Walk the discovery cascade and return the first working endpoint.
 *
 * @throws BriskError(`BROWSER_NOT_FOUND`) if no endpoint can be resolved.
 */
export async function discoverCdpEndpoint(options: DiscoveryOptions = {}): Promise<CdpEndpoint> {
  const timeoutMs = options.timeoutMs ?? CDP_CONNECT_TIMEOUT_MS;
  const tried: string[] = [];

  // (1) Explicit WS URL ─ no validation beyond URL parsing; the connection
  // attempt later will catch invalid endpoints.
  if (options.wsUrl) {
    return {
      webSocketDebuggerUrl: options.wsUrl,
      host: hostOfWs(options.wsUrl) ?? '127.0.0.1',
    };
  }

  // (2) Explicit HTTP endpoint ─ resolve via /json/version, falling back to
  //     DevToolsActivePort when Chrome 147+ default profile returns 404.
  if (options.httpUrl) {
    try {
      return await resolveViaHttp(options.httpUrl, timeoutMs);
    } catch (err) {
      tried.push(`HTTP ${options.httpUrl}: ${describeError(err)}`);
    }
  }

  // (3) Profile scan ─ DevToolsActivePort + /json/version fallback.
  const profileDirs = options.profileDirs ?? defaultProfileDirs();
  for (const dir of profileDirs) {
    try {
      const endpoint = await resolveViaProfile(dir, timeoutMs);
      if (endpoint) return endpoint;
    } catch (err) {
      tried.push(`profile ${dir}: ${describeError(err)}`);
    }
  }

  // (4) Port probes ─ in case the user passed --remote-debugging-port=9222
  //     to a Chrome with --user-data-dir pointing at an unusual location.
  const probePorts = [options.port ?? CDP_DEFAULT_PORT, CDP_FALLBACK_PORT];
  for (const port of new Set(probePorts)) {
    for (const host of CDP_LOOPBACK_HOSTS) {
      try {
        return await resolveViaHttp(`http://${host}:${port}`, timeoutMs);
      } catch (err) {
        tried.push(`probe ${host}:${port}: ${describeError(err)}`);
      }
    }
  }

  throw briskError(
    'BROWSER_NOT_FOUND',
    'No live CDP endpoint found. Tried: ' +
      (tried.length === 0 ? '(no candidates)' : tried.slice(0, 6).join('; ')) +
      (tried.length > 6 ? `; ... and ${tried.length - 6} more` : '') +
      '. Start Chrome with --remote-debugging-port=9222 or set BRISK_CDP_WS=ws://...',
    { details: { tried } },
  );
}

// ─── Implementation ───────────────────────────────────────────────

/**
 * GET /json/version against a single base URL and turn the response into
 * a CdpEndpoint. Validates `webSocketDebuggerUrl` is present and a string.
 *
 * Auto-falls-back to DevToolsActivePort when the HTTP endpoint 404s
 * (Chrome 147+ default-profile lockdown). The caller passes us the
 * BASE — `/json/version` is appended.
 */
async function resolveViaHttp(baseUrl: string, timeoutMs: number): Promise<CdpEndpoint> {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = `${trimmed}/json/version`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  const body = (await res.json()) as Partial<CdpEndpoint> &
    Partial<{ Browser: string; 'Protocol-Version': string; 'User-Agent': string }>;
  if (typeof body.webSocketDebuggerUrl !== 'string') {
    throw new Error(
      `/json/version response missing webSocketDebuggerUrl: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const wsHost = hostOfWs(body.webSocketDebuggerUrl) ?? hostOfHttp(baseUrl) ?? '127.0.0.1';
  return {
    webSocketDebuggerUrl: body.webSocketDebuggerUrl,
    host: wsHost,
    ...(body.Browser !== undefined ? { browser: body.Browser } : {}),
    ...(body['Protocol-Version'] !== undefined
      ? { protocolVersion: body['Protocol-Version'] }
      : {}),
    ...(body['User-Agent'] !== undefined ? { userAgent: body['User-Agent'] } : {}),
  };
}

/**
 * Read `<profileDir>/DevToolsActivePort` and resolve to an endpoint.
 *
 * File layout:
 *   line 1: port number  (e.g. "9222")
 *   line 2: WS path      (e.g. "/devtools/browser/abc-def-...")
 *
 * Strategy:
 *   - Prefer `/json/version` lookup (gives us full metadata + browser
 *     version), which works on automation profiles.
 *   - Fall back to constructing the WS URL from the file's `ws_path` when
 *     /json/version 404s (Chrome 147+ default-profile lockdown).
 *
 * Returns `null` (not throw) when the file simply doesn't exist — that's
 * the expected case for browsers the user doesn't have installed.
 */
async function resolveViaProfile(
  profileDir: string,
  timeoutMs: number,
): Promise<CdpEndpoint | null> {
  const filePath = join(profileDir, 'DevToolsActivePort');
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR'
    ) {
      return null;
    }
    throw err;
  }
  const lines = content.split('\n');
  const portRaw = lines[0]?.trim();
  const wsPathRaw = lines[1]?.trim();
  if (!portRaw) return null;
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // Try /json/version first (it gives us the canonical browser-side URL,
  // protocol version, user agent — all useful for diagnostics).
  for (const host of CDP_LOOPBACK_HOSTS) {
    try {
      return await resolveViaHttp(`http://${host}:${port}`, timeoutMs);
    } catch (err) {
      // 404 = Chrome 147+ default-profile lockdown; we have the WS path
      // from the file, so fall back without trying more hosts (the file
      // told us the live port already).
      if (wsPathRaw && is404(err)) {
        return {
          webSocketDebuggerUrl: `ws://${normalizeHostForWs(host)}:${port}${wsPathRaw}`,
          host,
        };
      }
      // Connection refused etc. — try the next loopback host.
    }
  }

  // If /json/version failed on every host but we have a WS path, build
  // the WS URL on the canonical IPv4 host.
  if (wsPathRaw) {
    return {
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}${wsPathRaw}`,
      host: '127.0.0.1',
    };
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────

function hostOfWs(wsUrl: string): string | null {
  try {
    return new URL(wsUrl).hostname;
  } catch {
    return null;
  }
}

function hostOfHttp(httpUrl: string): string | null {
  try {
    return new URL(httpUrl).hostname;
  } catch {
    return null;
  }
}

function normalizeHostForWs(host: string): string {
  // [::1] in the loopback constant is the URL form; we strip brackets
  // here because they'd be double-applied by `new URL()` construction.
  if (host === '[::1]') return '::1';
  return host;
}

function is404(err: unknown): boolean {
  return err instanceof Error && /HTTP 404/.test(err.message);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
