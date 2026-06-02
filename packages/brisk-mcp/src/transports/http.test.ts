import { describe, expect, it } from 'vitest';

import type { BriskToolContext } from '../framework.js';
import { createBriskHttpServer } from './http.js';

function stubCtx(): BriskToolContext {
  return {
    daemon: {} as never,
    cdp: {} as never,
    skills: null,
  };
}

describe('createBriskHttpServer origin guard', () => {
  it('rejects unknown origins before MCP handling', async () => {
    const http = createBriskHttpServer({ ctx: stubCtx() });
    const res = await http.app.request('/mcp', {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects port mismatches even when host matches', async () => {
    const http = createBriskHttpServer({
      ctx: stubCtx(),
      allowedOrigins: ['http://localhost:5173'],
    });
    const res = await http.app.request('/mcp', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5174' },
    });
    expect(res.status).toBe(403);
  });

  it('allows requests without Origin for local MCP clients', async () => {
    const http = createBriskHttpServer({ ctx: stubCtx() });
    const res = await http.app.request('/mcp', { method: 'POST' });
    expect(res.status).not.toBe(403);
  });

  it('allows exact allowlisted origins', async () => {
    const http = createBriskHttpServer({ ctx: stubCtx() });
    const res = await http.app.request('/mcp', {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
    });
    expect(res.status).not.toBe(403);
  });
});
