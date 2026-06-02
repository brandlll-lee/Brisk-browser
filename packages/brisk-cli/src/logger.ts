/**
 * Simple stderr logger used by all CLI commands.
 *
 * Critical for stdio MCP mode: stdout is reserved for JSON-RPC frames,
 * and any rogue console.log would corrupt the wire. So the logger
 * always writes to stderr, prefixed with the level.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CliLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(
  level: LogLevel = 'info',
  stream: NodeJS.WritableStream = process.stderr,
): CliLogger {
  const threshold = LEVEL_ORDER[level];
  function emit(at: LogLevel, msg: string): void {
    if (LEVEL_ORDER[at] < threshold) return;
    const tag = at.padEnd(5);
    stream.write(`[${tag}] ${msg}\n`);
  }
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

/**
 * Pure stdout logger. Use only for tool output that the user wants
 * to see in a terminal (e.g. `brisk doctor`, `brisk daemon status`).
 *
 * NEVER use this in `brisk serve --transport stdio` — would corrupt
 * the MCP wire.
 */
export function println(line: string): void {
  process.stdout.write(`${line}\n`);
}
