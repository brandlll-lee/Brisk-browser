/**
 * Navigation primitives — Page.navigate, tab inventory, current tab.
 *
 * Full 8-helper set: goto, newTab, switchTab, closeTab, listTabs,
 * currentTab, ensureRealTab, iframeTarget.
 *
 * Lineage: browser-harness helpers.py:158-355.
 */

import { briskError, err, ok } from '@brisk/types';

import { runCdp } from './_internal.js';
import type { HelperContext, HelperResult } from './types.js';

const TAB_MARKER = '\u{1F434}';
const TAB_MARKER_PREFIX = `${TAB_MARKER} `;
const TAB_UNMARK_JS = `if(document.title.startsWith('${TAB_MARKER_PREFIX}'))document.title=document.title.slice(${TAB_MARKER_PREFIX.length})`;

// ─── goto ────────────────────────────────────────────────────────────

export interface GotoArgs {
  readonly url: string;
  /** Optional Page.navigate referrer / transitionType / frameId override. */
  readonly referrer?: string;
  readonly transitionType?:
    | 'link'
    | 'typed'
    | 'address_bar'
    | 'auto_bookmark'
    | 'auto_subframe'
    | 'manual_subframe'
    | 'generated'
    | 'auto_toplevel'
    | 'form_submit'
    | 'reload'
    | 'keyword'
    | 'keyword_generated'
    | 'other';
  readonly frameId?: string;
}

export interface GotoResult {
  readonly frameId: string;
  readonly loaderId?: string;
  readonly errorText?: string;
}

/**
 * Navigate the attached tab to `url`. Mirrors browser-harness goto_url
 * (helpers.py:159-164) minus the optional domain-skills shim — that
 * lives in @brisk/skills (W4) so brisk-core stays MCP-agnostic.
 */
export function goto(ctx: HelperContext, args: GotoArgs): Promise<HelperResult<GotoResult>> {
  if (typeof args.url !== 'string' || args.url.length === 0) {
    return Promise.resolve(
      err(briskError('HELPER_INVALID_ARGS', 'goto: `url` must be a non-empty string')),
    );
  }
  const params: Record<string, unknown> = { url: args.url };
  if (args.referrer !== undefined) params.referrer = args.referrer;
  if (args.transitionType !== undefined) params.transitionType = args.transitionType;
  if (args.frameId !== undefined) params.frameId = args.frameId;

  return runCdp(() => ctx.daemon.callCdp<GotoResult>('Page.navigate', params));
}

// ─── currentTab ──────────────────────────────────────────────────────

export interface CurrentTabResult {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
}

/**
 * Resolve the attached page's targetId + url + title.
 *
 * Sends `Target.getTargetInfo` so the result is fresh (the daemon's
 * cached `target_id` doesn't carry title/url, and the URL can change
 * mid-session via SPA route updates). See browser-harness
 * helpers.py:294 and daemon.py:286 for the equivalent flow.
 */
export async function currentTab(ctx: HelperContext): Promise<HelperResult<CurrentTabResult>> {
  const { targetId } = ctx.daemon.getSession();
  if (!targetId) {
    return err(briskError('HELPER_NO_ACTIVE_PAGE', 'No attached tab'));
  }
  return runCdp(async () => {
    const r = await ctx.cdp.send<{
      targetInfo: { targetId: string; url?: string; title?: string };
    }>('Target.getTargetInfo', { targetId });
    return {
      targetId: r.targetInfo.targetId,
      url: r.targetInfo.url ?? '',
      title: r.targetInfo.title ?? '',
    };
  });
}

// ─── listTabs ────────────────────────────────────────────────────────

export interface TabInfo {
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
}

const INTERNAL_PREFIXES = [
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'chrome-extension://',
  'about:',
] as const;

export interface ListTabsArgs {
  /** Include chrome:// / devtools:// / about: tabs. Default false. */
  readonly includeChrome?: boolean;
}

/**
 * Snapshot the real pages currently open. Mirrors browser-harness
 * list_tabs (helpers.py:286-292), except `includeChrome` defaults to
 * **false** — LLMs almost never want to see settings/newtab/devtools
 * in the inventory, and reading helpers.py's API confused several
 * test runs in the BrowserOS migration.
 */
