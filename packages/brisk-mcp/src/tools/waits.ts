/**
 * Wait tool wrappers — 4 tools.
 */

import {
  type WaitArgs,
  type WaitForElementArgs,
  type WaitForLoadArgs,
  type WaitForNetworkIdleArgs,
  wait,
  waitForElement,
  waitForLoad,
  waitForNetworkIdle,
} from '@brisk/core';
import { z } from 'zod';

import { defineTool } from '../framework.js';

export const waitTool = defineTool({
  name: 'wait',
  category: 'waits',
  title: 'Wait (sleep)',
  description: 'Sleep for `seconds`. Useful between actions when nothing observable changes.',
  inputSchema: {
    seconds: z.number().nonnegative(),
  },
  outputSchema: {
    waitedSeconds: z.number(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: (args, ctx) => wait(ctx, args as unknown as WaitArgs),
});

export const waitForLoadTool = defineTool({
  name: 'wait_for_load',
  category: 'waits',
  title: 'Wait for Load',
  description:
    "Poll `document.readyState === 'complete'` until reached or timeout. Default 15s. " +
    'Returns `{ready: false}` on timeout (not an error).',
  inputSchema: {
    timeoutSeconds: z.number().positive().optional(),
    pollMs: z.number().int().positive().optional(),
  },
  outputSchema: {
    ready: z.boolean(),
    waitedMs: z.number(),
  },
  annotations: { readOnlyHint: true },
  handler: (args, ctx) => waitForLoad(ctx, args as unknown as WaitForLoadArgs),
});

export const waitForElementTool = defineTool({
  name: 'wait_for_element',
  category: 'waits',
  title: 'Wait for Element',
  description:
    'Poll `document.querySelector(selector)` until the element exists, or timeout (default 10s). ' +
    'Set `visible: true` to also require `checkVisibility()`.',
  inputSchema: {
    selector: z.string().min(1),
    timeoutSeconds: z.number().positive().optional(),
    visible: z.boolean().optional(),
    pollMs: z.number().int().positive().optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    found: z.boolean(),
    waitedMs: z.number(),
  },
  annotations: { readOnlyHint: true },
  handler: (args, ctx) => waitForElement(ctx, args as unknown as WaitForElementArgs),
});

export const waitForNetworkIdleTool = defineTool({
  name: 'wait_for_network_idle',
  category: 'waits',
  title: 'Wait for Network Idle',
  description:
    'Wait until no in-flight Network.* requests AND no Network.* events for `idleMs` ms ' +
    '(default 500ms within a 10s timeout). Filters events by active session.',
  inputSchema: {
    timeoutSeconds: z.number().positive().optional(),
    idleMs: z.number().int().nonnegative().optional(),
    pollMs: z.number().int().positive().optional(),
  },
  outputSchema: {
    idle: z.boolean(),
    waitedMs: z.number(),
    inflightAtEnd: z.number(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/network-requests.md'],
  handler: (args, ctx) => waitForNetworkIdle(ctx, args as unknown as WaitForNetworkIdleArgs),
});

export const waitsTools = [waitTool, waitForLoadTool, waitForElementTool, waitForNetworkIdleTool];
