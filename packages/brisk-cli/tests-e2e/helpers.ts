/**
 * Shared helpers for the W6 Playwright E2E suite.
 *
 * - `findChrome()` locates a Chrome binary across Windows/macOS/Linux.
 *   We don't depend on `@brisk/cli`'s ChromeFinder here because we
 *   need a static, dependency-free helper at the test-runner layer.
 * - `spawnChrome()` boots an isolated headless Chrome on a fixed port.
 * - `spawnBrisk()` launches `brisk serve` in a subprocess.
 * - `MCPClient` does JSON-RPC over either stdio or HTTP.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.BRISK_E2E_CHROME ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

export function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function makeTempProfile(prefix = 'brisk-e2e-'): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

export function cleanupTempProfile(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export interface ChromeHandle {
  proc: ChildProcessWithoutNullStreams;
  port: number;
  profile: string;
  kill(): Promise<void>;
}

export async function spawnChrome(port: number): Promise<ChromeHandle> {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found');

  const profile = makeTempProfile();
  const proc = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI,ChromeWhatsNewUI',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'pipe' },
  );
  proc.stderr?.on('data', () => {});
  proc.stdout?.on('data', () => {});

  // Wait for the /json/version endpoint.
  await waitForCdp(port, 20_000);

  return {
    proc,
    port,
    profile,
    async kill() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (!proc.killed) proc.kill('SIGKILL');
      }
      cleanupTempProfile(profile);
    },
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome did not open port ${port} within ${deadlineMs}ms`);
}

export interface BriskServeHandle {
  proc: ChildProcessWithoutNullStreams;
  kill(): Promise<void>;
}

/**
 * Spawn `brisk serve` as a subprocess.
 *
 * The `args` are passed through verbatim. For stdio transport, you'll
 * also want a JSON-line client on top of `proc.stdin/stdout`.
 */
export function spawnBrisk(
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): BriskServeHandle {
  // We run the compiled dist/index.js with node — same as what users
  // would get from `brisk` on PATH.
  const cliMain = resolve(__dirname, '..', 'dist', 'index.js');
  const proc = spawn(process.execPath, [cliMain, 'serve', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  proc.stderr?.on('data', () => {});

  return {
    proc,
    async kill() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (!proc.killed) proc.kill('SIGKILL');
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Minimal JSON-RPC clients (one for stdio, one for HTTP).
// We DON'T use @modelcontextprotocol/sdk's client — we want the test
// to fail loudly if the wire shape ever changes accidentally.
// ──────────────────────────────────────────────────────────────

let _id = 1;
function nextId(): number {
  return _id++;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface StdioClient {
  call(method: string, params?: unknown): Promise<JsonRpcResponse>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export function makeStdioClient(proc: ChildProcessWithoutNullStreams): StdioClient {
  let buffer = '';
  const pending = new Map<number, (resp: JsonRpcResponse) => void>();

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as JsonRpcResponse;
        if (obj && typeof obj.id === 'number') {
          const resolve = pending.get(obj.id);
          if (resolve) {
            pending.delete(obj.id);
            resolve(obj);
          }
        }
      } catch {
        // ignore garbage lines
      }
    }
  });

  return {
    call(method, params) {
      return new Promise((resolve) => {
        const id = nextId();
        pending.set(id, resolve);
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        proc.stdin?.write(`${JSON.stringify(req)}\n`);
      });
    },
    notify(method, params) {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close() {
      proc.stdin?.end();
    },
  };
}

export interface HttpClient {
  call(method: string, params?: unknown): Promise<JsonRpcResponse>;
  notify(method: string, params?: unknown): Promise<void>;
  sessionId(): string | null;
}

/**
 * Streamable HTTP MCP client.
 *
 * Maintains an `Mcp-Session-Id` across requests, as required by the
 * MCP 2025-06-18 Streamable HTTP transport spec. After `initialize`
 * succeeds, the server returns the session id in the response header;
 * the client must echo it back on every subsequent request.
 */
export function makeHttpClient(baseUrl: string): HttpClient {
  let session: string | null = null;

  async function send(body: string, expectResponse: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (session) headers['mcp-session-id'] = session;
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body,
    });
    const newSession = resp.headers.get('mcp-session-id');
    if (newSession) session = newSession;
    if (!resp.ok && expectResponse) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    return resp;
  }

  return {
    sessionId: () => session,
    async call(method, params) {
      const req: JsonRpcRequest = { jsonrpc: '2.0', id: nextId(), method, params };
      const resp = await send(JSON.stringify(req), true);
      const ct = resp.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) {
        const text = await resp.text();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            return JSON.parse(line.slice(6)) as JsonRpcResponse;
          }
        }
        throw new Error('SSE response had no data frame');
      }
      return (await resp.json()) as JsonRpcResponse;
    },
    async notify(method, params) {
      const req = { jsonrpc: '2.0', method, params };
      await send(JSON.stringify(req), false);
    },
  };
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
