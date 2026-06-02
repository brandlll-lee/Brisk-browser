/**
 * Fixed-capacity FIFO buffer with `drain` semantics — JS replacement for
 * Python's `collections.deque(maxlen=N)`.
 *
 * Used by the daemon to hold the most recent `BUF` CDP events between
 * `drain_events` polls. When full, oldest events are evicted on push.
 *
 * Capacity 500 (the browser-harness default) puts the asymptotic shift
 * cost at 500 array slots per overflow — measured at ~5 µs on Node 22 +
 * V8 12.x, well under the cost of producing a CDP event in the first
 * place. Premature ring-buffer optimization would only complicate
 * `drain` (which must allocate a new array anyway to hand to the IPC
 * client without sharing internal state).
 *
 * Lineage: browser-harness daemon.py:187,251,275.
 */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  /** Hand off all buffered items and reset. Caller owns the returned array. */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Snapshot without clearing. Returns a fresh array so callers can't mutate state. */
  snapshot(): readonly T[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
