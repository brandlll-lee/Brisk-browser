/**
 * Cross-platform IPC path resolution.
 *
 * Node.js `net.createServer().listen(path)` accepts either:
 *   - Unix domain socket path (POSIX systems)
 *   - Named pipe path in `\\?\pipe\` or `\\.\pipe\` namespace (Windows)
 *
 * Reference: https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support
 */

import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Return the platform-appropriate IPC endpoint path for the given name.
 *
 * @param name slug — must match `[a-z0-9][a-z0-9_-]{0,63}` (max 64 chars,
 *             ASCII letters / digits / hyphen / underscore, first char
 *             alphanumeric). Enforced because `sockaddr_un.sun_path` is
 *             limited to 104 bytes on macOS and 108 on Linux; pinning
 *             the slug short keeps us comfortably under both even on
 *             non-default tmpdir setups.
 */
export function ipcPath(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`IPC name must match ${NAME_PATTERN}; got ${JSON.stringify(name)}`);
  }
  if (platform() === 'win32') {
    // Windows named pipe namespace. Both \\.\pipe\ and \\?\pipe\ are
    // accepted; we use the dot form because it's the legacy default
    // and tooling like `pipelist` shows it without escaping.
    return `\\\\.\\pipe\\brisk-${name}`;
  }
  // POSIX: use OS tmpdir (typically /tmp). Do NOT use process.cwd() —
  // sockets created there move with the daemon's cwd and break
  // discovery from a sibling process.
  return join(tmpdir(), `brisk-${name}.sock`);
}

export function isWindowsPipe(p: string): boolean {
  return p.startsWith('\\\\.\\pipe\\') || p.startsWith('\\\\?\\pipe\\');
}
