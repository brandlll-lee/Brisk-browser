import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, LineDecoder, MAX_FRAME_BYTES } from './protocol.js';

describe('encodeFrame / decodeFrame', () => {
  it('round-trips a typical object', () => {
    const v = { meta: 'ping' };
    const enc = encodeFrame(v);
    expect(enc.at(-1)).toBe(0x0a);
    const line = enc.subarray(0, -1).toString('utf8');
    expect(decodeFrame(line)).toEqual(v);
  });

  it('preserves nested unicode', () => {
    const v = { title: '🐴 dashboard · 中文 · 한국어' };
    const enc = encodeFrame(v);
    const line = enc.subarray(0, -1).toString('utf8');
    expect(decodeFrame(line)).toEqual(v);
  });

  it('throws SyntaxError on bad JSON', () => {
    expect(() => decodeFrame('{ unterminated')).toThrow(SyntaxError);
  });
});

describe('LineDecoder', () => {
  it('yields one frame from one whole-line chunk', () => {
    const d = new LineDecoder();
    const frames = [...d.push(Buffer.from('{"a":1}\n'))];
    expect(frames).toEqual(['{"a":1}']);
    expect(d.pendingBytes).toBe(0);
  });

  it('yields multiple frames from a single chunk', () => {
    const d = new LineDecoder();
    const frames = [...d.push(Buffer.from('1\n2\n3\n'))];
    expect(frames).toEqual(['1', '2', '3']);
    expect(d.pendingBytes).toBe(0);
  });

  it('reassembles a frame split mid-payload', () => {
    const d = new LineDecoder();
    expect([...d.push(Buffer.from('{"hel'))]).toEqual([]);
    expect(d.pendingBytes).toBe(5);
    expect([...d.push(Buffer.from('lo":1}\n'))]).toEqual(['{"hello":1}']);
    expect(d.pendingBytes).toBe(0);
  });

  it('reassembles a UTF-8 codepoint split across chunks', () => {
    // 中 = 0xE4 0xB8 0xAD. Split between bytes 1 and 2.
    const enc = Buffer.from('{"x":"中"}\n', 'utf8');
    const splitAt = enc.indexOf(0xb8); // middle byte of '中'
    expect(splitAt).toBeGreaterThan(0);
    const d = new LineDecoder();
    expect([...d.push(enc.subarray(0, splitAt))]).toEqual([]);
    const frames = [...d.push(enc.subarray(splitAt))];
    expect(frames).toEqual(['{"x":"中"}']);
    expect(d.pendingBytes).toBe(0);
  });

  it('handles back-to-back partial chunks of multiple frames', () => {
    const d = new LineDecoder();
    expect([...d.push(Buffer.from('"a'))]).toEqual([]);
    expect([...d.push(Buffer.from('"\n"'))]).toEqual(['"a"']);
    expect([...d.push(Buffer.from('b"\n'))]).toEqual(['"b"']);
    expect(d.pendingBytes).toBe(0);
  });

  it('refuses a partial frame larger than maxFrameBytes', () => {
    const d = new LineDecoder({ maxFrameBytes: 16 });
    expect(() => [...d.push(Buffer.alloc(64, 0x41))]).toThrow(/exceeds maxFrameBytes/);
  });

  it('refuses a complete frame larger than maxFrameBytes', () => {
    const d = new LineDecoder({ maxFrameBytes: 16 });
    expect(() => [...d.push(Buffer.concat([Buffer.alloc(32, 0x41), Buffer.from('\n')]))]).toThrow(
      /exceeds maxFrameBytes/,
    );
  });

  it('resets state', () => {
    const d = new LineDecoder();
    void [...d.push(Buffer.from('partial'))];
    expect(d.pendingBytes).toBe(7);
    d.reset();
    expect(d.pendingBytes).toBe(0);
    expect([...d.push(Buffer.from('{}\n'))]).toEqual(['{}']);
  });

  it('exports a sane default frame size', () => {
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });
});
