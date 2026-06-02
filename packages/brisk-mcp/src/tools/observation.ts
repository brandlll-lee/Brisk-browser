/**
 * Observation tool wrappers — 6 tools: capture_screenshot, page_info,
 * js, drain_events, dom, get_console_logs.
 */

import {
  type CaptureScreenshotArgs,
  captureScreenshot,
  type DomArgs,
  dom,
  drainEvents,
  type GetConsoleLogsArgs,
  getConsoleLogs,
  type JsArgs,
  js,
  pageInfo,
} from '@brisk/core';
import { ok } from '@brisk/types';
import { z } from 'zod';

import { defineTool } from '../framework.js';

export const captureScreenshotTool = defineTool({
  name: 'capture_screenshot',
  category: 'observation',
  title: 'Capture Screenshot',
  description:
    'Capture a screenshot of the attached tab. By default captures the visible viewport as PNG. ' +
    'Set `fullPage: true` to capture beyond the viewport, or use `clip` to capture a region. ' +
    'Returns the image as base64 — embed via `_meta.image` or write to disk.',
  inputSchema: {
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    quality: z.number().min(0).max(100).optional(),
    fullPage: z.boolean().optional(),
    optimizeForSpeed: z.boolean().optional(),
    clip: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        scale: z.number(),
      })
      .optional(),
  },
  outputSchema: {
    format: z.enum(['png', 'jpeg', 'webp']),
    bytesBase64: z.string(),
    byteLength: z.number(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/screenshots.md'],
  handler: async (args, ctx) => {
    const r = await captureScreenshot(ctx, args as unknown as CaptureScreenshotArgs);
    if (!r.ok) return r;
    const buf = Buffer.from(r.value.bytes);
    return ok({
      format: r.value.format,
      bytesBase64: buf.toString('base64'),
      byteLength: buf.byteLength,
    });
  },
});

export const pageInfoTool = defineTool({
  name: 'page_info',
  category: 'observation',
  title: 'Page Info',
  description:
    'Get viewport + scroll + page-size snapshot of the attached tab. ' +
    'If a native dialog is open, returns `{kind: "dialog", dialog}` instead — ' +
    "the page's JS thread is frozen until you handle the dialog.",
  inputSchema: {},
  outputSchema: {
    kind: z.enum(['page', 'dialog']),
    info: z
      .object({
        url: z.string(),
        title: z.string(),
        w: z.number(),
        h: z.number(),
        sx: z.number(),
        sy: z.number(),
        pw: z.number(),
        ph: z.number(),
      })
      .optional(),
    dialog: z
      .object({
        type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
        message: z.string(),
        defaultPrompt: z.string().optional(),
        url: z.string(),
        hasBrowserHandler: z.boolean(),
      })
      .optional(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/dialogs.md', 'interaction-skills/viewport.md'],
  handler: async (_args, ctx) => {
    const r = await pageInfo(ctx);
    if (!r.ok) return r;
    if (r.value.kind === 'page') return ok({ kind: 'page', info: r.value.info });
    return ok({ kind: 'dialog', dialog: r.value.dialog });
  },
});

export const jsTool = defineTool({
  name: 'js',
  category: 'observation',
  title: 'Evaluate JS',
  description:
    'Run a JavaScript expression in the attached tab. Top-level `return` is auto-wrapped ' +
    'in an IIFE — both `document.title` and `const x=1; return x` work. Pass `sessionId` ' +
    'to run inside a specific iframe (see `iframe_target`).',
  inputSchema: {
    expression: z.string().min(1),
    awaitPromise: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    value: z.unknown(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => js(ctx, args as unknown as JsArgs),
});

export const drainEventsTool = defineTool({
  name: 'drain_events',
  category: 'observation',
  title: 'Drain CDP Events',
  description:
    "Get and clear the daemon's buffered CDP events (max 500). Useful for inspecting " +
    'what happened since the last action. `wait_for_network_idle` and console-log ' +
    'helpers consume the same buffer.',
  inputSchema: {},
  outputSchema: {
    events: z.array(
      z.object({
        method: z.string(),
        params: z.unknown(),
        sessionId: z.string().optional(),
        timestamp: z.number(),
      }),
    ),
  },
  annotations: { destructiveHint: true },
  handler: (_args, ctx) => drainEvents(ctx),
});

export const domTool = defineTool({
  name: 'dom',
  category: 'observation',
  title: 'Inspect DOM',
  description:
    'Inspect the DOM tree. Omit `selector` to fetch the whole document (depth=2 by default). ' +
    'Pass a selector to receive the nodeId + node info for the first match. Pierce defaults to true ' +
    'so shadow DOM and iframes are traversed.',
  inputSchema: {
    selector: z.string().optional(),
    depth: z.number().int().optional(),
    pierce: z.boolean().optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    nodeId: z.number().nullable(),
    tree: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/dom-inspection.md', 'interaction-skills/iframes.md'],
  handler: (args, ctx) => dom(ctx, args as unknown as DomArgs),
});

export const getConsoleLogsTool = defineTool({
  name: 'get_console_logs',
  category: 'observation',
  title: 'Get Console Logs',
  description:
    'Read console / exception / browser-log entries for the attached page. Defaults to ' +
    'level "info" (info + warning + error). Pass `clear: true` to reset the buffer.',
  inputSchema: {
    level: z.enum(['error', 'warning', 'info', 'debug']).optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    clear: z.boolean().optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    entries: z.array(
      z.object({
        source: z.enum(['console', 'exception', 'browser']),
        level: z.enum(['error', 'warning', 'info', 'debug']),
        text: z.string(),
        url: z.string().optional(),
        lineNumber: z.number().optional(),
        timestamp: z.number(),
      }),
    ),
    totalCount: z.number(),
    returnedCount: z.number(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/console-logs.md'],
  handler: (args, ctx) => getConsoleLogs(ctx, args as unknown as GetConsoleLogsArgs),
});

export const observationTools = [
  captureScreenshotTool,
  pageInfoTool,
  jsTool,
  drainEventsTool,
  domTool,
  getConsoleLogsTool,
];
