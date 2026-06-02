/**
 * Build a fully-wired MCP server from a Brisk daemon + helpers ctx.
 *
 * The server is **per-instance** — callers should create a fresh one
 * for every stdio session or HTTP request. This matches the MCP SDK
 * 1.x guidance: don't share McpServer instances across transport
 * connections (https://github.com/modelcontextprotocol/typescript-sdk/issues/450
 * documents the race window).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BriskToolContext } from './framework.js';
import { BRISK_MCP_SERVER_NAME, BRISK_MCP_SERVER_TITLE, BRISK_MCP_VERSION } from './index.js';
import { registerTools } from './registry.js';
import { type ResourceLogger, registerBriskResources } from './resources.js';
import { ALL_TOOLS } from './tools/index.js';

export interface CreateServerOptions {
  /** Helpers' + skills' execution context (daemon + cdp + skills + logger). */
  readonly ctx: BriskToolContext;
  /** Optional override for the SDK Implementation name. */
  readonly name?: string;
  /** Optional override for the SDK Implementation title. */
  readonly title?: string;
  /** Optional override for the SDK Implementation version. */
  readonly version?: string;
  /** Optional registration-time logger. */
  readonly logger?: ResourceLogger & { info(msg: string): void };
  /**
   * Directory containing `<name>.md` files exposed as `mcp://brisk/interaction/<name>`.
   * Defaults to `<cwd>/interaction-skills`. Set to `false` to skip registration.
   */
  readonly interactionSkillsDir?: string | false;
}

/**
 * Build a fresh McpServer with all V0.1.0 tools + resources registered.
 *
 * The returned server is NOT yet connected to a transport — that's
 * the caller's job (see `transports/stdio.ts` and `transports/http.ts`).
 *
 * Note: returns a Promise because resource discovery is async (it
 * reads `interaction-skills/` from disk).
 */
export async function createBriskMcpServer(options: CreateServerOptions): Promise<McpServer> {
  const server = new McpServer({
    name: options.name ?? BRISK_MCP_SERVER_NAME,
    title: options.title ?? BRISK_MCP_SERVER_TITLE,
    version: options.version ?? BRISK_MCP_VERSION,
  });
  registerTools({
    server,
    ctx: options.ctx,
    tools: ALL_TOOLS,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const interactionDir =
    options.interactionSkillsDir === false
      ? undefined
      : (options.interactionSkillsDir ?? `${process.cwd()}/interaction-skills`);
  await registerBriskResources({
    server,
    skills: options.ctx.skills,
    ...(interactionDir ? { interactionSkillsDir: interactionDir } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return server;
}
