/**
 * Integration test for the registry → McpServer wiring.
 *
 * Strategy: spin up a real McpServer, register all 25 W3 tools, then
 * issue a synthetic `tools/list` JSON-RPC request through an in-memory
 * transport and assert each tool name surfaces with the expected shape.
 *
 * We don't need real CDP here — the ctx is a no-op stub; the tool
 * handlers are never invoked in this test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { registerTools } from './registry.js';
import {
  ALL_TOOLS,
  adminTools,
  inputTools,
  navigationTools,
  networkTools,
  observationTools,
  skillsTools,
  waitsTools,
} from './tools/index.js';

function stubCtx() {
  const log = () => {};
  return {
    daemon: {} as never,
    cdp: {} as never,
    logger: { debug: log, info: log, warn: log, error: log },
    skills: null,
  };
}

describe('registerTools', () => {
  it('registers all 37 V0.1.0 tools without duplicates', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() => registerTools({ server, ctx: stubCtx(), tools: ALL_TOOLS })).not.toThrow();
  });

  it('rejects duplicate registrations', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    expect(() =>
      registerTools({ server, ctx: stubCtx(), tools: [navigationTools[0], navigationTools[0]] }),
    ).toThrow(/Duplicate/);
  });

  it('exposes all tools via the SDK tool list handler', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTools({ server, ctx: stubCtx(), tools: ALL_TOOLS });

    // Drive the SDK's internal tool list through its request handler.
    const handlers = (
      server as unknown as {
        server: {
          _requestHandlers: Map<
            string,
            (req: unknown, extra: unknown) => Promise<{ tools: { name: string }[] }>
          >;
        };
      }
    ).server._requestHandlers;
    const list = handlers.get(ListToolsRequestSchema.shape.method.value);
    expect(list).toBeDefined();

    const response = await list?.(
      { method: 'tools/list', params: {} },
      {
        signal: new AbortController().signal,
        requestId: '1',
        sendNotification: () => {},
        sendRequest: () => Promise.resolve({}),
      },
    );
    const names = response?.tools.map((t: { name: string }) => t.name) ?? [];
    expect(names).toHaveLength(ALL_TOOLS.length);
    for (const tool of ALL_TOOLS) {
      expect(names).toContain(tool.name);
    }
  });

  it('keeps per-category counts in sync with the plan', () => {
    expect(navigationTools).toHaveLength(8);
    expect(observationTools).toHaveLength(6);
    expect(inputTools).toHaveLength(9);
    expect(waitsTools).toHaveLength(4);
    expect(networkTools).toHaveLength(2);
    expect(adminTools).toHaveLength(3);
    expect(skillsTools).toHaveLength(5);
    expect(ALL_TOOLS).toHaveLength(37);
  });
});
