/**
 * E2E: drive `brisk serve --transport stdio` over JSON-RPC.
 *
 * Skipped when no Chrome is installed.
 */

import { expect, test } from '@playwright/test';

import {
  type BriskServeHandle,
  type ChromeHandle,
  findChrome,
  makeStdioClient,
  spawnBrisk,
  spawnChrome,
  waitFor,
} from './helpers.js';

const PORT = 9434;
const AUTO_DISCOVERY_PORT = 9437;
const chromeBin = findChrome();

test.skip(!chromeBin, 'no Chrome installed');

test.describe('brisk serve --transport stdio', () => {
  let chrome: ChromeHandle;
  let brisk: BriskServeHandle;

  test.beforeAll(async () => {
    chrome = await spawnChrome(PORT);
  });

  test.afterAll(async () => {
    try {
      await brisk?.kill();
    } finally {
      await chrome?.kill();
    }
  });

  test('initialize + tools/list returns 37 tools', async () => {
    brisk = spawnBrisk(['--transport', 'stdio', '--cdp-port', String(PORT), '--no-skills'], {});
    const client = makeStdioClient(brisk.proc);

    // Give Brisk a moment to attach.
    await waitFor(() => brisk.proc.exitCode === null, 3_000);

    const init = await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'brisk-e2e', version: '0.1.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result).toBeDefined();

    client.notify('notifications/initialized');

    const list = await client.call('tools/list');
    expect(list.error).toBeUndefined();
    const result = list.result as { tools?: Array<{ name: string }> };
    expect(result.tools).toBeDefined();
    expect(result.tools?.length).toBe(37);

    // Make sure every category is represented.
    const names = (result.tools ?? []).map((t) => t.name);
    expect(names).toContain('page_info');
    expect(names).toContain('click_at_xy');
    expect(names).toContain('goto_url');
    expect(names).toContain('wait');
    expect(names).toContain('http_get');
    expect(names).toContain('connection_status');
    expect(names).toContain('upload_file');
    expect(names).toContain('drain_events');
  });

  test('tools/call connection_status returns connected', async () => {
    const client = makeStdioClient(brisk.proc);
    const result = await client.call('tools/call', {
      name: 'connection_status',
      arguments: {},
    });
    expect(result.error).toBeUndefined();
    const text = JSON.stringify(result.result);
    expect(text).toContain('connected');
  });

  test('auto-discovers an existing browser via DevToolsActivePort and attaches its current tab', async () => {
    const autoChrome = await spawnChrome(AUTO_DISCOVERY_PORT);
    let autoBrisk: BriskServeHandle | undefined;
    try {
      autoBrisk = spawnBrisk(['--transport', 'stdio', '--no-skills'], {
        BRISK_PROFILE_DIRS: autoChrome.profile,
      });
      const client = makeStdioClient(autoBrisk.proc);

      await waitFor(() => autoBrisk?.proc.exitCode === null, 3_000);

      const init = await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'brisk-e2e', version: '0.1.0' },
      });
      expect(init.error).toBeUndefined();
      client.notify('notifications/initialized');

      const newTab = await client.call('tools/call', {
        name: 'new_tab',
        arguments: { url: 'https://example.com/' },
      });
      expect(newTab.error).toBeUndefined();
      const loaded = await client.call('tools/call', {
        name: 'wait_for_load',
        arguments: { timeoutSeconds: 15 },
      });
      expect(loaded.error).toBeUndefined();

      await waitFor(async () => {
        const current = await client.call('tools/call', {
          name: 'current_tab',
          arguments: {},
        });
        expect(current.error).toBeUndefined();
        return JSON.stringify(current.result).includes('example.com');
      }, 10_000);
    } finally {
      await autoBrisk?.kill();
      await autoChrome.kill();
    }
  });
});
