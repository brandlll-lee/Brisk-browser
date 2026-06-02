/**
 * @brisk/mcp — MCP layer over the Brisk engine.
 *
 * Exposes 25 tools at W3 (navigation 8 + observation 4 + input 9 + waits 4),
 * with the remaining 12 (network 2 + admin 3 + skills 5 + observation 2)
 * landing in W4-W5.
 *
 * Supports both Streamable HTTP (MCP 2025-06-18 spec) and stdio transports.
 * Each transport creates a fresh `McpServer` per session — required by
 * the MCP SDK 1.x security model.
 */

/** Machine-readable MCP server identifier (snake/kebab-case, ASCII). */
export const BRISK_MCP_SERVER_NAME = 'brisk-browser' as const;

/** Human-readable MCP server title shown in MCP clients (Claude Desktop / Cursor / Cline). */
export const BRISK_MCP_SERVER_TITLE = 'Brisk Browser' as const;

export const BRISK_MCP_VERSION = '0.1.0-dev' as const;
export const MCP_PROTOCOL_VERSION = '2025-06-18' as const;

// Framework
export {
  type BriskTool,
  type BriskToolContext,
  type CallToolResultLike,
  defineTool,
  executeTool,
  formatError,
  formatResult,
  type ToolAnnotations,
} from './framework.js';
export { type RegistryOptions, registerTools } from './registry.js';
export {
  discoverInteractionSkills,
  type RegisterResourcesOptions,
  type ResourceLogger,
  registerBriskResources,
} from './resources.js';
// Server factory + registry
export { type CreateServerOptions, createBriskMcpServer } from './server-factory.js';
// Tools
export {
  ALL_TOOLS,
  adminTools,
  inputTools,
  navigationTools,
  networkTools,
  observationTools,
  skillsTools,
  waitsTools,
} from './tools/index.js';
export {
  type BriskHttpServer,
  createBriskHttpServer,
  type HttpServerOptions,
} from './transports/http.js';
// Transports
export { type RunStdioOptions, runStdio, type StdioHandle } from './transports/stdio.js';
