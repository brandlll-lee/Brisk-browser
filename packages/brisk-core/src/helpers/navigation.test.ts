/**
 * navigation helpers — unit tests over mock CdpBackend + real Daemon.
 *
 * The Daemon is the real one: helpers exercise it end-to-end so the
 * stale-session recovery + Target.* guards stay covered by helper tests.
 */

import { describe, expect, it } from 'vitest';

import type {
  CdpAnyEventListener,
  CdpBackendApi,
  CdpEventListener,
  CdpSessionEventListener,
  Disposable,
} from '../cdp/types.js';
import { Daemon } from '../daemon/daemon.js';
import { currentTab, goto, listTabs } from './navigation.js';
import type { HelperContext } from './types.js';

class MockCdp implements CdpBackendApi {
  readonly sends: { method: string; params: unknown; sessionId?: string }[] = [];
  handler: (m: string, p: Readonly<Record<string, unknown>>) => unknown = () => ({});
  private connected = true;
  private anyListeners: CdpAnyEventListener[] = [];

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  isConnected(): boolean {
    return this.connected;
  }
  send<T = unknown>(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
    this.sends.push({ method, params });
    return Promise.resolve(this.handler(method, params) as T);
  }
  sendOnSession<T = unknown>(
    sessionId: string,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    this.sends.push({ method, params, sessionId });
    return Promise.resolve(this.handler(method, params) as T);
  }
  on(_m: string, _l: CdpEventListener): Disposable {
    return () => {};
  }
  onSession(_m: string, _l: CdpSessionEventListener): Disposable {
    return () => {};
  }
  onAny(l: CdpAnyEventListener): Disposable {
    this.anyListeners.push(l);
    return () => {
      const i = this.anyListeners.indexOf(l);
      if (i >= 0) this.anyListeners.splice(i, 1);
    };
  }
}

async function setupCtx(): Promise<{ ctx: HelperContext; cdp: MockCdp; daemon: Daemon }> {
  const cdp = new MockCdp();
  cdp.handler = (m) => {
    if (m === 'Target.getTargets')
      return {
        targetInfos: [
          { targetId: 'TC1', type: 'page', url: 'chrome://newtab' },
          { targetId: 'T1', type: 'page', url: 'https://example.com', title: 'Example' },
          { targetId: 'T2', type: 'page', url: 'https://other.com', title: 'Other' },
        ],
      };
    if (m === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (m.endsWith('.enable')) return {};
    if (m === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'T1', url: 'https://example.com', title: 'Example' } };
    if (m === 'Page.navigate') return { frameId: 'F1', loaderId: 'L1' };
    return {};
  };
  const daemon = new Daemon(cdp, { markTabs: false });
  await daemon.start();
  cdp.sends.length = 0;
  return { ctx: { cdp, daemon }, cdp, daemon };
}

describe('navigation helpers', () => {
  describe('goto', () => {
    it('sends Page.navigate with the url', async () => {
      const { ctx, cdp } = await setupCtx();
      const r = await goto(ctx, { url: 'https://target.example' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.frameId).toBe('F1');
      const call = cdp.sends.find((s) => s.method === 'Page.navigate');
      expect(call?.params).toMatchObject({ url: 'https://target.example' });
      expect(call?.sessionId).toBe('S1');
    });

    it('rejects empty url with HELPER_INVALID_ARGS', async () => {
      const { ctx } = await setupCtx();
      const r = await goto(ctx, { url: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HELPER_INVALID_ARGS');
    });

    it('forwards optional referrer + transitionType', async () => {
      const { ctx, cdp } = await setupCtx();
      await goto(ctx, {
        url: 'https://x',
        referrer: 'https://r',
        transitionType: 'reload',
      });
      const call = cdp.sends.find((s) => s.method === 'Page.navigate');
      expect(call?.params).toMatchObject({
        url: 'https://x',
        referrer: 'https://r',
        transitionType: 'reload',
      });
    });
  });

  describe('currentTab', () => {
    it('returns targetId + url + title from Target.getTargetInfo', async () => {
      const { ctx } = await setupCtx();
      const r = await currentTab(ctx);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value).toMatchObject({
          targetId: 'T1',
          url: 'https://example.com',
          title: 'Example',
        });
    });
  });

  describe('listTabs', () => {
    it('excludes chrome:// by default', async () => {
      const { ctx } = await setupCtx();
      const r = await listTabs(ctx);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const urls = r.value.map((t) => t.url);
        expect(urls).toEqual(['https://example.com', 'https://other.com']);
      }
    });

    it('includes chrome:// when includeChrome=true', async () => {
      const { ctx } = await setupCtx();
      const r = await listTabs(ctx, { includeChrome: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const urls = r.value.map((t) => t.url);
        expect(urls).toEqual(['chrome://newtab', 'https://example.com', 'https://other.com']);
      }
    });
  });
});
