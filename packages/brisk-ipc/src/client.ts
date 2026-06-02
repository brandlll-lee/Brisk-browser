/**
 * IPC client. Single-shot or long-lived connections.
 *
 *  - `ipcRequest(name, req)` — open, send one frame, read one frame, close.
 *    Mirrors browser-harness/_ipc.py:92-102 (`request`) and is the right
 *    API for >95% of CLI/diagnostic call sites.
 *  - `connectIpc(name)` — long-lived client with request/response queueing.
 *    For the future "brisk attach" flow that drives many CDP calls.
 *
 * Both use the same JSON-line wire format as the server (protocol.ts).
 */

import { connect, type Socket } from 'node:net';
import { ipcPath } from './paths.js';
import { encodeFrame, LineDecoder } from './protocol.js';

export interface IpcRequestOptions {
  /** Connect + write + read total timeout, in ms. Default: 5000. */
  readonly timeoutMs?: number;
  /** Max frame size accepted from the server. Default: 16 MiB. */
  readonly maxFrameBytes?: number;
}

/**
 * One-shot request: connect, send, wait for one reply, close.
 *
 * Resolves with the parsed JSON value sent by the server. Rejects if the
 * connection can't be established, the server closes mid-reply, or the
 * timeout fires.
 */
export async function ipcRequest(
  name: string,
  req: unknown,
  options: IpcRequestOptions = {},
): Promise<unknown> {
  const endpoint = ipcPath(name);
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxFrameBytes = options.maxFrameBytes;
  const decoder = new LineDecoder(maxFrameBytes !== undefined ? { maxFrameBytes } : {});

  return new Promise<unknown>((resolve, reject) => {
    let resolved = false;
    let socket: Socket | null = null;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket?.destroy();
      reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    function finish(value: unknown): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(value);
    }

    function fail(err: Error): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket?.destroy();
      reject(err);
    }

    socket = connect({ path: endpoint }, () => {
      try {
        socket?.write(encodeFrame(req));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on('data', (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = [...decoder.push(chunk)];
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const first = frames[0];
      if (first === undefined) return;
      try {
        finish(JSON.parse(first));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on('error', (err) => fail(err));

    socket.on('close', () => {
      if (!resolved) {
        fail(new Error('IPC server closed connection before responding'));
      }
    });
  });
}

export interface IpcClient {
  /** Send one request and await the next reply. */
  request(req: unknown): Promise<unknown>;
  /** Close the connection. */
  close(): void;
  /** True until close() is called or the server disconnects. */
  readonly isOpen: boolean;
}

/**
 * Open a long-lived client with FIFO request/reply pairing. Each `request`
 * resolves with the *next* response frame from the server. Requests are
 * serialized — the second one waits for the first to receive a reply.
 *
 * The server end MUST process requests in order on a single connection
 * (which `createIpcServer` does — see server.ts onData comment).
 */
export async function connectIpc(
  name: string,
  options: IpcRequestOptions = {},
): Promise<IpcClient> {
  const endpoint = ipcPath(name);
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxFrameBytes = options.maxFrameBytes;
  const decoder = new LineDecoder(maxFrameBytes !== undefined ? { maxFrameBytes } : {});

  type Pending = {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  };
  const queue: Pending[] = [];
  let socket: Socket | null = null;
  let open = false;
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      socket?.destroy();
      reject(new Error(`IPC connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    connectTimer.unref();

    socket = connect({ path: endpoint }, () => {
      clearTimeout(connectTimer);
      open = true;
      resolve();
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimer);
      if (!open) reject(err);
      else failAllPending(err);
    });

    socket.on('data', onData);

    socket.on('close', () => {
      open = false;
      failAllPending(new Error('IPC server closed connection'));
    });
  });

  function onData(chunk: Buffer): void {
    let frames: string[];
    try {
      frames = [...decoder.push(chunk)];
    } catch (err) {
      failAllPending(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const line of frames) {
      const pending = queue.shift();
      if (!pending) {
        // Server sent a frame we didn't ask for. Strict pairing assumption
        // is violated — close the connection so caller knows.
        failAllPending(new Error('IPC server sent unsolicited frame'));
        socket?.destroy();
        return;
      }
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line));
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  function failAllPending(err: Error): void {
    while (queue.length > 0) {
      const p = queue.shift();
      if (p) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
  }

  return {
    get isOpen() {
      return open && !closed;
    },
    async request(req: unknown): Promise<unknown> {
      if (closed || !open) {
        throw new Error('IPC client is closed');
      }
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = queue.findIndex((p) => p.timer === timer);
          if (idx >= 0) queue.splice(idx, 1);
          reject(new Error(`IPC request timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        queue.push({ resolve, reject, timer });
        try {
          socket?.write(encodeFrame(req));
        } catch (err) {
          // Pull our entry back out before failing — preserves queue order.
          const idx = queue.findIndex((p) => p.timer === timer);
          if (idx >= 0) queue.splice(idx, 1);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      open = false;
      socket?.destroy();
      failAllPending(new Error('IPC client closed locally'));
    },
  };
}
