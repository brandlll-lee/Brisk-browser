/**
 * Daemon unit tests — mock CdpBackend, exercise attach + tap + handle.
 */

import { briskError } from '@brisk/types';
import { describe, expect, it } from 'vitest';

import type {
  CdpAnyEventListener,
  CdpBackendApi,
  CdpEventListener,
  CdpSessionEventListener,
  Disposable,
} from '../cdp/types.js';
import { Daemon } from './daemon.js';

// ─── Mock CdpBackend ─────────────────────────────────────────────────

interface SendCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

type Handler = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
) => unknown | Promise<unknown>;

class MockCdp implements CdpBackendApi {
  readonly sends: SendCall[] = [];
  handler: Handler = () => ({});
  private anyListeners: CdpAnyEventListener[] = [];
  private connected = true;

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

  send<T = Readonly<Record<string, unknown>>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    this.sends.push({ method, params });
    return Promise.resolve(this.handler(method, params, undefined) as T);
  }

  sendOnSession<T = Readonly<Record<string, unknown>>>(
    sessionId: string,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    if (method.startsWith('Target.')) {
      return Promise.reject(
        briskError('CDP_PROTOCOL_ERROR', `Target.* on session: ${method}/${sessionId}`),
      );
    }
    this.sends.push({ method, params, sessionId });
    return Promise.resolve(this.handler(method, params, sessionId) as T);
  }

  on(_method: string, _listener: CdpEventListener): Disposable {
    return () => {};
  }

  onSession(_method: string, _listener: CdpSessionEventListener): Disposable {
    return () => {};
  }

  onAny(listener: CdpAnyEventListener): Disposable {
    this.anyListeners.push(listener);
    return () => {
      const i = this.anyListeners.indexOf(listener);
      if (i >= 0) this.anyListeners.splice(i, 1);
    };
  }

  fire(method: string, params: Readonly<Record<string, unknown>>, sessionId?: string): void {
    for (const l of this.anyListeners) l(method, params, sessionId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function defaultHandler(targets: { targetId: string; type: string; url: string }[]): Handler {
  return (method, _params, _sid) => {
    if (method === 'Target.getTargets') return { targetInfos: targets };
    if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (method === 'Target.createTarget') return { targetId: 'T-new' };
    if (method.endsWith('.enable')) return {};
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'ok' } };
    if (method === 'Browser.getVersion')
      return { product: 'Chrome/200.0', userAgent: 'Mozilla/5.0' };
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: 'T1', url: 'https://x', title: 'X' } };
    if (method === 'Page.navigate') return { frameId: 'F1', loaderId: 'L1' };
    return {};
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Daemon', () => {
  describe('start + attach', () => {
    it('attaches to the first real page', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([
        { targetId: 'TC1', type: 'page', url: 'chrome://newtab' },
        { targetId: 'T1', type: 'page', url: 'https://example.com' },
      ]);
      const d = new Daemon(cdp);
      await d.start();
      const { sessionId, targetId } = d.getSession();
      expect(sessionId).toBe('S1');
      expect(targetId).toBe('T1');
      const attachCall = cdp.sends.find((s) => s.method === 'Target.attachToTarget');
      expect(attachCall?.params).toMatchObject({ targetId: 'T1', flatten: true });
    });

    it('attaches an existing user tab without creating a new tab', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([
        { targetId: 'T-user', type: 'page', url: 'https://amazon.com/dp/B08Z6X4NK3' },
      ]);
      const d = new Daemon(cdp);

      await d.start();

      expect(d.getSession()).toMatchObject({ sessionId: 'S1', targetId: 'T-user' });
      expect(cdp.sends.some((s) => s.method === 'Target.createTarget')).toBe(false);
      expect(cdp.sends.find((s) => s.method === 'Target.attachToTarget')?.params).toMatchObject({
        targetId: 'T-user',
        flatten: true,
      });
    });

    it('creates an about:blank page when no real pages exist', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'TC1', type: 'page', url: 'chrome://newtab' }]);
      const d = new Daemon(cdp);
      await d.start();
      const created = cdp.sends.find((s) => s.method === 'Target.createTarget');
      expect(created?.params).toMatchObject({ url: 'about:blank' });
      expect(d.getSession().targetId).toBe('T-new');
    });

    it('enables Page/DOM/Runtime/Network on attach', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const d = new Daemon(cdp);
      await d.start();
      const enables = cdp.sends.filter((s) => s.method.endsWith('.enable')).map((s) => s.method);
      expect(enables).toEqual(
        expect.arrayContaining(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable']),
      );
    });

    it('refuses to start after shutdown', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const d = new Daemon(cdp);
      d.shutdown();
      await expect(d.start()).rejects.toMatchObject({ code: 'CDP_NOT_CONNECTED' });
    });
  });

  describe('handle: meta', () => {
    async function setupAttached(): Promise<{ daemon: Daemon; cdp: MockCdp }> {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const daemon = new Daemon(cdp, { markTabs: false });
      await daemon.start();
      cdp.sends.length = 0;
      return { daemon, cdp };
    }

    it('ping returns pid + version + startedAt', async () => {
      const { daemon } = await setupAttached();
      const r = await daemon.handle({ id: 1, meta: 'ping' });
      expect(r).toMatchObject({ id: 1, pong: true, pid: process.pid, version: '0.1.0' });
    });

    it('session returns the active sessionId + targetId', async () => {
      const { daemon } = await setupAttached();
      const r = await daemon.handle({ meta: 'session' });
      expect(r).toMatchObject({ sessionId: 'S1', targetId: 'T1' });
    });

    it('current_tab fetches Target.getTargetInfo', async () => {
      const { daemon, cdp } = await setupAttached();
      const r = await daemon.handle({ id: 7, meta: 'current_tab' });
      expect(r).toMatchObject({
        id: 7,
        targetId: 'T1',
        sessionId: 'S1',
        page: { title: 'X', url: 'https://x' },
      });
      const call = cdp.sends.find((s) => s.method === 'Target.getTargetInfo');
      expect(call?.params).toMatchObject({ targetId: 'T1' });
    });

    it('connection_status returns Browser.getVersion info when attached', async () => {
      const { daemon } = await setupAttached();
      const r = await daemon.handle({ meta: 'connection_status' });
      expect(r).toMatchObject({
        status: 'connected',
        version: 'Chrome/200.0',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('drain_events returns and clears buffered events', async () => {
      const { daemon, cdp } = await setupAttached();
      cdp.fire('Page.loadEventFired', { timestamp: 1 }, 'S1');
      cdp.fire('Network.requestWillBeSent', { requestId: 'r1' }, 'S1');
      const r = (await daemon.handle({ meta: 'drain_events' })) as { events: unknown[] };
      expect(r.events).toHaveLength(2);
      const r2 = (await daemon.handle({ meta: 'drain_events' })) as { events: unknown[] };
      expect(r2.events).toHaveLength(0);
    });

    it('set_session swaps the active session', async () => {
      const { daemon, cdp } = await setupAttached();
      const r = await daemon.handle({
        meta: 'set_session',
        sessionId: 'S2',
        targetId: 'T2',
      });
      expect(r).toMatchObject({ sessionId: 'S2', targetId: 'T2' });
      // New session should have domains enabled
      const enabled = cdp.sends
        .filter((s) => s.sessionId === 'S2' && s.method.endsWith('.enable'))
        .map((s) => s.method);
      expect(enabled).toEqual(
        expect.arrayContaining(['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable']),
      );
      // Old session should have Network.disable called
      const disable = cdp.sends.find((s) => s.sessionId === 'S1' && s.method === 'Network.disable');
      expect(disable).toBeTruthy();
    });

    it('pending_dialog tracks Page.javascriptDialog* events', async () => {
      const { daemon, cdp } = await setupAttached();
      cdp.fire(
        'Page.javascriptDialogOpening',
        { type: 'alert', message: 'hi', url: 'https://x', hasBrowserHandler: false },
        'S1',
      );
      const r1 = (await daemon.handle({ meta: 'pending_dialog' })) as {
        dialog: { type: string } | null;
      };
      expect(r1.dialog?.type).toBe('alert');
      cdp.fire('Page.javascriptDialogClosed', {}, 'S1');
      const r2 = (await daemon.handle({ meta: 'pending_dialog' })) as { dialog: unknown };
      expect(r2.dialog).toBeNull();
    });

    it('shutdown stops the event tap', async () => {
      const { daemon, cdp } = await setupAttached();
      await daemon.handle({ meta: 'shutdown' });
      cdp.fire('Page.loadEventFired', {}, 'S1');
      const r = (await daemon.handle({ meta: 'drain_events' })) as { events: unknown[] };
      expect(r.events).toHaveLength(0);
    });
  });

  describe('handle: CDP passthrough', () => {
    async function setupAttached(): Promise<{ daemon: Daemon; cdp: MockCdp }> {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const daemon = new Daemon(cdp, { markTabs: false });
      await daemon.start();
      cdp.sends.length = 0;
      return { daemon, cdp };
    }

    it('routes default-session method to sendOnSession with the session id', async () => {
      const { daemon, cdp } = await setupAttached();
      const r = await daemon.handle({ method: 'Page.navigate', params: { url: 'https://y' } });
      expect(r).toMatchObject({ result: { frameId: 'F1', loaderId: 'L1' } });
      const call = cdp.sends.find((s) => s.method === 'Page.navigate');
      expect(call?.sessionId).toBe('S1');
    });

    it('routes Target.* without sessionId (browser-level)', async () => {
      const { daemon, cdp } = await setupAttached();
      await daemon.handle({ method: 'Target.getTargets' });
      const call = cdp.sends.find((s) => s.method === 'Target.getTargets');
      expect(call?.sessionId).toBeUndefined();
    });

    it('honors an explicit sessionId override (iframe targeting)', async () => {
      const { daemon, cdp } = await setupAttached();
      await daemon.handle({
        method: 'Runtime.evaluate',
        params: { expression: '1' },
        sessionId: 'IFRAME-S',
      });
      const call = cdp.sends.find((s) => s.method === 'Runtime.evaluate');
      expect(call?.sessionId).toBe('IFRAME-S');
    });

    it('auto-reattaches on stale session and replays the request', async () => {
      const { daemon, cdp } = await setupAttached();
      let firstAttempt = true;
      cdp.handler = (method, _params, sid) => {
        if (method === 'Target.getTargets') {
          return { targetInfos: [{ targetId: 'T2', type: 'page', url: 'https://x' }] };
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'S-REATTACH' };
        if (method.endsWith('.enable')) return {};
        if (method === 'Runtime.evaluate') {
          if (firstAttempt && sid === 'S1') {
            firstAttempt = false;
            throw briskError('CDP_SESSION_NOT_FOUND', 'Session with given id not found');
          }
          return { result: { type: 'string', value: 'recovered' } };
        }
        return {};
      };
      const r = await daemon.handle({
        method: 'Runtime.evaluate',
        params: { expression: '1' },
      });
      expect(r).toMatchObject({ result: { result: { type: 'string', value: 'recovered' } } });
      expect(daemon.getSession().sessionId).toBe('S-REATTACH');
    });

    it('returns ErrorResponse on protocol error (no recovery for non-default session)', async () => {
      const { daemon, cdp } = await setupAttached();
      cdp.handler = (method) => {
        if (method === 'Runtime.evaluate')
          throw briskError('CDP_PROTOCOL_ERROR', 'Some other error');
        return {};
      };
      const r = await daemon.handle({
        method: 'Runtime.evaluate',
        params: { expression: '1' },
      });
      expect(r).toMatchObject({ error: { code: 'CDP_PROTOCOL_ERROR' } });
    });

    it('callCdp throws BriskError on protocol failure', async () => {
      const { daemon, cdp } = await setupAttached();
      cdp.handler = (method) => {
        if (method === 'DOM.getDocument') throw briskError('CDP_PROTOCOL_ERROR', 'DOM failed');
        return {};
      };
      await expect(daemon.callCdp('DOM.getDocument')).rejects.toMatchObject({
        code: 'CDP_PROTOCOL_ERROR',
      });
    });
  });

  describe('event tap', () => {
    it('caps the event buffer at the configured size', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const d = new Daemon(cdp, { markTabs: false, eventBufferSize: 3 });
      await d.start();
      for (let i = 0; i < 10; i++) {
        cdp.fire('Network.requestWillBeSent', { requestId: `r${i}` }, 'S1');
      }
      const evs = d.snapshotEvents();
      expect(evs).toHaveLength(3);
      const ids = evs.map((e) => (e.params as { requestId: string }).requestId);
      expect(ids).toEqual(['r7', 'r8', 'r9']);
    });

    it('records sessionId on each event', async () => {
      const cdp = new MockCdp();
      cdp.handler = defaultHandler([{ targetId: 'T1', type: 'page', url: 'https://x' }]);
      const d = new Daemon(cdp, { markTabs: false });
      await d.start();
      cdp.fire('Page.loadEventFired', { ts: 1 }, 'SOME-SESSION');
      const evs = d.snapshotEvents();
      const tap = evs.find((e) => e.method === 'Page.loadEventFired');
      expect(tap?.sessionId).toBe('SOME-SESSION');
    });
  });
});
