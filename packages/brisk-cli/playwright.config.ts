/**
 * Playwright config for the Brisk W6 E2E suite.
 *
 * What we test:
 *   - stdio transport: spawn `brisk serve --transport stdio`, exchange
 *     JSON-RPC over stdin/stdout, verify tools/list returns 37.
 *   - http transport: start `brisk serve --transport http`, hit
 *     /mcp with JSON-RPC, verify tools/list returns 37.
 *
 * Playwright is just the test runner here — we don't open a real
 * browser through Playwright. Brisk talks to Chrome via CDP, not
 * Playwright's BrowserType.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  // We're not using browser fixtures, so projects can be a single
  // "node" project that just runs the test files.
  projects: [{ name: 'node' }],
  // E2E tests can be slow (Chrome boot, MCP handshake).
  timeout: 60_000,
  expect: { timeout: 5_000 },
  // No parallelism — both transports share the same Chrome port.
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'list',
  use: {
    headless: true,
  },
});
