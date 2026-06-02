/**
 * W6 perf gate: a single full-stack interaction round-trip
 * (goto + capture_screenshot + click_at_xy + capture_screenshot)
 * must complete in ≤ 800 ms on a local machine with a real Chrome.
 *
 * We talk directly to the helpers (not over MCP) to time the actual
 * CDP work, not the JSON-RPC overhead. The MCP path is exercised by
 * stdio.spec.ts / http.spec.ts.
 *
 * Skipped when no Chrome is installed. Set BRISK_BENCHMARK_BUDGET_MS
 * to override the default budget.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

const CHROME_CANDIDATES = [
  process.env.BRISK_E2E_CHROME ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[];

const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
test.skip(!chromeBin, 'no Chrome installed');

const BUDGET_MS = Number.parseInt(process.env.BRISK_BENCHMARK_BUDGET_MS ?? '800', 10);

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });

  if (port <= 0) throw new Error('Could not allocate benchmark CDP port');
  return port;
}

async function fetchOK(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

async function stopChrome(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  if (await waitForExit(child, 1_500)) return;

  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.once('exit', () => resolveKill());
      killer.once('error', () => resolveKill());
    });
    await waitForExit(child, 1_500);
    return;
  }

  child.kill('SIGKILL');
  await waitForExit(child, 1_500);
}

test('benchmark: goto + screenshot + click + screenshot ≤ budget', async () => {
  if (!chromeBin) throw new Error('Chrome not found');
  // 1. Spawn Chrome.
  const profile = mkdtempSync(resolve(tmpdir(), 'brisk-bench-'));
  const port = await getFreePort();
  const chrome = spawn(
    chromeBin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--window-size=1280,720',
      'about:blank',
    ],
    { stdio: 'pipe' },
  );
  chrome.stderr?.on('data', () => {});
  chrome.stdout?.on('data', () => {});

  // Wait for CDP.
  const deadline = Date.now() + 15_000;
  let cdpReady = false;
  while (Date.now() < deadline) {
    if (await fetchOK(`http://127.0.0.1:${port}/json/version`, 500)) {
      cdpReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(cdpReady).toBe(true);

  try {
    const { boot } = await import('../src/boot.js');
    const briskCore = await import('@brisk/core');
    const { goto, captureScreenshot, clickAtXY, waitForElement, waitForLoad } = briskCore;

    const booted = await boot({ cdpPort: port, noSkills: true });
    const ctx = { cdp: booted.cdp, daemon: booted.daemon };

    try {
      // Use a small file: URL so the network cost is zero — we want to
      // measure CDP overhead, not the internet. A raw data: URL can
      // report navigation success before Chrome swaps execution context.
      const html =
        '<!doctype html><button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Click</button>';
      const pagePath = resolve(profile, 'benchmark.html');
      writeFileSync(pagePath, html);
      const pageUrl = pathToFileURL(pagePath).href;

      const t0 = performance.now();

      const navRes = await goto(ctx, { url: pageUrl });
      expect(navRes.ok).toBe(true);

      const load = await waitForLoad(ctx, { timeoutSeconds: 5, pollMs: 50 });
      expect(load.ok && load.value.ready).toBe(true);

      const button = await waitForElement(ctx, {
        selector: '#b',
        timeoutSeconds: 5,
        pollMs: 50,
      });
      expect(button.ok && button.value.found).toBe(true);

      const shot1 = await captureScreenshot(ctx, { optimizeForSpeed: true });
      expect(shot1.ok, shot1.ok ? undefined : shot1.error.message).toBe(true);

      const click = await clickAtXY(ctx, {
        x: 160,
        y: 120,
        button: 'left',
        clicks: 1,
      });
      expect(click.ok).toBe(true);

      const shot2 = await captureScreenshot(ctx, { optimizeForSpeed: true });
      expect(shot2.ok, shot2.ok ? undefined : shot2.error.message).toBe(true);

      const elapsed = performance.now() - t0;
      console.log(
        `[benchmark] goto+shot+click+shot = ${elapsed.toFixed(1)} ms (budget ${BUDGET_MS} ms)`,
      );

      // Soft assertion: log + check.
      expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    } finally {
      await booted.shutdown();
    }
  } finally {
    await stopChrome(chrome);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});
