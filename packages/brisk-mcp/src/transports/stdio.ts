/**
 * Stdio transport — for Claude Desktop / Cursor / Cline / Codex
 * local MCP integrations.
 *
 * Stdio is the simplest transport: stdin/stdout carry JSON-RPC frames,
 * one per line. Anything written to stderr is logging.
 *
 * Use this for desktop AI clients running in the same machine as the
 * Brisk daemon. For multi-client / remote setups use the HTTP transport.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface RunStdioOptions {
  /** The MCP server (already built via `createBriskMcpServer`). */
  readonly server: McpServer;
  /**
   * Called when the transport closes (peer disconnect, SIGINT, etc.).
   * Caller should release resources (CDP socket, daemon, etc.).
   */
  readonly onClose?: () => void;
}

export interface StdioHandle {
  /** Close the transport. Idempotent. */
  shutdown(): Promise<void>;
  /** Resolves when the transport reaches a steady state. */
  readonly ready: Promise<void>;
}

/**
 * Connect `server` to the process's stdin/stdout and return a handle.
 *
 * IMPORTANT: do NOT `console.log` from any tool handler once stdio is
 * connected — that corrupts the JSON-RPC frame. All Brisk loggers
 * default to no-op, but be careful with third-party deps.
 */
export function runStdio(options: RunStdioOptions): StdioHandle {
  const transport = new StdioServerTransport();

  const onClose = options.onClose;
  if (onClose) {
    // The SDK declares `onclose` as a non-optional property under
    // exactOptionalPropertyTypes. Assigning is still safe at runtime.
    (transport as { onclose?: () => void }).onclose = onClose;
  }

  // Cast: SDK declares `Transport.onclose: () => void` non-optional under
  // exactOptionalPropertyTypes, but it's actually optional at runtime.
  const ready = options.server.connect(
    transport as unknown as Parameters<typeof options.server.connect>[0],
  );
  let closed = false;
  return {
    ready,
    async shutdown() {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch {
        // ignore
      }
    },
  };
}
