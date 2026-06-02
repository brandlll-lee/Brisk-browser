import { describe, expect, it } from 'vitest';

import { RingBuffer } from './buffer.js';

describe('RingBuffer', () => {
  it('accepts items up to capacity without eviction', () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    b.push(3);
    expect(b.length).toBe(3);
    expect(b.snapshot()).toEqual([1, 2, 3]);
  });

  it('evicts the oldest item when capacity is exceeded', () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    b.push(3);
    b.push(4);
    b.push(5);
    expect(b.length).toBe(3);
    expect(b.snapshot()).toEqual([3, 4, 5]);
  });

  it('drain returns all items and resets length to 0', () => {
    const b = new RingBuffer<string>(5);
    b.push('a');
    b.push('b');
    const drained = b.drain();
    expect(drained).toEqual(['a', 'b']);
    expect(b.length).toBe(0);
    expect(b.snapshot()).toEqual([]);
  });

  it('snapshot returns a copy that does not aliased internal state', () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    const snap = b.snapshot();
    // mutating snapshot must not affect internal state
    (snap as number[]).push(99);
    expect(b.snapshot()).toEqual([1, 2]);
  });

  it('clear empties the buffer', () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    b.clear();
    expect(b.length).toBe(0);
    expect(b.drain()).toEqual([]);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(1.5)).toThrow(RangeError);
  });

  it('survives capacity 1 (degenerate but valid)', () => {
    const b = new RingBuffer<number>(1);
    b.push(1);
    b.push(2);
    b.push(3);
    expect(b.snapshot()).toEqual([3]);
  });
});
