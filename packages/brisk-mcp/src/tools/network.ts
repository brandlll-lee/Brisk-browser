/**
 * Network tool wrappers — 2 tools (http_get, cdp).
 */

import { type CdpRawArgs, cdpRaw, type HttpGetArgs, httpGet } from '@brisk/core';
import { z } from 'zod';

import { defineTool } from '../framework.js';

export const httpGetTool = defineTool({
  name: 'http_get',
  category: 'network',
  title: 'HTTP GET (bypass browser)',
  description:
    'Plain HTTP request from the daemon process — bypasses the browser entirely. Use for ' +
    "static pages, REST APIs, or robots.txt where you don't want to spend a tab.",
  inputSchema: {
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutSeconds: z.number().positive().optional(),
    method: z.string().optional(),
    body: z.string().optional(),
    maxLength: z.number().int().positive().optional(),
  },
  outputSchema: {
    url: z.string(),
    status: z.number(),
    contentType: z.string(),
    headers: z.record(z.string(), z.string()),
    text: z.string(),
    bytes: z.number(),
    truncated: z.boolean(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: (args, ctx) => httpGet(ctx, args as unknown as HttpGetArgs),
});

export const cdpTool = defineTool({
  name: 'cdp',
  category: 'network',
  title: 'Raw CDP Passthrough',
  description:
    'Issue any CDP method with arbitrary params. Use ONLY when no other Brisk tool wraps the ' +
    'method. Omit `sessionId` for browser-level methods (Target.*, Browser.*) or to use the ' +
    'attached page session.',
  inputSchema: {
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    method: z.string(),
    result: z.unknown(),
  },
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: (args, ctx) => cdpRaw(ctx, args as unknown as CdpRawArgs),
});

export const networkTools = [httpGetTool, cdpTool];
