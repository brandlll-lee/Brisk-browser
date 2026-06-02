/**
 * Streamable HTTP transport — for Cursor / Cline / Continue and remote
 * MCP clients.
 *
 * Implements the MCP 2025-06-18 Streamable HTTP spec
 *   https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
 * via `@modelcontextprotocol/sdk/server/streamableHttp`. We use the
 * Node-HTTP variant (IncomingMessage/ServerResponse), which the SDK
 * implements as a thin wrapper over its Web Standard transport using
 * `@hono/node-server`'s request listener bridge.
 *
 * Stateful sessions (`sessionIdGenerator` returns a UUID) let one MCP
 * client maintain a persistent CDP attachment across requests — the
 * default Brisk mode. For multi-tenant deployments, pass
 * `sessionIdGenerator: undefined` to get a fresh server per request.
 *
 * SECURITY: by default we enforce Origin allow-list (Brisk doesn't
 * accept cross-origin requests). Pass `allowedOrigins: ['*']` to
 * disable, but only when you know the listener is bound to loopback.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';

import type { BriskToolContext } from '../framework.js';
import { createBriskMcpServer } from '../server-factory.js';

// ─── Options ────────────────────────────────────────────────────────

export interface HttpServerOptions {
  /** Helpers' + skills' execution context (shared across all sessions). */
  readonly ctx: BriskToolContext;
  /**
   * Origin allow-list. Defaults to `['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'null']`.
   * Any request whose `Origin` header (lowercased, port stripped) isn't in this list is rejected
   * with 403. Set to `['*']` to disable (NOT recommended for non-loopback servers).
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Generate a session id. Defaults to `crypto.randomUUID`. Pass
   * `undefined` for stateless (per-request) mode.
   */
  readonly sessionIdGenerator?: (() => string) | null;
  /** Path the MCP endpoint is mounted at. Default `/mcp`. */
  readonly path?: string;
  /**
   * Directory containing `<name>.md` files exposed as
   * `mcp://brisk/interaction/<name>`. Default `<cwd>/interaction-skills`. Set `false` to skip.
   */
  readonly interactionSkillsDir?: string | false;
  /** Logger sink. */
  readonly logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

const DEFAULT_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'null'] as const;

interface Session {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

// ─── Factory ─────────────────────────────────────────────────────────

export interface BriskHttpServer {
  /** Hono app — pass to `@hono/node-server`'s `serve()`. */
  readonly app: Hono;
  /** Active session count (debug / health). */
  activeSessions(): number;
  /** Force-close all sessions (call before process exit). */
  shutdown(): Promise<void>;
}

/**
 * Build a Hono app that hosts the MCP Streamable HTTP endpoint.
 *
 * Wire it to a real port with `@hono/node-server`:
 *
 *   const { app, shutdown } = createBriskHttpServer({ ctx });
 *   const server = serve({ fetch: app.fetch, port: 9333 });
 *   ...
 *   await shutdown();
 *   server.close();
 */
export function createBriskHttpServer(options: HttpServerOptions): BriskHttpServer {
  const app = new Hono();
  const path = options.path ?? '/mcp';
  const allowed = new Set((options.allowedOrigins ?? DEFAULT_ORIGINS).map((o) => o.toLowerCase()));
  const acceptsAll = allowed.has('*');
  const sessionIdGen =
    options.sessionIdGenerator === undefined ? randomUUID : options.sessionIdGenerator;

  const sessions = new Map<string, Session>();

  app.all(path, async (c) => {
    const origin = c.req.header('origin');
    if (!acceptsAll && origin && !originAllowed(origin, allowed)) {
      options.logger?.warn(`MCP HTTP: rejected Origin=${origin}`);
      return c.json({ error: 'origin not allowed' }, 403);
    }

    // 1) Resolve / create the session.
    const sessionId = c.req.header('mcp-session-id') ?? undefined;
    let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      // Forward declare so onsessioninitialized closure can capture them.
      let assignedServer: McpServer | null = null;
      let assignedTransport: StreamableHTTPServerTransport | null = null;
      type TransportOptions = ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
      const transportOptions: TransportOptions = {
        sessionIdGenerator: sessionIdGen ?? (() => randomUUID()),
        onsessioninitialized: (id) => {
          options.logger?.info(`MCP HTTP session initialized: ${id}`);
          if (assignedServer && assignedTransport) {
            sessions.set(id, { server: assignedServer, transport: assignedTransport });
          }
        },
        onsessionclosed: (id) => {
          options.logger?.info(`MCP HTTP session closed: ${id}`);
          sessions.delete(id);
        },
      };
      const transport = new StreamableHTTPServerTransport(transportOptions);
      const server = await createBriskMcpServer({
        ctx: options.ctx,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.interactionSkillsDir !== undefined
          ? { interactionSkillsDir: options.interactionSkillsDir }
          : {}),
      });
      assignedServer = server;
      assignedTransport = transport;
      // Cast: SDK declares `Transport.onclose: () => void` non-optional under
      // exactOptionalPropertyTypes, but `connect()` works fine when it's
      // truly optional at runtime.
      await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
      session = { server, transport };
    }

    // 2) Hand off to the transport, which writes the response.
    // Hono's `c.req.raw` is a Web Request — we need a Node
    // IncomingMessage / ServerResponse pair, which `@hono/node-server`
    // exposes via context's `env.incoming` / `env.outgoing` fields.
    const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse };
    if (!env.incoming || !env.outgoing) {
      throw new Error(
        'StreamableHTTP requires Hono running on @hono/node-server (env.incoming/outgoing missing)',
      );
    }
    await session.transport.handleRequest(env.incoming, env.outgoing);
    // Tell Hono the response was already written.
    return new Response(null);
  });

  return {
    app,
    activeSessions: () => sessions.size,
    async shutdown() {
      for (const s of sessions.values()) {
        try {
          await s.transport.close();
        } catch {
          // ignore
        }
      }
      sessions.clear();
    },
  };
}

function originAllowed(origin: string, allowed: Set<string>): boolean {
  // Strip the port for the comparison.
  const lower = origin.toLowerCase();
  try {
    const parsed = new URL(lower);
    const hostNoPort = `${parsed.protocol}//${parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname}`;
    return allowed.has(lower) || allowed.has(hostNoPort);
  } catch {
    return allowed.has(lower);
  }
}
