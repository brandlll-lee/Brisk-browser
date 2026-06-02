/**
 * Cross-platform Chrome / Chromium / Edge / Brave executable discovery.
 *
 * Modeled on browser-harness's install.md "Way 2" path: launch Chrome
 * with --remote-debugging-port=<n> --user-data-dir=<non-default>. To do
 * that, we first need to find a Chrome-family binary.
 *
 * Priority order (per platform):
 *   1. Environment override: BRISK_CHROME_PATH
 *   2. PATH lookup (`google-chrome`, `chrome`, etc.)
 *   3. Platform-specific known install paths
 *
 * The discovered binary is just an executable path; this module does
 * NOT spawn anything. `commands/chrome.ts` handles launching.
 */

import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { env, platform } from 'node:process';

/** Brand of browser found. Useful for diagnostics — we treat them
 * identically as far as `--remote-debugging-port` goes (all support
 * CDP because they're all Chromium-based).
 */
export type BrowserBrand =
  | 'chrome'
  | 'chrome-canary'
  | 'chromium'
  | 'edge'
  | 'edge-canary'
  | 'brave'
  | 'brave-nightly'
  | 'opera'
  | 'vivaldi'
  | 'arc';

export interface FoundBrowser {
  readonly path: string;
  readonly brand: BrowserBrand;
  readonly source: 'env' | 'path' | 'known-location';
}

export interface FindOptions {
  /** Restrict to a single brand (e.g. only `chrome`, not Edge). */
  readonly brand?: BrowserBrand;
  /** Don't honour BRISK_CHROME_PATH; useful for testing. */
  readonly ignoreEnv?: boolean;
}

