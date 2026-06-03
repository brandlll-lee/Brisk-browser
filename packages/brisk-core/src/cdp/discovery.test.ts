import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverCdpEndpoint } from './discovery.js';

/**
 * Discovery tests use real loopback HTTP and real filesystem to mirror
 * production behavior — anything else would let bugs in URL composition
 * or Buffer/string handling slip through. Each test gets a fresh
 * temp directory and a fresh port.
 */

interface FakeChrome {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function startFakeChrome(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
}): Promise<FakeChrome> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/json/version') {
        const status = opts.status ?? (opts.ok === false ? 404 : 200);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        const body = opts.body ?? {
          Browser: 'Chrome/148.0.7778.97',
          'Protocol-Version': '1.3',
          'User-Agent': 'Mozilla/5.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${
            (server.address() as { port: number }).port
          }/devtools/browser/abc-123`,
        };
        res.end(JSON.stringify(body));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        close(): Promise<void> {
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

let fakeChrome: FakeChrome | null = null;
let tempProfileDir: string | null = null;

afterEach(async () => {
  if (fakeChrome) {
    await fakeChrome.close();
    fakeChrome = null;
  }
  if (tempProfileDir) {
    await rm(tempProfileDir, { recursive: true, force: true });
    tempProfileDir = null;
  }
});

describe('discoverCdpEndpoint', () => {
  it('short-circuits on explicit wsUrl', async () => {
    const result = await discoverCdpEndpoint({
      wsUrl: 'ws://example.local:9222/devtools/browser/forced',
    });
    expect(result.webSocketDebuggerUrl).toBe('ws://example.local:9222/devtools/browser/forced');
    expect(result.host).toBe('example.local');
  });

  it('resolves via explicit httpUrl + /json/version', async () => {
    fakeChrome = await startFakeChrome({});
    const result = await discoverCdpEndpoint({
      httpUrl: `http://127.0.0.1:${fakeChrome.port}`,
    });
    expect(result.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${fakeChrome.port}/devtools/browser/abc-123`,
    );
    expect(result.browser).toBe('Chrome/148.0.7778.97');
    expect(result.protocolVersion).toBe('1.3');
  });

  it('falls through httpUrl HTTP 500 and surfaces error', async () => {
    fakeChrome = await startFakeChrome({ status: 500 });
    await expect(
      discoverCdpEndpoint({
        httpUrl: `http://127.0.0.1:${fakeChrome.port}`,
        profileDirs: [],
        port: 1, // refuse port to ensure cascade exhaustion
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
  });

  it('scans profileDirs and reads DevToolsActivePort', async () => {
    fakeChrome = await startFakeChrome({});
    tempProfileDir = join(tmpdir(), `brisk-prof-${randomBytes(6).toString('hex')}`);
    await mkdir(tempProfileDir, { recursive: true });
    await writeFile(
      join(tempProfileDir, 'DevToolsActivePort'),
      `${fakeChrome.port}\n/devtools/browser/from-file-uuid\n`,
      'utf8',
    );
    const result = await discoverCdpEndpoint({
      profileDirs: [tempProfileDir],
    });
    // We prefer /json/version's authoritative URL when it succeeds.
    expect(result.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${fakeChrome.port}/devtools/browser/abc-123`,
    );
  });

  it('discovers an existing browser from DevToolsActivePort without an explicit port', async () => {
    fakeChrome = await startFakeChrome({});
    tempProfileDir = join(tmpdir(), `brisk-current-browser-${randomBytes(6).toString('hex')}`);
    await mkdir(tempProfileDir, { recursive: true });
    await writeFile(
      join(tempProfileDir, 'DevToolsActivePort'),
      `${fakeChrome.port}\n/devtools/browser/current-tab-browser\n`,
      'utf8',
    );

    const result = await discoverCdpEndpoint({
      profileDirs: [tempProfileDir],
      // Use an unreachable probe port to prove the profile path wins.
      port: 1,
    });

    expect(result.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${fakeChrome.port}/devtools/browser/abc-123`,
    );
  });

  it('falls back to DevToolsActivePort path when /json/version 404s (Chrome 147+)', async () => {
    fakeChrome = await startFakeChrome({ ok: false });
    tempProfileDir = join(tmpdir(), `brisk-prof-${randomBytes(6).toString('hex')}`);
    await mkdir(tempProfileDir, { recursive: true });
    await writeFile(
      join(tempProfileDir, 'DevToolsActivePort'),
      `${fakeChrome.port}\n/devtools/browser/locked-default-profile\n`,
      'utf8',
    );
    const result = await discoverCdpEndpoint({
      profileDirs: [tempProfileDir],
    });
    expect(result.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${fakeChrome.port}/devtools/browser/locked-default-profile`,
    );
  });

  it('skips profile dirs with no DevToolsActivePort file', async () => {
    tempProfileDir = join(tmpdir(), `brisk-prof-${randomBytes(6).toString('hex')}`);
    await mkdir(tempProfileDir, { recursive: true });
    await expect(
      discoverCdpEndpoint({
        profileDirs: [tempProfileDir],
        port: 1,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
  });

  it('rejects profile DevToolsActivePort with invalid port', async () => {
    tempProfileDir = join(tmpdir(), `brisk-prof-${randomBytes(6).toString('hex')}`);
    await mkdir(tempProfileDir, { recursive: true });
    await writeFile(
      join(tempProfileDir, 'DevToolsActivePort'),
      'not-a-number\n/some/path\n',
      'utf8',
    );
    await expect(
      discoverCdpEndpoint({
        profileDirs: [tempProfileDir],
        port: 1,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
  });

  it('throws BROWSER_NOT_FOUND with helpful detail when nothing works', async () => {
    await expect(
      discoverCdpEndpoint({
        profileDirs: [],
        port: 1,
      }),
    ).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
      message: expect.stringMatching(/No live CDP endpoint/),
    });
  });

  it('discovers via port probe when no other discovery method succeeds', async () => {
    fakeChrome = await startFakeChrome({});
    // Run with profileDirs:[] so port probe is the only path; pass the
    // port the fake server bound to.
    const result = await discoverCdpEndpoint({
      profileDirs: [],
      port: fakeChrome.port,
    });
    expect(result.webSocketDebuggerUrl).toContain('/devtools/browser/abc-123');
  });
});
