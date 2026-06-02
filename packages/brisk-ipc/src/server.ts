/**
 * Cross-platform IPC server. Wraps Node's `net.createServer` with:
 *
 *  - Path resolution (POSIX unix socket / Windows named pipe) via paths.ts
 *  - Stale-socket cleanup (POSIX) — listen() throws EADDRINUSE otherwise
 *  - umask 0o077 around bind (POSIX) — socket created as 0600, no TOCTOU
 *  - Per-connection line framing + handler dispatch + error reply
 *  - Graceful shutdown (close + force-disconnect after timeout)
 *
 * Reference: browser-harness/_ipc.py:161-186 (serve) for the POSIX umask
 * and atomic-create pattern; we follow the same approach but using Node
 * primitives. Note we DON'T need Windows token auth like _ipc.py does —
 * Windows named pipes have native ACLs (default: creator-only access),
 * unlike TCP loopback which has none. The unix-socket-or-named-pipe path
 * is unified through `ipcPath()` so the same code works on both.
 */

import { unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { platform } from 'node:os';
import { ipcPath } from './paths.js';
import { encodeFrame, LineDecoder } from './protocol.js';

const IS_WINDOWS = platform() === 'win32';

export type RequestHandler = (req: unknown) => Promise<unknown> | unknown;

export interface IpcServerOptions {
  /**
   * Max frame size in bytes; default 16 MiB (see protocol.ts).
   */
  readonly maxFrameBytes?: number;

  /**
   * How long to wait for in-flight requests to drain on close(), in ms.
   * After this, lingering sockets are force-destroyed.
   * Default: 2000.
   */
  readonly closeTimeoutMs?: number;

  /**
   * Optional async error sink. Called for every per-connection failure
   * that the server otherwise swallows (handler exceptions, decode errors,
   * write failures). Defaults to a no-op — pass `console.error` for noisy
   * dev output, or a logger that goes to stderr for stdio-MCP daemons.
   */
  readonly onError?: (err: Error, ctx: { stage: string }) => void;
}

export interface IpcServer {
  /** Endpoint path the server is bound to (informational). */
  readonly endpoint: string;
  /** Number of currently open connections. */
  readonly connectionCount: number;
  /** Stop accepting new connections; existing ones drain (then time out). */
  close(): Promise<void>;
}

/**
 * Start a new IPC server. Returns once bound — the server is ready to
 * receive requests at the moment the promise resolves.
 *
 * @throws if the endpoint can't be bound (EADDRINUSE, EACCES, etc.).
 */
export async function createIpcServer(
  name: string,
  handler: RequestHandler,
  options: IpcServerOptions = {},
): Promise<IpcServer> {
  const endpoint = ipcPath(name);
  const maxFrameBytes = options.maxFrameBytes;
  const closeTimeoutMs = options.closeTimeoutMs ?? 2000;
  const onError = options.onError ?? noopErrorSink;

  // POSIX: an unclean previous shutdown leaves the socket file behind;
  // bind would then fail with EADDRINUSE. unlinkSync is best-effort —
  // ENOENT just means "wasn't there", anything else propagates.
  if (!IS_WINDOWS) {
    try {
      unlinkSync(endpoint);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);

    const decoder = new LineDecoder(maxFrameBytes !== undefined ? { maxFrameBytes } : {});

    socket.on('data', (chunk: Buffer) => {
      void onData(chunk);
    });

    async function onData(chunk: Buffer): Promise<void> {
      let frames: string[];
      try {
        frames = [...decoder.push(chunk)];
      } catch (err) {
        // Framing-level fault: malformed peer. Best effort error reply
        // then drop the connection — recovery would require resyncing
        // on the next \n which we can't trust either at this point.
        onError(err as Error, { stage: 'decode' });
        writeErrorAndDestroy(socket, 'IPC framing error');
        return;
      }
      for (const line of frames) {
        // We process frames sequentially (await) to preserve request ordering
        // per connection. browser-harness's serve() is single-request-per-conn,
        // but ours allows pipelining — handlers shouldn't assume isolation,
        // they get one Promise per request and we await it before the next.
        await processFrame(line);
      }
    }

    async function processFrame(line: string): Promise<void> {
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch (err) {
        onError(err as Error, { stage: 'parse' });
        writeFrame(socket, { error: 'IPC parse error' });
        return;
      }
      let resp: unknown;
      try {
        resp = await handler(req);
      } catch (err) {
        onError(err as Error, { stage: 'handler' });
        resp = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
      writeFrame(socket, resp);
    }

    socket.on('error', (err) => {
      onError(err, { stage: 'socket' });
      // 'close' will fire after 'error', so cleanup happens once there.
    });

    socket.on('close', () => {
      decoder.reset();
      sockets.delete(socket);
    });
  });

  server.on('error', (err) => onError(err, { stage: 'server' }));

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    // POSIX: umask 0o077 so the bind() creates the socket mode 0600 —
    // closes the TOCTOU window vs a post-listen chmod. We restore the
    // previous umask immediately even if listen throws synchronously
    // (it usually emits 'error' async, but we're defensive).
    if (!IS_WINDOWS) {
      const oldUmask = process.umask(0o077);
      try {
        server.listen(endpoint);
      } finally {
        process.umask(oldUmask);
      }
    } else {
      server.listen(endpoint);
    }
  });

  return {
    endpoint,
    get connectionCount() {
      return sockets.size;
    },
    async close(): Promise<void> {
      // Stop accepting new connections immediately, then give existing
      // sockets a window to drain. After the window, destroy() — close()
      // alone hangs forever if any client is still attached.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (sockets.size === 0) return;
        setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, closeTimeoutMs).unref();
      });
      // POSIX: try to clean up the socket file. Server.close() removes it
      // on modern Node, but be defensive — unlink with ENOENT swallow.
      if (!IS_WINDOWS) {
        try {
          unlinkSync(endpoint);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            onError(err as Error, { stage: 'cleanup' });
          }
        }
      }
    },
  };
}

function writeFrame(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  try {
    socket.write(encodeFrame(value));
  } catch {
    // Connection died mid-write — no point bubbling up.
  }
}

function writeErrorAndDestroy(socket: Socket, message: string): void {
  if (socket.destroyed) return;
  try {
    socket.write(encodeFrame({ error: message }));
  } catch {
    // Ignored — we're about to destroy().
  }
  socket.destroy();
}

function noopErrorSink(_err: Error, _ctx: { stage: string }): void {
  // Intentionally empty — see options.onError documentation.
}
