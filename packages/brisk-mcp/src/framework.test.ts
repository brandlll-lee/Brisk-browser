/**
 * Unit tests for the BriskTool framework.
 *
 * Covers:
 *   • defineTool — identity / type pin
 *   • executeTool — happy path (ok → content + structuredContent)
 *   • executeTool — Result-shaped error (err → isError: true)
 *   • executeTool — thrown exception → isError: true
 *   • formatResult — bytes round-trip via Uint8Array
 *   • formatResult — null / undefined / scalar / array
 */

import { type BriskError, err, ok } from '@brisk/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type BriskTool, defineTool, executeTool, formatResult } from './framework.js';

function makeCtx() {
  const log = () => {};
  return {
    daemon: {} as never,
    cdp: {} as never,
    logger: { debug: log, info: log, warn: log, error: log },
  };
}

describe('defineTool', () => {
  it('is an identity function', () => {
    const tool = defineTool({
      name: 'wait',
      category: 'waits',
      title: 'T',
      description: 'D',
      inputSchema: { seconds: z.number() },
      handler: async () => ok({}),
    });
    expect(tool.name).toBe('wait');
    expect(tool.category).toBe('waits');
  });
});

describe('executeTool', () => {
  it('emits structuredContent for object results', async () => {
    const tool: BriskTool = {
      name: 'page_info',
      category: 'observation',
      title: 'T',
      description: 'D',
      inputSchema: {},
      async handler() {
        return ok({ url: 'https://example.com', title: 'Example' });
      },
    };
    const result = await executeTool(tool, {}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      url: 'https://example.com',
      title: 'Example',
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse(result.content[0].text)).toEqual({
      url: 'https://example.com',
      title: 'Example',
    });
  });

  it('omits structuredContent for arrays', async () => {
    const tool: BriskTool = {
      name: 'list_tabs',
      category: 'navigation',
      title: 'T',
      description: 'D',
      inputSchema: {},
      async handler() {
        return ok([{ id: 1 }, { id: 2 }]);
      },
    };
    const result = await executeTool(tool, {}, makeCtx());
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('omits structuredContent for primitives', async () => {
    const tool: BriskTool = {
      name: 'js',
      category: 'observation',
      title: 'T',
      description: 'D',
      inputSchema: {},
      async handler() {
        return ok(42);
      },
    };
    const result = await executeTool(tool, {}, makeCtx());
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toBe('42');
  });

  it('handles undefined return as no-output marker', async () => {
    const tool: BriskTool = {
      name: 'wait',
      category: 'waits',
      title: 'T',
      description: 'D',
      inputSchema: {},
      async handler() {
        return ok(undefined);
      },
    };
    const result = await executeTool(tool, {}, makeCtx());
    expect(result.content[0].text).toContain('no output');
  });

  it('formats Result-shaped errors with isError + code/message', async () => {
    const briskError: BriskError = {
      code: 'CDP_TIMEOUT',
      message: 'request timed out',
      details: { method: 'Page.navigate' },
    };
    const tool: BriskTool = {
      name: 'goto_url',
      category: 'navigation',
      title: 'T',
      description: 'D',
      inputSchema: { url: z.string() },
      async handler() {
        return err(briskError);
      },
    };
    const result = await executeTool(tool, { url: 'https://x' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('CDP_TIMEOUT: request timed out');
    expect(result.structuredContent).toEqual({
      code: 'CDP_TIMEOUT',
      message: 'request timed out',
      details: { method: 'Page.navigate' },
    });
  });

  it('coerces thrown exceptions into isError responses', async () => {
    const tool: BriskTool = {
      name: 'click_at_xy',
      category: 'input',
      title: 'T',
      description: 'D',
      inputSchema: { x: z.number(), y: z.number() },
      async handler() {
        throw new Error('boom');
      },
    };
    const result = await executeTool(tool, { x: 0, y: 0 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
    expect(result.structuredContent).toMatchObject({ message: expect.stringContaining('boom') });
  });

  it('encodes Uint8Array bytes via the replacer', async () => {
    const tool: BriskTool = {
      name: 'capture_screenshot',
      category: 'observation',
      title: 'T',
      description: 'D',
      inputSchema: {},
      async handler() {
        return ok({ format: 'png', bytes: new Uint8Array([0xff, 0xd8]) });
      },
    };
    const result = await executeTool(tool, {}, makeCtx());
    const decoded = JSON.parse(result.content[0].text);
    expect(decoded.bytes.__type__).toBe('bytes');
    expect(decoded.bytes.length).toBe(2);
    expect(decoded.bytes.base64).toBe('/9g=');
  });
});

describe('formatResult', () => {
  it('passes through scalars', () => {
    expect(formatResult(ok('hi')).content[0].text).toBe('"hi"');
    expect(formatResult(ok(true)).content[0].text).toBe('true');
    expect(formatResult(ok(null)).content[0].text).toBe('null');
  });

  it('round-trips bigint as string + n', () => {
    const r = formatResult(ok({ count: 123n }));
    expect(JSON.parse(r.content[0].text)).toEqual({ count: '123n' });
  });
});
