/**
 * `brisk doctor` — quick environment health check.
 *
 * Checks (in order):
 *   1. Node.js version satisfies engines requirement
 *   2. Platform sanity (Windows named pipe / macOS osascript / Linux Wayland-X11)
 *   3. Chrome-family browser discoverable on disk
 *   4. CDP endpoint discoverable
 *   5. IPC port reachable / clean
 *   6. Optional: report skills workspace state
 *
 * Exits 0 if everything looks OK, 1 if any check fails. Always prints
 * a human-readable report.
 */

import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { platform } from 'node:process';

import { discoverCdpEndpoint } from '@brisk/core';
import { identifyIpcDaemon, ipcPath, pingIpc } from '@brisk/ipc';

import {
  detectLinuxConfinement,
  detectLinuxDisplayServer,
  findAllChromes,
  findChrome,
} from '../chrome-finder.js';
import { println } from '../logger.js';

export interface DoctorOptions {
  readonly cdpPort?: number;
  readonly cdpUrl?: string;
  readonly cdpWs?: string;
  readonly instance?: string;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(options: DoctorOptions): Promise<void> {
  let healthy = true;
  println('Brisk environment check');
  println('========================');

  // ─── Node version ─────────────────────────────────────
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    println(`  node       ✗ ${nodeVersion} (need ${MIN_NODE_MAJOR}+ )`);
    healthy = false;
  } else {
    println(`  node       ✓ ${nodeVersion}`);
  }

  // ─── Platform sanity ──────────────────────────────────
  println(`  platform   ✓ ${platform} (${process.arch})`);
  if (platform === 'win32') {
    const pipeRoot = '\\\\.\\pipe\\';
    // We can't access(pipeRoot) — it's not a real fs path. Just print it
    // for the user's reference.
    println(`             named-pipe namespace: ${pipeRoot}brisk-<instance>`);
    const stdoutTty = process.stdout.isTTY === true;
    println(
      `             stdout TTY: ${stdoutTty ? 'yes' : 'no'} (encoding=${process.stdout.write === undefined ? '?' : 'utf8'})`,
    );
  } else if (platform === 'darwin') {
    // osascript is the user-facing automation hook on macOS.
    const osascriptExists = existsSync('/usr/bin/osascript');
    if (osascriptExists) {
      println('             osascript ✓ available (/usr/bin/osascript)');
    } else {
      println('             osascript ✗ missing — Chrome auto-focus disabled');
    }
  } else if (platform === 'linux') {
    const display = detectLinuxDisplayServer();
    if (display === 'wayland') {
      println('             display ✓ Wayland');
      println('             note: some Chrome builds prefer --headless on Wayland.');
    } else if (display === 'x11') {
      println('             display ✓ X11');
    } else {
      println('             display - no DISPLAY / WAYLAND_DISPLAY set (headless OK)');
    }
  }

  // ─── Chrome binary discovery ──────────────────────────
  try {
    const found = await findChrome();
    if (found) {
      println(`  chrome     ✓ ${found.brand} at ${found.path} (${found.source})`);
      if (platform === 'linux') {
        const confined = detectLinuxConfinement(found.path);
        if (confined === 'snap') {
          println(
            '             warning: Snap-confined; --user-data-dir paths limited to $HOME/snap/.',
          );
        }
      }
      const others = await findAllChromes();
      if (others.length > 1) {
        println(`             (also found: ${others.length - 1} more — use --brand to choose)`);
      }
    } else {
      println('  chrome     ✗ no Chrome-family browser found on disk');
      println('             install Chrome or set BRISK_CHROME_PATH');
      // Don't mark unhealthy — user may attach to a remote CDP / cloud browser.
    }
  } catch (cause) {
    println(`  chrome     ? ${(cause as Error).message}`);
  }

  // ─── CDP discovery ────────────────────────────────────
  try {
    const endpoint = await discoverCdpEndpoint({
      ...(options.cdpWs ? { wsUrl: options.cdpWs } : {}),
      ...(options.cdpUrl ? { httpUrl: options.cdpUrl } : {}),
      ...(options.cdpPort ? { port: options.cdpPort, profileDirs: [] } : {}),
    });
    println(`  cdp        ✓ ${endpoint.webSocketDebuggerUrl}`);
  } catch (cause) {
    println(`  cdp        ✗ ${(cause as Error).message}`);
    println('             → start Chrome with --remote-debugging-port=9222');
    println('             → or run `brisk chrome --port 9222`');
    healthy = false;
  }

  // ─── IPC ──────────────────────────────────────────────
  const instance = options.instance ?? 'default';
  const endpoint = ipcPath(instance);
  const running = await pingIpc(instance, 500);
  if (running) {
    const pid = await identifyIpcDaemon(instance, 500);
    println(`  daemon     ✓ pid=${pid ?? 'unknown'}  endpoint=${endpoint}`);
  } else {
    println(`  daemon     - not running (endpoint=${endpoint})`);
    if (platform !== 'win32') {
      // POSIX stale-socket sanity check.
      const socketPath = endpoint;
      try {
        await access(socketPath, constants.F_OK);
        println(`             warning: socket file exists but no daemon is listening`);
        println(`             → rm ${socketPath} if you're sure no daemon is running`);
      } catch {
        // expected
      }
    }
  }

  println('========================');
  println(healthy ? 'All required checks passed.' : 'One or more checks failed.');
  if (!healthy) process.exitCode = 1;
}
