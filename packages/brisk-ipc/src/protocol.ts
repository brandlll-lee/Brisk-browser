/**
 * Brisk IPC wire protocol — JSON-line over a stream.
 *
 * Frame = one JSON object + `\n`. Newlines are forbidden inside the JSON
 * (JSON.stringify never emits them, so we just need to refuse user data that
 * sneaks one in via crafted unicode — guarded at the decoder level).
 *
 * Symmetric on both directions; the daemon and client share the same code path.
 *
 * Reference: browser-harness/src/browser_harness/_ipc.py:92-102 (`request`)
 * and BrowserOS message framing — both use the same JSON-line convention.
 */

export const FRAME_TERMINATOR = '\n' as const;
export const FRAME_TERMINATOR_BYTE = 0x0a;

/**
 * Maximum size of a single frame, in bytes. Frames larger than this are
 * a protocol error (DoS guard — without this a malicious local process
 * could OOM the daemon by streaming `{` forever without a newline).
 *
 * 16 MiB chosen as a generous ceiling: a full-page DOM dump or a
 * base64-encoded 4K screenshot fits comfortably under 8 MiB.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Encode an arbitrary JSON-serializable value as one frame.
 * Returns a Buffer ready to write to a socket.
 *
 * Throws if `value` contains cycles or non-serializable members
 * (JSON.stringify behavior — we surface the standard TypeError).
 */
export function encodeFrame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}${FRAME_TERMINATOR}`, 'utf8');
}

/**
 * Parse a frame string into a JSON value. Returns the parsed value
 * (caller is responsible for type validation — protocol.ts is transport-
 * level only).
 *
 * @throws SyntaxError when the line isn't valid JSON.
 */
export function decodeFrame(line: string): unknown {
  return JSON.parse(line);
}

export interface DecoderOptions {
  readonly maxFrameBytes?: number;
}

/**
 * Buffered, push-based line decoder. Pump chunks in, iterate frames out.
 *
 * Holds at most one partial frame's worth of bytes in memory. After every
 * `push` call you can read `pendingBytes` to check buffer pressure.
 *
 * Design rationale: we use Buffer directly (not string concatenation) to
 * avoid UTF-8 split surrogate pairs across chunk boundaries — Node's
 * `Buffer.indexOf` on the LF byte is correct because LF (0x0A) cannot
 * appear inside a multi-byte UTF-8 sequence.
 */
export class LineDecoder {
  private readonly maxFrame: number;
  private buf: Buffer = Buffer.alloc(0);

  constructor(opts: DecoderOptions = {}) {
    this.maxFrame = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  /**
   * Append a chunk to the buffer and yield zero-or-more complete frames.
   *
   * Iteration is synchronous and exhausts every complete frame in `chunk`
   * before returning. Any residual bytes are retained internally.
   */
  *push(chunk: Buffer): Generator<string, void, void> {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let nlIdx = this.buf.indexOf(FRAME_TERMINATOR_BYTE);
    while (nlIdx >= 0) {
      if (nlIdx > this.maxFrame) {
        throw new Error(
          `IPC frame exceeds maxFrameBytes (${this.maxFrame}); got ${nlIdx} bytes before terminator`,
        );
      }
      const line = this.buf.subarray(0, nlIdx).toString('utf8');
      this.buf = this.buf.subarray(nlIdx + 1);
      yield line;
      nlIdx = this.buf.indexOf(FRAME_TERMINATOR_BYTE);
    }
    if (this.buf.length > this.maxFrame) {
      throw new Error(
        `IPC partial frame exceeds maxFrameBytes (${this.maxFrame}); buffered ${this.buf.length} bytes without terminator`,
      );
    }
  }

  /** Drop all buffered state (e.g. after a socket close). */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  /** Bytes still buffered (incomplete partial frame). */
  get pendingBytes(): number {
    return this.buf.length;
  }
}
