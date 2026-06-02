/**
 * Attach logic: pick a real page and open a CDP flat session on it.
 *
 * "Real page" = a Target whose `type` is "page" and whose URL is NOT
 * one of Chromium's internal schemes. This matches browser-harness's
 * INTERNAL filter (daemon.py:66) — without it we'd happily attach to
 * the omnibox popup, devtools window, or extension service worker
 * and then wonder why `Page.navigate` returns "Cannot navigate to
 * invalid URL".
 *
 * If no real page exists we create one on `about:blank` and attach
 * there. This is also the path used on a fresh Chrome where the user
 * closed every tab.
 *
 * Lineage: browser-harness daemon.py:178-206.
 */

import { briskError, err, ok, type Result } from '@brisk/types';

import type { CdpBackendApi } from '../cdp/types.js';

const INTERNAL_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'chrome-extension://',
  'about:',
] as const;

export interface AttachedTarget {
  readonly targetId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
}

interface RawTargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url?: string;
  readonly title?: string;
  readonly attached?: boolean;
}

export function isRealPage(t: RawTargetInfo): boolean {
  if (t.type !== 'page') return false;
  const url = t.url ?? '';
  return !INTERNAL_SCHEMES.some((p) => url.startsWith(p));
}

/**
 * Attach to a real page. Creates `about:blank` if none exists.
 *
 * @param cdp CDP backend (already connected).
 * @returns AttachedTarget on success, BriskError on failure.
 */
export async function attachFirstPage(cdp: CdpBackendApi): Promise<Result<AttachedTarget>> {
  let targets: readonly RawTargetInfo[];
  try {
    const resp = await cdp.send<{ targetInfos: readonly RawTargetInfo[] }>('Target.getTargets');
    targets = resp.targetInfos;
  } catch (cause) {
    return err(
      briskError(
        'CDP_PROTOCOL_ERROR',
        `Target.getTargets failed during attach: ${(cause as Error).message}`,
        { cause: cause as Error },
      ),
    );
  }

  const pages = targets.filter(isRealPage);
  let chosen: RawTargetInfo | undefined = pages[0];

  if (!chosen) {
    // No real pages — create one. Same fallback browser-harness uses
    // when every tab is chrome:// or the omnibox popup.
    try {
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      chosen = { targetId: created.targetId, type: 'page', url: 'about:blank', title: '' };
    } catch (cause) {
      return err(
        briskError(
          'BROWSER_NOT_FOUND',
          `No real pages and Target.createTarget failed: ${(cause as Error).message}`,
          { cause: cause as Error },
        ),
      );
    }
  }

  let sessionId: string;
  try {
    const att = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: chosen.targetId,
      flatten: true,
    });
    sessionId = att.sessionId;
  } catch (cause) {
    return err(
      briskError(
        'CDP_PROTOCOL_ERROR',
        `Target.attachToTarget failed for ${chosen.targetId}: ${(cause as Error).message}`,
        { cause: cause as Error },
      ),
    );
  }

  return ok({
    targetId: chosen.targetId,
    sessionId,
    url: chosen.url ?? '',
    title: chosen.title ?? '',
  });
}

/**
 * Enable the four CDP domains the helpers rely on (Page / DOM / Runtime / Network).
 *
 * Fresh CDP sessions start with all domains disabled, which silently
 * breaks `wait_for_network_idle` (no Network events fire) and screenshot
 * helpers (no Page domain). We re-enable on every fresh attach AND
 * every `set_session` call — see browser-harness daemon.py:208-230.
 *
 * Each enable is fired in parallel via Promise.all + per-domain timeout
 * so the wall-clock is bounded by the slowest single round-trip rather
 * than 4× serial. Important on remote daemons where the helper's IPC
 * read budget is 5s.
 */
export async function enableDefaultDomains(
  cdp: CdpBackendApi,
  sessionId: string,
  perDomainTimeoutMs = 4000,
  logger?: { warn(msg: string): void },
): Promise<void> {
  const domains = ['Page', 'DOM', 'Runtime', 'Network', 'Log'] as const;
  await Promise.all(
    domains.map(async (d) => {
      try {
        await Promise.race([
          cdp.sendOnSession(sessionId, `${d}.enable`),
          new Promise((_, reject) => {
            const t = setTimeout(
              () => reject(new Error(`${d}.enable timed out after ${perDomainTimeoutMs}ms`)),
              perDomainTimeoutMs,
            );
            t.unref?.();
          }),
        ]);
      } catch (cause) {
        logger?.warn(`enable ${d} on session ${sessionId} failed: ${(cause as Error).message}`);
      }
    }),
  );
}

/**
 * Disable Network on the previous session.
 *
 * Defense in depth — keeps background-tab traffic out of the global event
 * buffer. The consumer-side filter in `waitForNetworkIdle` is the actual
 * correctness gate, but disabling at the source halves the noise.
 *
 * Lineage: browser-harness daemon.py:309-326.
 */
export async function disableOldSessionNetwork(
  cdp: CdpBackendApi,
  oldSessionId: string,
  timeoutMs = 2000,
  logger?: { warn(msg: string): void },
): Promise<void> {
  try {
    await Promise.race([
      cdp.sendOnSession(oldSessionId, 'Network.disable'),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error(`Network.disable timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        t.unref?.();
      }),
    ]);
  } catch (cause) {
    logger?.warn(
      `Network.disable on old session ${oldSessionId} failed: ${(cause as Error).message}`,
    );
  }
}
