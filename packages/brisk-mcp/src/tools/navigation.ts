/**
 * Navigation tool wrappers — 8 tools.
 *
 * Each wrapper:
 *   • exposes a Zod input shape (validated by McpServer.registerTool)
 *   • declares a Zod output shape (so MCP can surface structuredContent)
 *   • delegates to the matching `@brisk/core/helpers/navigation` function
 */

import {
  closeTab,
  currentTab,
  ensureRealTab,
  type GotoArgs,
  goto,
  iframeTarget,
  listTabs,
  newTab,
  switchTab,
} from '@brisk/core';
import { ok } from '@brisk/types';
import { z } from 'zod';

import { defineTool } from '../framework.js';

const TRANSITION_TYPES = [
  'link',
  'typed',
  'address_bar',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'auto_toplevel',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
  'other',
] as const;

export const gotoTool = defineTool({
  name: 'goto_url',
  category: 'navigation',
  title: 'Navigate to URL',
  description:
    'Load `url` in the currently attached tab. Returns the navigation frameId. ' +
    'Does NOT wait for the page to finish loading — call `wait_for_load` or ' +
    '`wait_for_network_idle` next if you need that.',
  inputSchema: {
    url: z.string().min(1).describe('Absolute URL to navigate to.'),
    referrer: z.string().optional(),
    transitionType: z.enum(TRANSITION_TYPES).optional(),
    frameId: z.string().optional(),
  },
  outputSchema: {
    frameId: z.string(),
    loaderId: z.string().optional(),
    errorText: z.string().optional(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/scrolling.md'],
  handler: (args, ctx) => goto(ctx, args as unknown as GotoArgs),
});

export const newTabTool = defineTool({
  name: 'new_tab',
  category: 'navigation',
  title: 'Open New Tab',
  description:
    'Open a new tab and switch to it. If `url` is omitted, the new tab opens on about:blank.',
  inputSchema: {
    url: z.string().optional().describe('Initial URL; defaults to about:blank.'),
  },
  outputSchema: {
    targetId: z.string(),
    sessionId: z.string(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/tabs.md'],
  handler: (args, ctx) => newTab(ctx, args.url !== undefined ? { url: args.url as string } : {}),
});

export const switchTabTool = defineTool({
  name: 'switch_tab',
  category: 'navigation',
  title: 'Switch Tab',
  description: 'Activate and attach to another tab by targetId.',
  inputSchema: {
    targetId: z.string().describe('targetId from list_tabs.'),
  },
  outputSchema: {
    sessionId: z.string(),
    targetId: z.string(),
  },
  annotations: { destructiveHint: false },
  seeAlso: ['interaction-skills/tabs.md'],
  handler: (args, ctx) => switchTab(ctx, { target: args.targetId as string }),
});

export const closeTabTool = defineTool({
  name: 'close_tab',
  category: 'navigation',
  title: 'Close Tab',
  description:
    'Close a tab. Omit `targetId` to close the currently attached tab. ' +
    'Note: closing the attached tab will leave the daemon detached.',
  inputSchema: {
    targetId: z.string().optional(),
  },
  outputSchema: {
    closedTargetId: z.string(),
    success: z.boolean(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/tabs.md'],
  handler: (args, ctx) =>
    closeTab(ctx, args.targetId !== undefined ? { target: args.targetId as string } : {}),
});

export const listTabsTool = defineTool({
  name: 'list_tabs',
  category: 'navigation',
  title: 'List Tabs',
  description:
    'Snapshot the real pages currently open. By default excludes chrome:// / devtools:// / about: pages.',
  inputSchema: {
    includeChrome: z.boolean().optional(),
  },
  outputSchema: {
    tabs: z.array(
      z.object({
        targetId: z.string(),
        title: z.string(),
        url: z.string(),
      }),
    ),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/tabs.md'],
  handler: async (args, ctx) => {
    const r = await listTabs(
      ctx,
      args.includeChrome !== undefined ? { includeChrome: args.includeChrome as boolean } : {},
    );
    if (!r.ok) return r;
    return ok({ tabs: r.value });
  },
});

export const currentTabTool = defineTool({
  name: 'current_tab',
  category: 'navigation',
  title: 'Current Tab',
  description: "Get the attached tab's targetId, url, and title.",
  inputSchema: {},
  outputSchema: {
    targetId: z.string(),
    url: z.string(),
    title: z.string(),
  },
  annotations: { readOnlyHint: true },
  handler: (_args, ctx) => currentTab(ctx),
});

export const ensureRealTabTool = defineTool({
  name: 'ensure_real_tab',
  category: 'navigation',
  title: 'Ensure Real Tab',
  description:
    'Switch to a real user tab if the current attachment is on a chrome:// / ' +
    'devtools:// / about: page (or detached). Returns the first real tab if a ' +
    'switch happened, the current tab if it was already real, or null if there ' +
    'are no real tabs.',
  inputSchema: {},
  outputSchema: {
    tab: z.object({ targetId: z.string(), title: z.string(), url: z.string() }).nullable(),
    switched: z.boolean(),
  },
  annotations: { destructiveHint: false },
  handler: (_args, ctx) => ensureRealTab(ctx),
});

export const iframeTargetTool = defineTool({
  name: 'iframe_target',
  category: 'navigation',
  title: 'Find Iframe Target',
  description:
    'Find the first iframe target whose URL contains `urlSubstring` and attach to it. ' +
    'Pass the returned `sessionId` to `js` to run code inside the iframe.',
  inputSchema: {
    urlSubstring: z.string().min(1),
  },
  outputSchema: {
    targetId: z.string().nullable(),
    sessionId: z.string().optional(),
    url: z.string().optional(),
  },
  annotations: { readOnlyHint: true },
  seeAlso: ['interaction-skills/iframes.md', 'interaction-skills/cross-origin-iframes.md'],
  handler: (args, ctx) => iframeTarget(ctx, { urlSubstring: args.urlSubstring as string }),
});

export const navigationTools = [
  gotoTool,
  newTabTool,
  switchTabTool,
  closeTabTool,
  listTabsTool,
  currentTabTool,
  ensureRealTabTool,
  iframeTargetTool,
];