export async function listTabs(
  ctx: HelperContext,
  args: ListTabsArgs = {},
): Promise<HelperResult<readonly TabInfo[]>> {
  const includeChrome = args.includeChrome ?? false;
  return runCdp(async () => {
    const r = await ctx.cdp.send<{
      targetInfos: readonly { targetId: string; type: string; url?: string; title?: string }[];
    }>('Target.getTargets');
    const out: TabInfo[] = [];
    for (const t of r.targetInfos) {
      if (t.type !== 'page') continue;
      const url = t.url ?? '';
      if (!includeChrome && INTERNAL_PREFIXES.some((p) => url.startsWith(p))) continue;
      out.push({ targetId: t.targetId, title: t.title ?? '', url });
    }
    return out;
  });
}

// ─── newTab ──────────────────────────────────────────────────────────

export interface NewTabArgs {
  /** Initial URL. Defaults to `about:blank`. */
  readonly url?: string;
}

export interface NewTabResult {
  readonly targetId: string;
  readonly sessionId: string;
}

/**
 * Open a new tab and switch to it.
 *
 * Always creates `about:blank` first, then navigates — passing a URL
 * to `Target.createTarget` races with attach (the brief about:blank
 * is `complete` by the time the caller polls `wait_for_load`, which
 * then returns before navigation actually starts). Mirrors
 * browser-harness new_tab (helpers.py:317-325).
 */
export async function newTab(
  ctx: HelperContext,
  args: NewTabArgs = {},
): Promise<HelperResult<NewTabResult>> {
  return runCdp(async () => {
    const created = await ctx.cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const switched = await switchTabInternal(ctx, created.targetId);
    if (args.url !== undefined && args.url !== 'about:blank') {
      await ctx.daemon.callCdp('Page.navigate', { url: args.url });
    }
    return { targetId: created.targetId, sessionId: switched };
  });
}

// ─── switchTab ───────────────────────────────────────────────────────

export interface SwitchTabArgs {
  /** Target id or a TabInfo from listTabs/currentTab. */
  readonly target: string | { readonly targetId: string };
}

export interface SwitchTabResult {
  readonly sessionId: string;
  readonly targetId: string;
}

/**
 * Activate + attach to another tab. Marks the new tab with 🐴 and
 * un-marks the previously attached one. Mirrors browser-harness
 * switch_tab (helpers.py:303-315).
 */
export async function switchTab(
  ctx: HelperContext,
  args: SwitchTabArgs,
): Promise<HelperResult<SwitchTabResult>> {
  const targetId = typeof args.target === 'string' ? args.target : args.target.targetId;
  if (!targetId) {
    return err(briskError('HELPER_INVALID_ARGS', 'switchTab: target is required'));
  }
  return runCdp(async () => {
    const sessionId = await switchTabInternal(ctx, targetId);
    return { sessionId, targetId };
  });
}

async function switchTabInternal(ctx: HelperContext, targetId: string): Promise<string> {
  // Un-mark the previously attached tab. Best-effort — the old tab
  // may have closed or be unreachable. Browser-harness uses
  // `slice(3)` because the marker is a surrogate-pair emoji + space
  // (3 UTF-16 code units); we computed the same length above.
  const prev = ctx.daemon.getSession().sessionId;
  if (prev) {
    try {
      await ctx.cdp.sendOnSession(prev, 'Runtime.evaluate', { expression: TAB_UNMARK_JS });
    } catch {
      // ignore
    }
  }
  await ctx.cdp.send('Target.activateTarget', { targetId });
  const att = await ctx.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  // Let the daemon take over: enable domains on new session, run
  // mark-tab JS — exactly like the `set_session` meta from helpers.py.
  const resp = await ctx.daemon.handle({
    meta: 'set_session',
    sessionId: att.sessionId,
    targetId,
  });
  if ('error' in resp) {
    const e = resp.error;
    if (typeof e === 'string') throw briskError('CDP_PROTOCOL_ERROR', e);
    throw e;
  }
  return att.sessionId;
}

// ─── closeTab ────────────────────────────────────────────────────────

export interface CloseTabArgs {
  /** Tab id or info. Omit to close the currently attached tab. */
  readonly target?: string | { readonly targetId: string };
}

