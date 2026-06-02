/**
 * observation helpers — captureScreenshot / pageInfo / js / drainEvents.
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
import { captureScreenshot, drainEvents, js, pageInfo } from './observation.js';
import type { HelperContext } from './types.js';

class MockCdp implements CdpBackendApi {
  readonly sends: {
    method: string;
    params: Readonly<Record<string, unknown>>;
    sessionId?: string;
  }[] = [];
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
  fire(method: string, params: Readonly<Record<string, unknown>>, sessionId?: string): void {
    for (const l of this.anyListeners) l(method, params, sessionId);
  }
}

async function setupCtx(): Promise<{ ctx: HelperContext; cdp: MockCdp; daemon: Daemon }> {
  const cdp = new MockCdp();
  cdp.handler = (m, p) => {
    if (m === 'Target.getTargets')
      return { targetInfos: [{ targetId: 'T1', type: 'page', url: 'https://x' }] };
    if (m === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (m.endsWith('.enable')) return {};
    if (m === 'Page.captureScreenshot') {
      // 4-byte PNG header in base64 (not a real PNG, but enough to verify bytes)
      return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') };
    }
    if (m === 'Runtime.evaluate') {
      const expr = String(p.expression ?? '');
      if (expr.includes('throw new Error("boom")')) {
        return {
          result: { type: 'string', subtype: 'error', description: 'Error: boom' },
          exceptionDetails: { text: 'Uncaught', lineNumber: 0, columnNumber: 6 },
        };
      }
      if (expr.includes('JSON.stringify')) {
        return {
          result: {
            type: 'string',
            value: JSON.stringify({
              url: 'https://x',
              title: 'T',
              w: 1280,
              h: 800,
              sx: 0,
              sy: 0,
              pw: 1280,
              ph: 2400,
            }),
          },
        };
      }
      if (expr.startsWith('(function')) {
        return { result: { type: 'string', value: 'wrapped-ok' } };
      }
      return { result: { type: 'string', value: 'ok' } };
    }
    return {};
  };
  const daemon = new Daemon(cdp, { markTabs: false });
  await daemon.start();
  cdp.sends.length = 0;
  return { ctx: { cdp, daemon }, cdp, daemon };
}

describe('observation helpers', () => {
  describe('captureScreenshot', () => {
    it('returns decoded bytes', async () => {
      const { ctx, cdp } = await setupCtx();
      const r = await captureScreenshot(ctx);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.format).toBe('png');
        expect(Array.from(r.value.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
      expect(cdp.sends.map((s) => s.method)).toEqual([
        'Page.bringToFront',
        'Page.captureScreenshot',
      ]);
    });

    it('forwards captureBeyondViewport / optimizeForSpeed / quality', async () => {
      const { ctx, cdp } = await setupCtx();
      await captureScreenshot(ctx, {
        format: 'jpeg',
        quality: 80,
        fullPage: true,
        optimizeForSpeed: true,
      });
      const call = cdp.sends.find((s) => s.method === 'Page.captureScreenshot');
      expect(call?.params).toMatchObject({
        format: 'jpeg',
        quality: 80,
        captureBeyondViewport: true,
        optimizeForSpeed: true,
      });
    });

    it('rejects out-of-range quality', async () => {
      const { ctx } = await setupCtx();
      const r = await captureScreenshot(ctx, { quality: 200 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HELPER_INVALID_ARGS');
    });
  });

  describe('pageInfo', () => {
    it('returns viewport + scroll + page size', async () => {
      const { ctx } = await setupCtx();
      const r = await pageInfo(ctx);
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'page') {
        expect(r.value.info).toMatchObject({ url: 'https://x', w: 1280, h: 800, ph: 2400 });
      } else {
        throw new Error(`expected page result, got ${r.ok ? r.value.kind : 'err'}`);
      }
    });

    it('returns dialog when one is pending', async () => {
      const { ctx, cdp } = await setupCtx();
      cdp.fire(
        'Page.javascriptDialogOpening',
        { type: 'confirm', message: 'OK?', url: 'https://x', hasBrowserHandler: false },
        'S1',
      );
      const r = await pageInfo(ctx);
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'dialog') {
        expect(r.value.dialog).toMatchObject({ type: 'confirm', message: 'OK?' });
      } else {
        throw new Error('expected dialog result');
      }
    });
  });

  describe('js', () => {
    it('evaluates a plain expression', async () => {
      const { ctx } = await setupCtx();
      const r = await js(ctx, { expression: 'document.title' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.value).toBe('ok');
    });

    it('wraps top-level return in IIFE', async () => {
      const { ctx, cdp } = await setupCtx();
      await js(ctx, { expression: 'const x = 1; return x' });
      const call = cdp.sends.find((s) => s.method === 'Runtime.evaluate');
      expect(call?.params).toMatchObject({
        expression: '(function(){const x = 1; return x})()',
        returnByValue: true,
        awaitPromise: true,
      });
    });

    it('does NOT wrap `return` inside a string', async () => {
      const { ctx, cdp } = await setupCtx();
      await js(ctx, { expression: '"the return value"' });
      const call = cdp.sends.find((s) => s.method === 'Runtime.evaluate');
      expect(call?.params.expression).toBe('"the return value"');
    });

    it('surfaces exception details as CDP_PROTOCOL_ERROR', async () => {
      const { ctx } = await setupCtx();
      const r = await js(ctx, { expression: 'throw new Error("boom")' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('CDP_PROTOCOL_ERROR');
        expect(r.error.message).toMatch(/JavaScript evaluation failed/);
      }
    });

    it('rejects empty expression', async () => {
      const { ctx } = await setupCtx();
      const r = await js(ctx, { expression: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HELPER_INVALID_ARGS');
    });
  });

  describe('drainEvents', () => {
    it('returns and clears the daemon buffer', async () => {
      const { ctx, cdp } = await setupCtx();
      cdp.fire('Network.requestWillBeSent', { requestId: 'r1' }, 'S1');
      cdp.fire('Page.loadEventFired', {}, 'S1');
      const r1 = await drainEvents(ctx);
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value.events).toHaveLength(2);
      const r2 = await drainEvents(ctx);
      if (r2.ok) expect(r2.value.events).toHaveLength(0);
    });
  });
});
