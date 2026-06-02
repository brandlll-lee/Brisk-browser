/**
 * Tool registry — bind a list of `BriskTool` to an MCP server.
 *
 * Each tool is registered via `McpServer.registerTool(name, config, cb)`.
 * The framework's `executeTool` runs the handler and formats the result
 * — the registered callback is a thin shim.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BriskTool, BriskToolContext } from './framework.js';
import { executeTool } from './framework.js';

export interface RegistryOptions {
  /** McpServer to attach tools to. */
  readonly server: McpServer;
  /** Helpers' + skills' execution context. */
  readonly ctx: BriskToolContext;
  /** Tools to register. */
  readonly tools: readonly BriskTool[];
  /** Optional logger. Receives one line per registered tool. */
  readonly logger?: { info(msg: string): void };
}

/** Register every tool in `options.tools` on `options.server`. */
export function registerTools(options: RegistryOptions): void {
  const seen = new Set<string>();
  for (const tool of options.tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    seen.add(tool.name);

    // Build the config object — fields are conditionally added so
    // exactOptionalPropertyTypes doesn't complain about explicit undefined.
    type ToolConfig = {
      title: string;
      description: string;
      inputSchema: BriskTool['inputSchema'];
      outputSchema?: BriskTool['outputSchema'];
      annotations?: BriskTool['annotations'];
    };
    const config: ToolConfig = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (tool.outputSchema) config.outputSchema = tool.outputSchema;
    if (tool.annotations) config.annotations = tool.annotations;

    // Cast: McpServer.registerTool has heavy generic overloads that don't
    // unify across our heterogeneous tool list. The runtime call site is
    // safe — McpServer just hands `inputSchema` to Zod and forwards
    // `outputSchema` to the structured-content validator.
    (
      options.server.registerTool as unknown as (
        name: string,
        cfg: ToolConfig,
        cb: (args: unknown) => Promise<unknown>,
      ) => unknown
    )(tool.name, config, async (args) => {
      return executeTool(tool, (args ?? {}) as Record<string, unknown>, options.ctx);
    });

    options.logger?.info(`registered tool: ${tool.name}`);
  }
}
