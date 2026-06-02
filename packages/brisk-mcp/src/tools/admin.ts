/**
 * Admin tool wrappers — 3 tools (connection_status, restart_daemon, pending_dialog).
 */

import {
  connectionStatus,
  pendingDialog,
  type RestartDaemonArgs,
  restartDaemon,
} from '@brisk/core';
import { z } from 'zod';

import { defineTool } from '../framework.js';

export const connectionStatusTool = defineTool({
  name: 'connection_status',
  category: 'admin',
  title: 'Connection Status',
  description:
    "Snapshot the daemon's CDP connection: is the WebSocket up? what page is attached? what's " +
    'the Chrome user-agent? Cheap (one Browser.getVersion call).',
  inputSchema: {},
  outputSchema: {
    status: z.enum(['connected', 'connecting', 'disconnected']),
    sessionId: z.string().nullable(),
    targetId: z.string().nullable(),
    version: z.string().optional(),
    userAgent: z.string().optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: (_args, ctx) => connectionStatus(ctx),
});

export const restartDaemonTool = defineTool({
  name: 'restart_daemon',
  category: 'admin',
  title: 'Restart Daemon (reconnect CDP)',
  description:
    'Tear down and re-establish the CDP WebSocket, then re-attach to the first real tab. ' +
    'Use when the daemon shows "disconnected" or when you want a fresh session after Chrome ' +
    'reload.',
  inputSchema: {
    skipReattach: z.boolean().optional(),
  },
  outputSchema: {
    reconnected: z.boolean(),
    sessionId: z.string().nullable(),
    targetId: z.string().nullable(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => restartDaemon(ctx, args as unknown as RestartDaemonArgs),
});

export const pendingDialogTool = defineTool({
  name: 'pending_dialog',
  category: 'admin',
  title: 'Pending Dialog',
  description:
    'Get the currently open JavaScript dialog (alert/confirm/prompt/beforeunload), if any. ' +
    'Use this before any other tool if `page_info` returns `{kind: "dialog"}` — the page\'s JS ' +
    'thread is frozen until the dialog is dismissed via `Page.handleJavaScriptDialog` (use `cdp`).',
  inputSchema: {},
  outputSchema: {
    dialog: z
      .object({
        type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
        message: z.string(),
        defaultPrompt: z.string().optional(),
        url: z.string(),
        hasBrowserHandler: z.boolean(),
      })
      .nullable(),
  },
  annotations: { readOnlyHint: true },
  handler: (_args, ctx) => pendingDialog(ctx),
});

export const adminTools = [connectionStatusTool, restartDaemonTool, pendingDialogTool];