const WINDOWS_KNOWN: ReadonlyArray<readonly [BrowserBrand, ReadonlyArray<string>]> = [
  [
    'chrome',
    [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe',
    ],
  ],
  [
    'chrome-canary',
    [
      '%LocalAppData%\\Google\\Chrome SxS\\Application\\chrome.exe',
      '%ProgramFiles%\\Google\\Chrome SxS\\Application\\chrome.exe',
    ],
  ],
  ['chromium', ['%LocalAppData%\\Chromium\\Application\\chrome.exe']],
  [
    'edge',
    [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  ],
  [
    'edge-canary',
    [
      '%LocalAppData%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
      '%ProgramFiles(x86)%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
    ],
  ],
  [
    'brave',
    [
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LocalAppData%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  ],
  ['vivaldi', ['%LocalAppData%\\Vivaldi\\Application\\vivaldi.exe']],
];

const MAC_KNOWN: ReadonlyArray<readonly [BrowserBrand, ReadonlyArray<string>]> = [
  ['chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
  ['chrome-canary', ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary']],
  ['chromium', ['/Applications/Chromium.app/Contents/MacOS/Chromium']],
  ['edge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
  ['edge-canary', ['/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary']],
  ['brave', ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']],
  [
    'brave-nightly',
    ['/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly'],
  ],
  ['arc', ['/Applications/Arc.app/Contents/MacOS/Arc']],
];

const LINUX_PATH_NAMES: ReadonlyArray<readonly [BrowserBrand, ReadonlyArray<string>]> = [
  ['chrome', ['google-chrome', 'google-chrome-stable', 'chrome']],
  ['chrome-canary', ['google-chrome-canary', 'google-chrome-unstable']],
  ['chromium', ['chromium', 'chromium-browser']],
  ['edge', ['microsoft-edge', 'microsoft-edge-stable']],
  ['edge-canary', ['microsoft-edge-dev', 'microsoft-edge-canary']],
  ['brave', ['brave', 'brave-browser']],
  ['opera', ['opera']],
  ['vivaldi', ['vivaldi', 'vivaldi-stable']],
];

const LINUX_KNOWN: ReadonlyArray<readonly [BrowserBrand, ReadonlyArray<string>]> = [
  [
    'chrome',
    [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome/chrome',
    ],
  ],
  ['chromium', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']],
  ['edge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']],
  ['brave', ['/usr/bin/brave-browser', '/snap/bin/brave']],
];

/** Expand %VAR% on Windows. Returns null if any var is unset. */
function expandWinEnv(input: string): string | null {
  let out = input;
  const re = /%([^%]+)%/g;
  for (;;) {
    const m = re.exec(input);
    if (!m) break;
    const value = env[m[1] as string];
    if (value === undefined) return null;
    out = out.replaceAll(`%${m[1] as string}%`, value);
  }
  return out;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    // On Windows constants.X_OK is approximated; fall back to F_OK.
    try {
      await access(path, constants.F_OK);
      return platform === 'win32';
    } catch {
      return false;
    }
  }
}

/** Walk every PATH entry for the given executable names. */
async function whichOnPath(names: ReadonlyArray<string>): Promise<string | null> {
  const PATH = env.PATH ?? env.Path ?? '';
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = PATH.split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, `${name}${ext}`);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Locate one Chrome-family browser. Returns `null` if nothing usable
 * was found.
 *
 * For diagnostics, see {@link findAllChromes}.
 */
export async function findChrome(options: FindOptions = {}): Promise<FoundBrowser | null> {
  if (!options.ignoreEnv) {
    const override = env.BRISK_CHROME_PATH;
    if (override && (await isExecutable(override))) {
      return { path: override, brand: 'chrome', source: 'env' };
    }
  }

  const wantBrand = options.brand;

  if (platform === 'win32') {
    for (const [brand, candidates] of WINDOWS_KNOWN) {
      if (wantBrand && brand !== wantBrand) continue;
      for (const raw of candidates) {
        const expanded = expandWinEnv(raw);
        if (!expanded) continue;
        if (await isExecutable(expanded)) {
          return { path: expanded, brand, source: 'known-location' };
        }
      }
    }
    // Fall back to PATH.
    const onPath = await whichOnPath(['chrome', 'msedge', 'brave', 'chromium']);
    if (onPath) return { path: onPath, brand: 'chrome', source: 'path' };
  } else if (platform === 'darwin') {
    for (const [brand, candidates] of MAC_KNOWN) {
      if (wantBrand && brand !== wantBrand) continue;
      for (const path of candidates) {
        if (await isExecutable(path)) return { path, brand, source: 'known-location' };
      }
    }
  } else {
    // Linux + everything else.
    for (const [brand, candidates] of LINUX_KNOWN) {
      if (wantBrand && brand !== wantBrand) continue;
      for (const path of candidates) {
        if (await isExecutable(path)) return { path, brand, source: 'known-location' };
      }
    }
    for (const [brand, names] of LINUX_PATH_NAMES) {
      if (wantBrand && brand !== wantBrand) continue;
      const onPath = await whichOnPath(names);
      if (onPath) return { path: onPath, brand, source: 'path' };
    }
  }

  return null;
}

/** Find every Chrome-family browser on disk. Useful for diagnostics. */
export async function findAllChromes(): Promise<FoundBrowser[]> {
  const seen = new Set<string>();
  const out: FoundBrowser[] = [];

  const env_override = env.BRISK_CHROME_PATH;
  if (env_override && (await isExecutable(env_override)) && !seen.has(env_override)) {
    seen.add(env_override);
    out.push({ path: env_override, brand: 'chrome', source: 'env' });
  }

  if (platform === 'win32') {
    for (const [brand, candidates] of WINDOWS_KNOWN) {
      for (const raw of candidates) {
        const expanded = expandWinEnv(raw);
        if (!expanded) continue;
        if ((await isExecutable(expanded)) && !seen.has(expanded)) {
          seen.add(expanded);
          out.push({ path: expanded, brand, source: 'known-location' });
        }
      }
    }
  } else if (platform === 'darwin') {
    for (const [brand, candidates] of MAC_KNOWN) {
      for (const path of candidates) {
        if ((await isExecutable(path)) && !seen.has(path)) {
          seen.add(path);
          out.push({ path, brand, source: 'known-location' });
        }
      }
    }
  } else {
    for (const [brand, candidates] of LINUX_KNOWN) {
      for (const path of candidates) {
        if ((await isExecutable(path)) && !seen.has(path)) {
          seen.add(path);
          out.push({ path, brand, source: 'known-location' });
        }
      }
    }
    for (const [brand, names] of LINUX_PATH_NAMES) {
      const onPath = await whichOnPath(names);
      if (onPath && !seen.has(onPath)) {
        seen.add(onPath);
        out.push({ path: onPath, brand, source: 'path' });
      }
    }
  }

  return out;
}

/**
 * Detect whether the given Chrome path lives inside a Snap install on
 * Linux. Snap-confined Chrome has serious restrictions: it cannot read
 * arbitrary `--user-data-dir` paths (only those under
 * `$HOME/snap/chromium/...`), and crashes on Wayland in some setups.
 *
 * Returns:
 *   - "snap" if the path is under /snap/
 *   - "flatpak" if under /var/lib/flatpak or ~/.local/share/flatpak
 *   - null otherwise
 */
export function detectLinuxConfinement(path: string): 'snap' | 'flatpak' | null {
  if (platform !== 'linux') return null;
  const normalised = path.replace(/\\/g, '/');
  if (normalised.startsWith('/snap/')) return 'snap';
  if (normalised.startsWith('/var/lib/flatpak/') || normalised.includes('/.local/share/flatpak/')) {
    return 'flatpak';
  }
  return null;
}

/** Returns the Linux display server ("wayland" | "x11" | null). */
export function detectLinuxDisplayServer(): 'wayland' | 'x11' | null {
  if (platform !== 'linux') return null;
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return null;
}
