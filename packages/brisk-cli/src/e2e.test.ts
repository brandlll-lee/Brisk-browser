/**
 * End-to-end smoke test against a real Chromium.
 *
 * Boots Brisk against an isolated Chrome instance (fresh user-data-dir,
 * headless=new), exercises the daemon + helpers + MCP wiring, then
 * tears everything down.
 *
 * Skipped on machines without Chrome — set `BRISK_E2E_CHROME=<path>` to
 * point at a custom binary. The test uses port 9333 to avoid clashing
 * with the user's default debug port (9222).
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type BriskToolContext, createBriskMcpServer } from '@brisk/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Boot, boot } from './boot.js';

// MCP JSON-RPC method strings — pinned to the wire spec so we don't
// need to depend on @modelcontextprotocol/sdk in the CLI package.
const METHOD_TOOLS_LIST = 'tools/list';
const METHOD_RESOURCES_LIST = 'resources/list';
const METHOD_TOOLS_CALL = 'tools/call';

const CHROME_CANDIDATES = [
  process.env.BRISK_E2E_CHROME ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

const TEST_PORT = 9333;
const CHROME_BIN = findChrome();

interface RequestExtra {
  signal: AbortSignal;
  requestId: string;
  sendNotification: () => void;
  sendRequest: () => Promise<unknown>;
}

function extra(): RequestExtra {
  return {
    signal: new AbortController().signal,
    requestId: '1',
    sendNotification: () => {},
    sendRequest: () => Promise.resolve({}),
  };
}

async function waitForCdp(port: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not open port ${port} within ${deadlineMs}ms`);
}

const CHROME_AVAILABLE = CHROME_BIN !== null;

describe.skipIf(!CHROME_AVAILABLE)('brisk e2e against real Chrome', () => {
  let chrome: ChildProcessWithoutNullStreams;
  let profileDir: string;
  let booted: Boot;

  beforeAll(async () => {
    if (!CHROME_BIN) throw new Error('Chrome not found');
    profileDir = mkdtempSync(resolve(tmpdir(), 'brisk-e2e-'));
    chrome = spawn(
      CHROME_BIN,
      [
        `--remote-debugging-port=${TEST_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI,ChromeWhatsNewUI',
        '--disable-extensions',
        'about:blank',
      ],
      { stdio: 'pipe' },
    );
    chrome.stderr?.on('data', () => {});
    chrome.stdout?.on('data', () => {});

    await waitForCdp(TEST_PORT, 20_000);

    booted = await boot({ cdpPort: TEST_PORT, noSkills: true });
  }, 60_000);

  afterAll(async () => {
    try {
      await booted?.shutdown();
    } catch {
      // ignore
    }
    if (chrome && !chrome.killed) {
      chrome.kill('SIGTERM');
      // Give it a moment to exit cleanly.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!chrome.killed) chrome.kill('SIGKILL');
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }, 30_000);

  it('attaches a session to the live Chrome', () => {
    const { sessionId, targetId } = booted.daemon.getSession();
    expect(sessionId).toBeTruthy();
    expect(targetId).toBeTruthy();
    expect(booted.cdp.isConnected()).toBe(true);
  });

  it('exposes all 37 MCP tools and at least one interaction-skill resource', async () => {
    const ctx: BriskToolContext = {
      daemon: booted.daemon,
      cdp: booted.cdp,
      skills: null,
    };
    const interactionSkillsDir = resolve(__dirname, '..', '..', '..', 'interaction-skills');
    const server = await createBriskMcpServer({
      ctx,
      interactionSkillsDir,
    });

    const handlers = (
      server as unknown as {
        server: {
          _requestHandlers: Map<
            string,
            (
              req: unknown,
              e: unknown,
            ) => Promise<{
              tools?: { name: string }[];
              resources?: { uri: string }[];
              content?: Array<{ type: string; [k: string]: unknown }>;
            }>
          >;
        };
      }
    ).server._requestHandlers;

    const list = await handlers.get(METHOD_TOOLS_LIST)?.(
      { method: METHOD_TOOLS_LIST, params: {} },
      extra(),
    );
    expect(list?.tools?.length).toBe(37);

    const resList = await handlers.get(METHOD_RESOURCES_LIST)?.(
      { method: METHOD_RESOURCES_LIST, params: {} },
      extra(),
    );
    expect(resList?.resources?.some((r) => r.uri.startsWith('mcp://brisk/interaction/'))).toBe(
      true,
    );

    // Drive the connection_status tool — read-only, doesn't depend on
    // a fully-hydrated page, just on the CDP keepalive being alive.
    const callTool = handlers.get(METHOD_TOOLS_CALL);
    const callResult = await callTool?.(
      {
        method: METHOD_TOOLS_CALL,
        params: { name: 'connection_status', arguments: {} },
      },
      extra(),
    );
    expect(callResult?.content?.[0]?.type).toBe('text');
    // The structured content shape should encode `status: "connected"`.
    expect(JSON.stringify(callResult)).toContain('connected');
  }, 30_000);
});

describe.skipIf(CHROME_AVAILABLE)('brisk e2e (skipped: no Chrome available)', () => {
  it('placeholder so vitest reports a passing file', () => {
    expect(true).toBe(true);
  });
});
