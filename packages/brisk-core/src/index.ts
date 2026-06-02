/**
 * @brisk/core — Brisk engine.
 *
 * - cdp/      Custom CDP client (WebSocket + keepalive + reconnect)
 * - daemon/   Daemon lifecycle, session management, event buffering (W2)
 * - helpers/  Browser primitives wrapped over CDP (W2-W5)
 * - workspace/ agent-workspace/agent_helpers.ts hot-loader (W4)
 *
 * This package is MCP-agnostic — the same engine could later power a
 * direct in-process API, a CLI script, or the embedded Chromium build.
 */

export const BRISK_CORE_VERSION = '0.1.0-dev' as const;

export * from './cdp/index.js';
export * from './console/index.js';
export * from './constants.js';
export * from './daemon/index.js';
export * from './helpers/index.js';
