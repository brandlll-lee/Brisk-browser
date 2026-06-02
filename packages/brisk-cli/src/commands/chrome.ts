/**
 * `brisk chrome` — launch Chrome / Chromium / Edge / Brave with
 * `--remote-debugging-port` and an isolated user-data-dir.
 *
 * Modeled on browser-harness's "Way 2" path (install.md):
 *   - User-data-dir MUST be non-default (Chrome 136+ silently no-ops
 *     the port flag if you point at the platform default profile).
 *   - The port is the DevTools listener; we wait for `DevToolsActivePort`
 *     to appear in the user-data-dir, then print the actual port.
 *
 * Two modes:
 *   --wait   (default)  Block until Chrome exits / SIGINT.
 *   --detach            Spawn and exit immediately; user closes Chrome later.
 *
 * Returns exit-code 0 on success, 1 on launch failure.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import {
  type BrowserBrand,
  detectLinuxConfinement,
  detectLinuxDisplayServer,
  type FoundBrowser,
  findChrome,
} from '../chrome-finder.js';
import { createLogger, println } from '../logger.js';

export interface ChromeLaunchOptions {
  readonly port?: number;
  readonly userDataDir?: string;
  readonly chromePath?: string;
  readonly brand?: BrowserBrand;
  /** Run Chrome headless (`--headless=new`). */
  readonly headless?: boolean;
  /** Don't actually launch — print the command we *would* run. */
  readonly dryRun?: boolean;
  /** Spawn detached + unref. */
  readonly detach?: boolean;
  /** Extra Chrome flags (passed verbatim). */
  readonly extraArgs?: ReadonlyArray<string>;
  /** Override platform; for tests only. */
  readonly _platform?: NodeJS.Platform;
}

const DEFAULT_PORT = 9222;
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

function buildArgs(opts: {
  port: number;
  userDataDir: string;
  headless: boolean;
  extra: ReadonlyArray<string>;
}): string[] {
  const args: string[] = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    // browser-harness experience: these defaults make automated runs
    // far more reliable on Chrome 130+. They are NOT a privacy or
    // security regression for a launch that the user explicitly asked
    // for.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=PreloadingAttribute,InterestFeedContentSuggestions',
    '--disable-popup-blocking',
  ];
  if (opts.headless) {
    args.push('--headless=new');
    args.push('--hide-scrollbars');
  }
  args.push(...opts.extra);
  return args;
}

/** Wait for Chrome to write `DevToolsActivePort` into the user-data-dir.
 * That file's first line is the actual listening port (which may differ
 * from `--remote-debugging-port=0`). Second line is the WS target path.
 */
