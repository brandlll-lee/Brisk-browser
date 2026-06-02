/**
 * E2E: drive `brisk serve --transport http` over JSON-RPC.
 *
 * Skipped when no Chrome is installed.
 */

import { expect, test } from '@playwright/test';

import {
  type BriskServeHandle,
  type ChromeHandle,
  findChrome,
  makeHttpClient,
  spawnBrisk,
  spawnChrome,
  waitFor,
} from './helpers.js';

const CHROME_PORT = 9435;
const HTTP_PORT = 9436;
const chromeBin = findChrome();

test.skip(!chromeBin, 'no Chrome installed');

test.describe('brisk serve --transport http', () => {
  let chrome: ChromeHandle;
  let brisk: BriskServeHandle;

  test.beforeAll(async () => {
    chrome = await spawnChrome(CHROME_PORT);
    brisk = spawnBrisk(
      [
        '--transport',
        'http',
        '--port',
        String(HTTP_PORT),
        '--host',
        '127.0.0.1',
        '--cdp-port',
        String(CHROME_PORT),
        '--no-skills',
      ],
      {},
    );

    // Wait until the HTTP server is reachable.
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
          method: 'OPTIONS',
          signal: AbortSignal.timeout(500),
        });
        // 200 or 405 are both fine — server is up.
        return r.status < 500;
      } catch {
        return false;
      }
    }, 15_000);
  });

  test.afterAll(async () => {
    try {
      await brisk?.kill();
    } finally {
      await chrome?.kill();
    }
  });

  test('initialize + tools/list + tools/call round-trip over HTTP', async () => {
    const client = makeHttpClient(`http://127.0.0.1:${HTTP_PORT}`);

    // 1) initialize — server hands back Mcp-Session-Id
    const init = await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'brisk-e2e', version: '0.1.0' },
    });
    expect(init.error).toBeUndefined();
    expect(client.sessionId()).toBeTruthy();

    // 2) per spec, send notifications/initialized before any other request
    await client.notify('notifications/initialized');

    // 3) tools/list
    const list = await client.call('tools/list');
    expect(list.error).toBeUndefined();
    const result = list.result as { tools?: Array<{ name: string }> };
    expect(result.tools?.length).toBe(37);

    // 4) tools/call connection_status
    const callResult = await client.call('tools/call', {
      name: 'connection_status',
      arguments: {},
    });
    expect(callResult.error).toBeUndefined();
    const text = JSON.stringify(callResult.result);
    expect(text).toContain('connected');
  });
});
