import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectIpc, ipcRequest } from './client.js';
import { pingIpc } from './ping.js';
import { createIpcServer, type IpcServer } from './server.js';

/**
 * End-to-end server ↔ client tests over a real unix socket / named pipe.
 *
 * Each test uses a fresh random name to avoid collisions across parallel
 * vitest workers. We always tear down via the server.close() in afterEach
 * (the timer-based force-close is what we WANT to exercise too).
 */

function freshName(): string {
  return `briskt-${randomBytes(6).toString('hex')}`;
}

describe('IPC server + client end-to-end', () => {
  let server: IpcServer | null = null;
  let name = '';

  beforeEach(() => {
    name = freshName();
    server = null;
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it('one-shot ipcRequest receives an echoed reply', async () => {
    server = await createIpcServer(name, (req) => ({ echo: req }));
    const resp = await ipcRequest(name, { hello: 'world' });
    expect(resp).toEqual({ echo: { hello: 'world' } });
  });

  it('pingIpc returns true against a daemon that answers pong', async () => {
    server = await createIpcServer(name, (req) => {
      if (req && typeof req === 'object' && (req as { meta?: unknown }).meta === 'ping') {
        return { pong: true, pid: process.pid };
      }
      return { error: 'unknown' };
    });
    expect(await pingIpc(name)).toBe(true);
  });

  it('pingIpc returns false when no server is listening', async () => {
    expect(await pingIpc(name, 200)).toBe(false);
  });

  it('handler errors are surfaced to client as { error }', async () => {
    server = await createIpcServer(name, () => {
      throw new Error('boom');
    });
    const resp = await ipcRequest(name, { x: 1 });
    expect(resp).toEqual({ error: 'boom' });
  });

  it('persistent connectIpc preserves request order', async () => {
    server = await createIpcServer(name, async (req) => {
      const v = (req as { v: number }).v;
      // Intentionally invert delay so faster handler returns first if order
      // isn't enforced — server.ts awaits per frame so client must still see 1,2,3.
      await new Promise((r) => setTimeout(r, (3 - v) * 5));
      return { v };
    });
    const client = await connectIpc(name);
    try {
      const a = client.request({ v: 1 });
      const b = client.request({ v: 2 });
      const c = client.request({ v: 3 });
      const [ra, rb, rc] = await Promise.all([a, b, c]);
      expect(ra).toEqual({ v: 1 });
      expect(rb).toEqual({ v: 2 });
      expect(rc).toEqual({ v: 3 });
      expect(client.isOpen).toBe(true);
    } finally {
      client.close();
    }
  });

  it('connectIpc rejects pending requests on remote close', async () => {
    server = await createIpcServer(name, () => ({ ok: true }));
    const client = await connectIpc(name);
    // Issue a request, immediately tear down server so it never replies.
    const pending = client.request({ slow: true });
    await server.close();
    server = null;
    await expect(pending).rejects.toThrow();
    expect(client.isOpen).toBe(false);
  });

  it('survives a chunked write that splits one frame across data events', async () => {
    server = await createIpcServer(name, (req) => ({ got: req }));
    const big = { lots: 'x'.repeat(8192) };
    const resp = await ipcRequest(name, big);
    expect(resp).toEqual({ got: big });
  });

  it('rejects malformed JSON with a structured error reply', async () => {
    server = await createIpcServer(name, () => ({ ok: true }));
    // We can't go through ipcRequest because it pre-encodes; reach for raw socket.
    const { connect } = await import('node:net');
    const { ipcPath } = await import('./paths.js');
    const sock = connect({ path: ipcPath(name) });
    const reply = await new Promise<string>((resolve, reject) => {
      sock.on('connect', () => sock.write('{ unterminated\n'));
      sock.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      sock.on('error', reject);
    });
    sock.destroy();
    expect(reply).toContain('error');
  });

  it('endpoint property reflects what was bound', async () => {
    server = await createIpcServer(name, () => ({}));
    expect(typeof server.endpoint).toBe('string');
    expect(server.endpoint.includes('brisk-')).toBe(true);
  });

  it('rejects bad names from ipcPath at server-creation time', async () => {
    await expect(createIpcServer('bad name', () => ({}))).rejects.toThrow();
  });
});