export interface CloseTabResult {
  readonly closedTargetId: string;
  readonly success: boolean;
}

/**
 * Close a tab. Defaults to closing the currently attached tab.
 * Mirrors browser-harness close_tab (helpers.py:327-333).
 */
export async function closeTab(
  ctx: HelperContext,
  args: CloseTabArgs = {},
): Promise<HelperResult<CloseTabResult>> {
  let targetId: string | undefined;
  if (typeof args.target === 'string') targetId = args.target;
  else if (args.target && typeof args.target === 'object') targetId = args.target.targetId;
  else targetId = ctx.daemon.getSession().targetId ?? undefined;

  if (!targetId) {
    return err(briskError('HELPER_NO_ACTIVE_PAGE', 'closeTab: no target id (no attached tab)'));
  }

  return runCdp(async () => {
    const r = await ctx.cdp.send<{ success?: boolean }>('Target.closeTarget', { targetId });
    return {
      closedTargetId: targetId,
      success: r.success ?? true,
    };
  });
}

// ─── ensureRealTab ───────────────────────────────────────────────────

export interface EnsureRealTabResult {
  readonly tab: TabInfo | null;
  readonly switched: boolean;
}

/**
 * Switch to a real user tab if the current attachment is on a
 * `chrome://` / `devtools://` / `about:` page (or detached).
 * Returns the first real tab if a switch happened, the current tab
 * if it was already real, or `{tab: null}` if no real tabs exist.
 *
 * Mirrors browser-harness ensure_real_tab (helpers.py:336-348).
 */
export async function ensureRealTab(
  ctx: HelperContext,
): Promise<HelperResult<EnsureRealTabResult>> {
  return runCdp(async () => {
    const tabs = await listTabs(ctx, { includeChrome: false });
    if (!tabs.ok) throw tabs.error;
    if (tabs.value.length === 0) return { tab: null, switched: false } as const;

    // Try to keep current if already real.
    try {
      const cur = await currentTab(ctx);
      if (cur.ok && cur.value.url && !isInternalUrl(cur.value.url)) {
        return {
          tab: { targetId: cur.value.targetId, url: cur.value.url, title: cur.value.title },
          switched: false,
        } as const;
      }
    } catch {
      // fall through to switch
    }

    const first = tabs.value[0];
    if (!first) return { tab: null, switched: false } as const;
    await switchTabInternal(ctx, first.targetId);
    return { tab: first, switched: true } as const;
  });
}

function isInternalUrl(url: string): boolean {
  return INTERNAL_PREFIXES.some((p) => url.startsWith(p));
}

// ─── iframeTarget ────────────────────────────────────────────────────

export interface IframeTargetArgs {
  /** Substring to match against iframe targets' urls. */
  readonly urlSubstring: string;
}

export interface IframeTargetResult {
  readonly targetId: string | null;
  readonly sessionId?: string;
  readonly url?: string;
}

/**
 * Find the first iframe target whose URL contains `urlSubstring` and
 * (optionally) attach to it so callers can run `js({sessionId})` on
 * cross-origin iframe content.
 *
 * Mirrors browser-harness iframe_target (helpers.py:350-355), with one
 * Brisk addition: we attach + return the sessionId so the caller
 * doesn't have to do a separate Target.attachToTarget round trip.
 */
export async function iframeTarget(
  ctx: HelperContext,
  args: IframeTargetArgs,
): Promise<HelperResult<IframeTargetResult>> {
  if (!args.urlSubstring) {
    return err(briskError('HELPER_INVALID_ARGS', 'iframeTarget: urlSubstring is required'));
  }
  return runCdp(async () => {
    const r = await ctx.cdp.send<{
      targetInfos: readonly { targetId: string; type: string; url?: string }[];
    }>('Target.getTargets');
    const match = r.targetInfos.find(
      (t) => t.type === 'iframe' && (t.url ?? '').includes(args.urlSubstring),
    );
    if (!match) return { targetId: null } as const;
    const att = await ctx.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: match.targetId,
      flatten: true,
    });
    return { targetId: match.targetId, sessionId: att.sessionId, url: match.url ?? '' };
  });
}

// ─── Re-exports for convenience ──────────────────────────────────────

export { err, ok };