async function waitForDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
): Promise<{ port: number; targetPath: string } | null> {
  const filepath = join(userDataDir, DEVTOOLS_PORT_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const buf = await readFile(filepath, 'utf8');
      const lines = buf.split('\n');
      if (lines.length >= 1) {
        const port = Number.parseInt((lines[0] ?? '').trim(), 10);
        if (!Number.isNaN(port) && port > 0 && port <= 65535) {
          return { port, targetPath: (lines[1] ?? '').trim() };
        }
      }
    } catch {
      // ENOENT or partial write; retry.
    }
    await sleep(120);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

export async function runChrome(options: ChromeLaunchOptions = {}): Promise<void> {
  const logger = createLogger('info');
  const plat = options._platform ?? platform;

  // ─── 1. Resolve Chrome binary ─────────────────────────────────
  let browser: FoundBrowser | null;
  if (options.chromePath) {
    browser = { path: options.chromePath, brand: 'chrome', source: 'env' };
  } else {
    browser = await findChrome({
      ...(options.brand !== undefined ? { brand: options.brand } : {}),
    });
  }
  if (!browser) {
    println('Brisk could not find a Chrome-family browser on this system.');
    println('Try one of:');
    if (plat === 'win32') {
      println('  - Install Chrome: https://www.google.com/chrome/');
      println('  - Or set BRISK_CHROME_PATH=C:\\path\\to\\chrome.exe');
    } else if (plat === 'darwin') {
      println('  - Install Chrome: https://www.google.com/chrome/');
      println('  - Or run: brew install --cask google-chrome');
      println('  - Or set BRISK_CHROME_PATH=/path/to/Google Chrome');
    } else {
      println('  - Install Chrome:    sudo apt install google-chrome-stable');
      println('  - Install Chromium:  sudo apt install chromium');
      println('  - Or set BRISK_CHROME_PATH=/path/to/chrome');
    }
    process.exitCode = 1;
    return;
  }

  // ─── 2. Resolve user-data-dir ─────────────────────────────────
  let userDataDir = options.userDataDir;
  let ephemeralDir: string | null = null;
  if (!userDataDir) {
    ephemeralDir = await mkdtemp(join(tmpdir(), 'brisk-chrome-'));
    userDataDir = ephemeralDir;
  }

  // Refuse Chrome's platform default. Per install.md: Chrome 136+
  // silently no-ops `--remote-debugging-port` if user-data-dir is the
  // default profile location.
  if (isPlatformDefault(userDataDir, plat)) {
    println(`Refusing to launch with the platform-default user-data-dir:`);
    println(`  ${userDataDir}`);
    println('Chrome 136+ silently disables remote debugging for that path.');
    println('Use a non-default directory (or omit --user-data-dir to get a tmp one).');
    process.exitCode = 1;
    return;
  }

  // ─── 3. Build argv ────────────────────────────────────────────
  const port = options.port ?? DEFAULT_PORT;
  const args = buildArgs({
    port,
    userDataDir,
    headless: options.headless === true,
    extra: options.extraArgs ?? [],
  });

  // ─── 4. Linux platform sanity ─────────────────────────────────
  if (plat === 'linux') {
    const confinement = detectLinuxConfinement(browser.path);
    if (confinement === 'snap') {
      println('');
      println('warning: Snap-confined Chrome detected:');
      println(`  ${browser.path}`);
      println('  Snap chromium cannot read user-data-dirs outside $HOME/snap/.');
      println('  If launch hangs at "DevToolsActivePort", install non-snap Chrome:');
      println('    sudo apt install google-chrome-stable');
      println('');
    }
    const display = detectLinuxDisplayServer();
    if (display === 'wayland' && !options.headless) {
      println(
        'note: WAYLAND_DISPLAY set; if Chrome crashes, try --headless or unset WAYLAND_DISPLAY.',
      );
    }
    if (display === null && !options.headless) {
      println('note: no DISPLAY/WAYLAND_DISPLAY; you probably want --headless.');
    }
  }

  // ─── 5. Dry run ───────────────────────────────────────────────
  if (options.dryRun === true) {
    println('Would launch:');
    println(`  ${browser.path}`);
    for (const arg of args) println(`    ${arg}`);
    println(`  user-data-dir = ${userDataDir}`);
    if (ephemeralDir) await rm(ephemeralDir, { recursive: true, force: true });
    return;
  }

  // ─── 6. Spawn ─────────────────────────────────────────────────
  println(`brisk chrome: ${browser.brand} (${browser.source})`);
  println(`  binary       ${browser.path}`);
  println(`  port         ${port}`);
  println(`  user-data    ${userDataDir}`);
  if (options.headless) println('  headless     yes');

  const detach = options.detach === true;
  const child = spawn(browser.path, args, {
    detached: detach,
    stdio: detach ? 'ignore' : 'inherit',
    // Pass through env; Chrome itself reads many vars on Linux.
    env: process.env,
    // Windows: NEVER use shell:true — argument quoting gets miserable
    // (especially user-data-dir with spaces).
    shell: false,
    // Windows-specific: avoid console window when detached.
    windowsHide: detach,
  });

  if (detach) {
    child.unref();
  }

  const launchErrorRef: { value: Error | null } = { value: null };
  child.on('error', (err) => {
    launchErrorRef.value = err;
  });

  // Wait for DevToolsActivePort. The race against `child.exited` is
  // important: if Chrome crashed immediately, we want a fast fail.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = waitForDevToolsActivePort(userDataDir, 15_000).then((r) => ({
    kind: 'ready' as const,
    info: r,
  }));
  const exitFirst = exited.then((info) => ({ kind: 'exited' as const, info }));

  const first = await Promise.race([ready, exitFirst]);

  if (first.kind === 'exited') {
    if (launchErrorRef.value) {
      println(`Chrome failed to start: ${launchErrorRef.value.message}`);
    } else {
      println(
        `Chrome exited before becoming ready (code=${first.info.code}, signal=${first.info.signal}).`,
      );
    }
    if (ephemeralDir) await rm(ephemeralDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = 1;
    return;
  }

  if (!first.info) {
    println(`Chrome did not write ${DEVTOOLS_PORT_FILE} within 15s; aborting.`);
    child.kill();
    if (ephemeralDir) await rm(ephemeralDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = 1;
    return;
  }

  const actualPort = first.info.port;
  println('');
  println(`Ready. Chrome is listening on http://127.0.0.1:${actualPort}`);
  println('');
  println('Connect Brisk:');
  println(`  brisk doctor --cdp-port ${actualPort}`);
  println(`  brisk serve  --cdp-port ${actualPort}`);

  if (detach) {
    println('');
    println(
      `Chrome is running detached (pid=${child.pid}). Close the window or kill the process to stop.`,
    );
    if (ephemeralDir) {
      println(`Note: leaving the temp profile at ${ephemeralDir} for Chrome to use.`);
    }
    return;
  }

  // Attached: forward signals and wait.
  let userQuit = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      userQuit = true;
      println(`\nReceived ${signal}; closing Chrome.`);
      if (!child.killed) child.kill(signal);
    });
  }

  const finalExit = await exited;
  logger.debug(`chrome exited code=${finalExit.code} signal=${finalExit.signal}`);

  if (ephemeralDir) {
    // Best-effort cleanup; on Windows the lock files sometimes linger.
    await rm(ephemeralDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!userQuit && finalExit.code !== 0 && finalExit.code !== null) {
    process.exitCode = finalExit.code;
  }
}

/** Detect Chrome's platform-default user-data-dir, which we must NOT
 * pass to `--user-data-dir` (Chrome 136+ silently disables the port).
 *
 * Sources: install.md (browser-harness), Chrome source `chrome/browser/...`
 */
export function isPlatformDefault(path: string, plat: NodeJS.Platform = platform): boolean {
  const normalised = path.replace(/\\/g, '/');
  if (plat === 'win32') {
    const localAppData = (process.env.LOCALAPPDATA ?? '').replace(/\\/g, '/');
    if (!localAppData) return false;
    const def = `${localAppData}/Google/Chrome/User Data`;
    return normalised.toLowerCase() === def.toLowerCase();
  }
  if (plat === 'darwin') {
    const home = process.env.HOME ?? '';
    if (!home) return false;
    const def = `${home}/Library/Application Support/Google/Chrome`;
    return normalised === def;
  }
  // Linux
  const home = process.env.HOME ?? '';
  if (!home) return false;
  const candidates = [
    `${home}/.config/google-chrome`,
    `${home}/.config/chromium`,
    `${home}/.config/microsoft-edge`,
  ];
  return candidates.includes(normalised);
}
