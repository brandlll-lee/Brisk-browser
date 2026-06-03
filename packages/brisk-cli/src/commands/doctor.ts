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

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { platform } from 'node:process';
import { promisify } from 'node:util';

import { discoverCdpEndpoint } from '@brisk/core';
import { identifyIpcDaemon, ipcPath, pingIpc } from '@brisk/ipc';

import { discoveryOptionsFromResolvedCdp, resolveCdpConfig } from '../cdp-env.js';
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
const INSPECT_URL = 'chrome://inspect/#remote-debugging';
const execFileAsync = promisify(execFile);

export async function runDoctor(options: DoctorOptions): Promise<void> {
  let healthy = true;
  const cdpConfig = resolveCdpConfig(options);
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
      ...discoveryOptionsFromResolvedCdp(cdpConfig),
    });
    println(
      `  cdp        ✓ ${endpoint.webSocketDebuggerUrl} (${describeCdpSource(cdpConfig.source)})`,
    );
  } catch (cause) {
    println(`  cdp        ✗ ${(cause as Error).message}`);
    await printCdpRecovery(options, cdpConfig.source);
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

function describeCdpSource(source: ReturnType<typeof resolveCdpConfig>['source']): string {
  switch (source) {
    case 'cli-ws':
      return '--cdp-ws';
    case 'cli-url':
      return '--cdp-url';
    case 'cli-port':
      return '--cdp-port';
    case 'env-ws':
      return 'BRISK_CDP_WS';
    case 'env-url':
      return 'BRISK_CDP_URL';
    case 'auto':
      return 'auto';
  }
}

async function printCdpRecovery(
  options: DoctorOptions,
  source: ReturnType<typeof resolveCdpConfig>['source'],
): Promise<void> {
  const chromeRunning = await isChromeRunning();
  const explicit = source !== 'auto';
  if (chromeRunning && !explicit) {
    println(`             → Way 1: open ${INSPECT_URL}`);
    println('             → tick "Allow remote debugging for this browser instance"');
    println('             → click Allow if Chrome shows a remote-debugging popup');
    if (await openChromeInspect()) {
      println('             → opened the remote-debugging page for you');
    }
    return;
  }
  if (!explicit) {
    println(`             → Way 1: start your normal Chrome, then open ${INSPECT_URL}`);
    println('             → or run `brisk chrome --port 9222` for Way 2');
    return;
  }
  if (options.cdpPort !== undefined) {
    println(
      `             → confirm Chrome is listening on --remote-debugging-port=${options.cdpPort}`,
    );
  } else {
    println('             → confirm the configured CDP endpoint is reachable');
  }
  println('             → Way 2 fallback: `brisk chrome --port 9222`');
}

async function isChromeRunning(): Promise<boolean> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', [], { timeout: 5000 });
      return /chrome\.exe|msedge\.exe|brave\.exe|chromium\.exe/i.test(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='], { timeout: 5000 });
    return /Google Chrome|chrome|chromium|Microsoft Edge|msedge|brave/i.test(stdout);
  } catch {
    return false;
  }
}

async function openChromeInspect(): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      await execFileAsync(
        'osascript',
        [
          '-e',
          'tell application "Google Chrome" to activate',
          '-e',
          `tell application "Google Chrome" to open location "${INSPECT_URL}"`,
        ],
        { timeout: 5000 },
      );
      return true;
    }
    if (platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'start', '', INSPECT_URL], { timeout: 5000 });
      return true;
    }
    const opener = process.env.BROWSER ? process.env.BROWSER : 'xdg-open';
    await execFileAsync(opener, [INSPECT_URL], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
