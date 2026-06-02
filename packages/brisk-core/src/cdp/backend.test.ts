import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

import { CdpBackend } from './backend.js';

/**
 * Backend tests against a mock CDP WebSocket server. The server responds
 * to the request/event pattern Chrome would, including:
 *  - Browser.getVersion (used for keepalive)
 *  - Arbitrary methods configured per-test
 *  - Spontaneous CDP events with optional sessionId
 *
 * We control timing precisely via short backend timeouts (50-200ms) to
 * keep tests fast.
 */

interface MockChromeServer {
  url: string;
  /** Drop the active socket (server-initiated close). */
  dropSocket: () => void;
  /** Send an arbitrary CDP wire message into the active socket. */
  pushMessage: (msg: unknown) => void;
  /** Stop the server. */
  close: () => Promise<void>;
}

type Handler = (req: {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}) => unknown;

async function startMockChrome(handler: Handler): Promise<MockChromeServer> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  let activeWs: WsWebSocket | null = null;

  wss.on('connection', (ws) => {
    activeWs = ws;
    ws.on('message', (raw) => {
      let req: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = handler({
        id: req.id,
        method: req.method,
        params: req.params ?? {},
        ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
      });
      if (result === undefined) return; // handler chose silence
      const responseFields: Record<string, unknown> = { id: req.id };
      if (req.sessionId !== undefined) responseFields.sessionId = req.sessionId;
      if (
        result &&
        typeof result === 'object' &&
        '__error' in (result as Record<string, unknown>)
      ) {
        responseFields.error = (result as { __error: unknown }).__error;
      } else {
        responseFields.result = result;
      }
      ws.send(JSON.stringify(responseFields));
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    dropSocket() {
      activeWs?.terminate();
    },
    pushMessage(msg) {
      activeWs?.send(JSON.stringify(msg));
    },
    async close() {
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

let mock: MockChromeServer | null = null;

afterEach(async () => {
  if (mock) {
    await mock.close();
    mock = null;
  }
});

describe('CdpBackend connect / send', () => {
  it('connects and sends a basic method', async () => {
    mock = await startMockChrome((req) => {
      if (req.method === 'Browser.getVersion') {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/148.0.7778.97',
          revision: '0',
          userAgent: 'Mozilla/5.0',
          jsVersion: '12.6.228',
        };
      }
      return { ok: true };
    });
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await backend.connect();
    expect(backend.isConnected()).toBe(true);
    const v = await backend.send<{ product: string }>('Browser.getVersion');
    expect(v.product).toContain('Chrome');
    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
  });

  it('surfaces CDP protocol errors as BriskError with classified code', async () => {
    mock = await startMockChrome((req) => {
      if (req.method === 'Foo.bar') {
        return { __error: { code: -32000, message: 'Session with given id not found' } };
      }
      return { ok: true };
    });
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await backend.connect();
    try {
      await expect(backend.send('Foo.bar')).rejects.toMatchObject({
        code: 'CDP_SESSION_NOT_FOUND',
      });
    } finally {
      await backend.disconnect();
    }
  });

  it('rejects Target.* sent on a session id (footgun guard)', async () => {
    mock = await startMockChrome(() => ({ ok: true }));
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await backend.connect();
    try {
      await expect(backend.sendOnSession('SID', 'Target.getTargets')).rejects.toMatchObject({
        code: 'CDP_PROTOCOL_ERROR',
      });
    } finally {
      await backend.disconnect();
    }
  });

  it('times out a request that never resolves', async () => {
    mock = await startMockChrome((req) => {
      if (req.method === 'Browser.getVersion') return { protocolVersion: '1.3' };
      return undefined; // never reply
    });
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
      requestTimeoutMs: 100,
    });
    await backend.connect();
    try {
      await expect(backend.send('Hangs.forever')).rejects.toMatchObject({
        code: 'CDP_TIMEOUT',
      });
    } finally {
      await backend.disconnect();
    }
  });
});

describe('CdpBackend events', () => {
  it('routes browser-level events to on() listeners', async () => {
    mock = await startMockChrome(() => ({ ok: true }));
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await backend.connect();
    try {
      const received: unknown[] = [];
      const off = backend.on('Browser.downloadProgress', (params) => {
        received.push(params);
      });
      mock.pushMessage({
        method: 'Browser.downloadProgress',
        params: { guid: 'abc', state: 'completed' },
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(received).toEqual([{ guid: 'abc', state: 'completed' }]);
      off();
      mock.pushMessage({
        method: 'Browser.downloadProgress',
        params: { guid: 'def' },
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(received).toHaveLength(1);
    } finally {
      await backend.disconnect();
    }
  });

  it('routes session-scoped events to onSession() listeners with sessionId', async () => {
    mock = await startMockChrome(() => ({ ok: true }));
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await backend.connect();
    try {
      const seen: Array<{ params: unknown; sid: string }> = [];
      backend.onSession('Page.loadEventFired', (params, sid) => {
        seen.push({ params, sid });
      });
      mock.pushMessage({
        method: 'Page.loadEventFired',
        params: { timestamp: 12345 },
        sessionId: 'SESS-1',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).toEqual([{ params: { timestamp: 12345 }, sid: 'SESS-1' }]);
    } finally {
      await backend.disconnect();
    }
  });
});

describe('CdpBackend disconnect / pending cleanup', () => {
  it('rejects in-flight requests when disconnect() is called', async () => {
    mock = await startMockChrome(() => undefined);
    const backend = new CdpBackend({
      endpoint: mock.url,
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
      requestTimeoutMs: 5_000,
    });
    await backend.connect();
    const pending = backend.send('Will.never.respond');
    await new Promise((r) => setTimeout(r, 30));
    await backend.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'CDP_DISCONNECTED' });
  });
});

describe('CdpBackend connect failures', () => {
  it('throws CDP_NOT_CONNECTED when all connect attempts fail', async () => {
    const backend = new CdpBackend({
      // No server is listening on this port — connect should error fast.
      endpoint: 'ws://127.0.0.1:1/devtools/browser/none',
      connectMaxRetries: 2,
      connectRetryDelayMs: 10,
      connectTimeoutMs: 200,
    });
    await expect(backend.connect()).rejects.toMatchObject({
      code: 'CDP_NOT_CONNECTED',
    });
  });

  it('rejects send() before connect()', async () => {
    const backend = new CdpBackend({
      endpoint: 'ws://127.0.0.1:1/devtools/browser/none',
      connectMaxRetries: 1,
      connectRetryDelayMs: 10,
    });
    await expect(backend.send('Foo')).rejects.toMatchObject({
      code: 'CDP_NOT_CONNECTED',
    });
  });
});
