#!/usr/bin/env node
/**
 * Brisk CLI entry point.
 *
 *   brisk doctor                            — quick environment check
 *   brisk chrome --port 9222                — launch Chrome for Way-2 attach
 *   brisk daemon start                      — start a long-lived IPC daemon
 *   brisk daemon stop                       — stop a running daemon
 *   brisk daemon status                     — print daemon status
 *   brisk serve --transport stdio|http      — start the MCP server
 *   brisk version
 */

import { Command } from 'commander';

import { runChrome } from './commands/chrome.js';
import { runDaemonStart, runDaemonStatus, runDaemonStop } from './commands/daemon.js';
import { runDoctor } from './commands/doctor.js';
import { runServe } from './commands/serve.js';

const VERSION = '0.1.0' as const;

function parsePort(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) return fallback;
  return n;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('brisk')
    .description('Brisk — AI-native browser harness (thin CDP + MCP layer)')
    .version(VERSION, '-V, --version', 'Print Brisk version')
    .showHelpAfterError();

  // ─── brisk doctor ────────────────────────────────────────────────
  program
    .command('doctor')
    .description('Quick environment check (Node, CDP, IPC)')
    .option('--cdp-port <n>', 'remote-debugging-port', (v) => parsePort(v, 9222))
    .option('--cdp-url <url>', 'Chrome HTTP debug endpoint, e.g. http://localhost:9222')
    .option('--cdp-ws <url>', 'Direct CDP WebSocket URL')
    .option('--instance <name>', 'Daemon instance name', 'default')
    .action(
      async (opts: { cdpPort?: number; cdpUrl?: string; cdpWs?: string; instance: string }) => {
        await runDoctor({
          ...(opts.cdpPort !== undefined ? { cdpPort: opts.cdpPort } : {}),
          ...(opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : {}),
          ...(opts.cdpWs ? { cdpWs: opts.cdpWs } : {}),
          instance: opts.instance,
        });
      },
    );

  // ─── brisk chrome ───────────────────────────────────────────────
  program
    .command('chrome')
    .description('Launch Chrome (or Edge/Brave/Chromium) with remote-debugging enabled')
    .option('-p, --port <n>', 'remote-debugging-port', (v) => parsePort(v, 9222), 9222)
    .option('--user-data-dir <path>', 'Override the temporary user-data-dir')
    .option('--chrome-path <path>', 'Explicit Chrome binary path')
    .option('--brand <name>', 'Browser brand: chrome|chromium|edge|brave|...')
    .option('--headless', 'Run Chrome headless (--headless=new)')
    .option('--dry-run', 'Print the launch command without executing')
    .option('--detach', 'Spawn detached and exit immediately')
    .option('--arg <flag>', 'Extra Chrome flag (repeatable)', (val, prev: string[] = []) => {
      prev.push(val);
      return prev;
    })
    .action(
      async (opts: {
        port: number;
        userDataDir?: string;
        chromePath?: string;
        brand?: string;
        headless?: boolean;
        dryRun?: boolean;
        detach?: boolean;
        arg?: string[];
      }) => {
        await runChrome({
          port: opts.port,
          ...(opts.userDataDir !== undefined ? { userDataDir: opts.userDataDir } : {}),
          ...(opts.chromePath !== undefined ? { chromePath: opts.chromePath } : {}),
          ...(opts.brand !== undefined ? { brand: opts.brand as never } : {}),
          ...(opts.headless === true ? { headless: true } : {}),
          ...(opts.dryRun === true ? { dryRun: true } : {}),
          ...(opts.detach === true ? { detach: true } : {}),
          ...(opts.arg ? { extraArgs: opts.arg } : {}),
        });
      },
    );

  // ─── brisk serve ────────────────────────────────────────────────
  program
    .command('serve')
    .description('Start the Brisk MCP server (stdio or Streamable HTTP)')
    .option('-t, --transport <type>', 'Transport: "stdio" or "http"', 'stdio')
    .option('-p, --port <n>', 'HTTP port (when --transport=http)', (v) => parsePort(v, 9100), 9100)
    .option('-H, --host <name>', 'HTTP host', '127.0.0.1')
    .option('--allow-remote', 'Allow HTTP transport to bind a non-loopback host')
    .option('--cdp-port <n>', 'remote-debugging-port', (v) => parsePort(v, 9222))
    .option('--cdp-url <url>', 'Chrome HTTP debug endpoint')
    .option('--cdp-ws <url>', 'Direct CDP WebSocket URL')
    .option('--workspace <path>', 'agent-workspace directory')
    .option('--interaction-skills <path>', 'Directory of interaction-skill markdown files')
    .option('--no-interaction-skills', 'Skip interaction-skills MCP resources')
    .option('--no-skills', 'Skip the brisk-skills SQLite store')
    .action(
      async (opts: {
        transport: string;
        port: number;
        host: string;
        cdpPort?: number;
        cdpUrl?: string;
        cdpWs?: string;
        workspace?: string;
        interactionSkills?: string;
        noInteractionSkills?: boolean;
        noSkills?: boolean;
        allowRemote?: boolean;
      }) => {
        const transport = opts.transport === 'http' ? 'http' : 'stdio';
        await runServe({
          transport,
          port: opts.port,
          host: opts.host,
          ...(opts.cdpPort !== undefined ? { cdpPort: opts.cdpPort } : {}),
          ...(opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : {}),
          ...(opts.cdpWs ? { cdpWs: opts.cdpWs } : {}),
          ...(opts.workspace ? { workspaceRoot: opts.workspace } : {}),
          ...(opts.interactionSkills ? { interactionSkillsDir: opts.interactionSkills } : {}),
          ...(opts.noInteractionSkills === true ? { noInteractionSkills: true } : {}),
          ...(opts.noSkills === true ? { noSkills: true } : {}),
          ...(opts.allowRemote === true ? { allowRemote: true } : {}),
        });
      },
    );

  // ─── brisk daemon ─────────────────────────────────────────────────
  const daemon = program.command('daemon').description('Manage the long-lived IPC daemon');

  daemon
    .command('start')
    .description('Start the daemon (blocks until SIGINT)')
    .option('--instance <name>', 'Daemon instance name', 'default')
    .option('--cdp-port <n>', 'remote-debugging-port', (v) => parsePort(v, 9222))
    .option('--cdp-url <url>', 'Chrome HTTP debug endpoint')
    .option('--cdp-ws <url>', 'Direct CDP WebSocket URL')
    .option('--workspace <path>', 'agent-workspace directory')
    .option('--no-skills', 'Skip the brisk-skills SQLite store')
    .action(
      async (opts: {
        instance: string;
        cdpPort?: number;
        cdpUrl?: string;
        cdpWs?: string;
        workspace?: string;
        noSkills?: boolean;
      }) => {
        await runDaemonStart({
          instance: opts.instance,
          ...(opts.cdpPort !== undefined ? { cdpPort: opts.cdpPort } : {}),
          ...(opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : {}),
          ...(opts.cdpWs ? { cdpWs: opts.cdpWs } : {}),
          ...(opts.workspace ? { workspaceRoot: opts.workspace } : {}),
          ...(opts.noSkills === true ? { noSkills: true } : {}),
        });
      },
    );

  daemon
    .command('stop')
    .description('Stop a running daemon')
    .option('--instance <name>', 'Daemon instance name', 'default')
    .option('--timeout <ms>', 'How long to wait for shutdown', (v) => parsePort(v, 3000), 3000)
    .action(async (opts: { instance: string; timeout: number }) => {
      await runDaemonStop({ instance: opts.instance, timeoutMs: opts.timeout });
    });

  daemon
    .command('status')
    .description('Print daemon status')
    .option('--instance <name>', 'Daemon instance name', 'default')
    .action(async (opts: { instance: string }) => {
      await runDaemonStatus({ instance: opts.instance });
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[brisk] fatal: ${message}\n`);
  process.exit(2);
});
