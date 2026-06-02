/**
 * `brisk daemon` — manage the long-lived IPC daemon process.
 *
 * Subcommands:
 *   brisk daemon start    — boot CDP + Daemon + IPC server, block on SIGINT
 *   brisk daemon stop     — send {meta:'shutdown'} to a running daemon
 *   brisk daemon status   — ping and report PID / version / uptime
 *
 * Use case: keep a persistent IPC daemon running so multiple short-lived
 * Brisk commands (or external scripts using the JSON-line protocol) share
 * one CDP attachment. For MCP usage, `brisk serve` is the right command.
 */

import { createIpcServer, identifyIpcDaemon, ipcPath, ipcRequest, pingIpc } from '@brisk/ipc';
import type { IpcRequest } from '@brisk/types';

import { type BootOptions, boot } from '../boot.js';
import { type CliLogger, createLogger, println } from '../logger.js';

const DEFAULT_INSTANCE = 'default';

// ─── start ────────────────────────────────────────────────────────────

export interface DaemonStartOptions extends BootOptions {
  readonly instance?: string;
  readonly logger?: CliLogger;
}

export async function runDaemonStart(options: DaemonStartOptions): Promise<void> {
  const logger = options.logger ?? createLogger('info');
  const instance = options.instance ?? DEFAULT_INSTANCE;

  // Refuse to start if another daemon is already up.
  const existingPid = await identifyIpcDaemon(instance);
  if (existingPid !== null) {
    println(`Daemon already running at ${ipcPath(instance)} (pid=${existingPid}).`);
    println('Run `brisk daemon stop` first if you want to replace it.');
    process.exitCode = 1;
    return;
  }

  const boots = await boot({
    ...(options.cdpWs !== undefined ? { cdpWs: options.cdpWs } : {}),
    ...(options.cdpUrl !== undefined ? { cdpUrl: options.cdpUrl } : {}),
    ...(options.cdpPort !== undefined ? { cdpPort: options.cdpPort } : {}),
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.noSkills !== undefined ? { noSkills: options.noSkills } : {}),
    logger,
  });

  let stopping = false;

  const ipc = await createIpcServer(
    instance,
    async (req) => {
      try {
        const resp = await boots.daemon.handle(req as IpcRequest);
        // If the daemon was asked to shut down via IPC, request the
        // process to exit after we've flushed the response.
        if (
          (req as IpcRequest | undefined) &&
          'meta' in (req as { meta?: string }) &&
          (req as { meta?: string }).meta === 'shutdown'
        ) {
          stopping = true;
          setImmediate(() => {
            void shutdownAll();
          });
        }
        return resp;
      } catch (cause) {
        return { error: (cause as Error).message ?? 'unknown' };
      }
    },
    {
      onError: (err, ctx) => logger.warn(`ipc ${ctx.stage}: ${err.message}`),
    },
  );

  println(`brisk daemon listening at ${ipc.endpoint} (pid=${process.pid})`);
  println(`  CDP    ${boots.endpoint.webSocketDebuggerUrl}`);
  if (boots.skills) {
    println(`  Skills ${boots.skills.layout.root}`);
  }
  println('  Stop with `brisk daemon stop` or Ctrl-C.');

  async function shutdownAll(): Promise<void> {
    if (stopping) {
      stopping = true;
    }
    try {
      await ipc.close();
    } catch (cause) {
      logger.warn(`ipc close failed: ${(cause as Error).message}`);
    }
    await boots.shutdown();
    process.exit(0);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      println(`Received ${signal}; shutting down.`);
      void shutdownAll();
    });
  }

  // Block forever; signal handlers resolve via process.exit.
  await new Promise<void>(() => {
    /* noop */
  });
}

// ─── stop ─────────────────────────────────────────────────────────────

export interface DaemonStopOptions {
  readonly instance?: string;
  readonly timeoutMs?: number;
}

export async function runDaemonStop(options: DaemonStopOptions = {}): Promise<void> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const timeoutMs = options.timeoutMs ?? 3000;

  const pid = await identifyIpcDaemon(instance, 500);
  if (pid === null) {
    println(`No Brisk daemon running for instance "${instance}".`);
    return;
  }

  try {
    await ipcRequest(instance, { meta: 'shutdown' }, { timeoutMs });
  } catch (cause) {
    println(`Shutdown RPC failed: ${(cause as Error).message}`);
    println(`You may need to kill pid=${pid} manually.`);
    process.exitCode = 1;
    return;
  }
  // Poll for the socket to disappear.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pingIpc(instance, 200))) {
      println(`Daemon stopped (was pid=${pid}).`);
      return;
    }
    await sleep(100);
  }
  println(`Daemon did not exit in ${timeoutMs}ms; pid=${pid} may still be running.`);
  process.exitCode = 1;
}

// ─── status ───────────────────────────────────────────────────────────

export interface DaemonStatusOptions {
  readonly instance?: string;
}

export async function runDaemonStatus(options: DaemonStatusOptions = {}): Promise<void> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const endpoint = ipcPath(instance);

  const pid = await identifyIpcDaemon(instance, 500);
  if (pid === null) {
    println(`brisk daemon (${instance}): not running`);
    println(`  endpoint=${endpoint}`);
    process.exitCode = 1;
    return;
  }

  // Ask for the full session info too — costs one extra round trip.
  let session: unknown = null;
  let connection: unknown = null;
  try {
    session = await ipcRequest(instance, { meta: 'session' }, { timeoutMs: 1500 });
  } catch {
    // ignore
  }
  try {
    connection = await ipcRequest(instance, { meta: 'connection_status' }, { timeoutMs: 1500 });
  } catch {
    // ignore
  }

  println(`brisk daemon (${instance}): running pid=${pid}`);
  println(`  endpoint=${endpoint}`);
  if (session && typeof session === 'object') {
    const s = session as { sessionId?: string | null; targetId?: string | null };
    println(`  session  ${s.sessionId ?? '(detached)'}`);
    println(`  target   ${s.targetId ?? '(detached)'}`);
  }
  if (connection && typeof connection === 'object') {
    const c = connection as {
      status?: string;
      version?: string;
      userAgent?: string;
    };
    println(`  cdp      ${c.status ?? 'unknown'}${c.version ? `  (${c.version})` : ''}`);
    if (c.userAgent) println(`  ua       ${c.userAgent}`);
  }
}

// ─── utility ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
