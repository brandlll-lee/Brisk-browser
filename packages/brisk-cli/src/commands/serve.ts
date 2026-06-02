/**
 * `brisk serve` — start the MCP server.
 *
 * Two transports:
 *   • stdio: connect to the parent process via stdin/stdout. The default,
 *     and what Claude Desktop / Cursor / Cline expect.
 *   • http : start a Streamable HTTP listener on the configured port.
 *     Use this for hosted setups or when several MCP clients share a
 *     long-lived daemon.
 *
 * The same CDP backend + Daemon + SkillsManager triple boots in both modes.
 * The transport just changes how MCP messages flow in and out.
 */

import {
  type BriskToolContext,
  createBriskHttpServer,
  createBriskMcpServer,
  runStdio,
} from '@brisk/mcp';
import { serve } from '@hono/node-server';

import { type BootOptions, boot } from '../boot.js';
import { type CliLogger, createLogger, println } from '../logger.js';

export interface ServeOptions extends BootOptions {
  readonly transport: 'stdio' | 'http';
  /** HTTP port (only used when `transport === 'http'`). */
  readonly port?: number;
  /** HTTP host (default 127.0.0.1). */
  readonly host?: string;
  /** Interaction-skills directory exposed as MCP resources. */
  readonly interactionSkillsDir?: string;
  /** Disable interaction-skill resource registration. */
  readonly noInteractionSkills?: boolean;
  /** Pre-built logger; if absent we build one writing to stderr. */
  readonly logger?: CliLogger;
}

export async function runServe(options: ServeOptions): Promise<void> {
  // stdio mode: NO stdout writes; the parent expects clean JSON-RPC there.
  // Everything goes to stderr.
  const logger =
    options.logger ?? createLogger(options.transport === 'stdio' ? 'warn' : 'info', process.stderr);

  const boots = await boot({
    ...(options.cdpWs !== undefined ? { cdpWs: options.cdpWs } : {}),
    ...(options.cdpUrl !== undefined ? { cdpUrl: options.cdpUrl } : {}),
    ...(options.cdpPort !== undefined ? { cdpPort: options.cdpPort } : {}),
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.noSkills !== undefined ? { noSkills: options.noSkills } : {}),
    logger,
  });

  const ctx: BriskToolContext = {
    daemon: boots.daemon,
    cdp: boots.cdp,
    skills: boots.skills,
  };

  const interactionSkillsDir = options.noInteractionSkills
    ? (false as const)
    : (options.interactionSkillsDir ?? `${process.cwd()}/interaction-skills`);

  if (options.transport === 'stdio') {
    await runStdioMode(ctx, logger, boots.shutdown, interactionSkillsDir);
    return;
  }

  await runHttpMode(
    ctx,
    logger,
    boots.shutdown,
    options.port ?? 9100,
    options.host ?? '127.0.0.1',
    interactionSkillsDir,
  );
}

// ─── Stdio ────────────────────────────────────────────────────────────

async function runStdioMode(
  ctx: BriskToolContext,
  logger: CliLogger,
  shutdownBoot: () => Promise<void>,
  interactionSkillsDir: string | false,
): Promise<void> {
  logger.info('Starting MCP stdio transport…');
  const server = await createBriskMcpServer({
    ctx,
    interactionSkillsDir,
    logger,
  });

  const handle = runStdio({
    server,
    onClose: () => {
      logger.info('stdio transport closed; shutting down.');
      void shutdownBoot();
    },
  });

  await handle.ready;
  logger.info('MCP server ready over stdio.');

  await installSignalHandlers(async () => {
    await handle.shutdown();
    await shutdownBoot();
  });

  // Keep the process alive while stdio is connected. Once Node sees no
  // more references (stdin closed + no listeners) it'll exit.
  await new Promise<void>((resolve) => {
    const close = () => resolve();
    process.stdin.once('end', close);
    process.stdin.once('close', close);
  });
}

// ─── HTTP ─────────────────────────────────────────────────────────────

async function runHttpMode(
  ctx: BriskToolContext,
  logger: CliLogger,
  shutdownBoot: () => Promise<void>,
  port: number,
  host: string,
  interactionSkillsDir: string | false,
): Promise<void> {
  logger.info(`Starting MCP HTTP transport on http://${host}:${port}/mcp …`);
  const http = createBriskHttpServer({
    ctx,
    interactionSkillsDir,
    logger,
  });

  const listener = serve({ fetch: http.app.fetch, port, hostname: host }, (info) => {
    println(`Brisk MCP server: http://${info.address}:${info.port}/mcp`);
  });

  await installSignalHandlers(async () => {
    await http.shutdown();
    listener.close();
    await shutdownBoot();
  });

  // Block forever — serve() returns synchronously but keeps the loop alive.
  await new Promise<void>(() => {
    /* noop: signal handlers resolve via process.exit */
  });
}

// ─── Signals ──────────────────────────────────────────────────────────

async function installSignalHandlers(onShutdown: () => Promise<void>): Promise<void> {
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        try {
          await onShutdown();
        } finally {
          process.exit(0);
        }
      })();
    });
  }
}
