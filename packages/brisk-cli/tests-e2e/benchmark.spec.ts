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

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

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

const PORT = 9440;
const BUDGET_MS = Number.parseInt(process.env.BRISK_BENCHMARK_BUDGET_MS ?? '800', 10);

async function fetchOK(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

test('benchmark: goto + screenshot + click + screenshot ≤ budget', async () => {
  // 1. Spawn Chrome.
  const profile = mkdtempSync(resolve(tmpdir(), 'brisk-bench-'));
  const chrome = spawn(
    chromeBin!,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'pipe' },
  );
  chrome.stderr?.on('data', () => {});
  chrome.stdout?.on('data', () => {});

  // Wait for CDP.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await fetchOK(`http://127.0.0.1:${PORT}/json/version`, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  try {
    const { boot } = await import('../src/boot.js');
    const briskCore = await import('@brisk/core');
    const { goto, captureScreenshot, clickAtXY } = briskCore;

    const booted = await boot({ cdpPort: PORT, noSkills: true });
    const ctx = { cdp: booted.cdp, daemon: booted.daemon };

    try {
      // Use a small data: URL so the network cost is zero — we want to
      // measure CDP overhead, not the internet.
      const dataUrl =
        'data:text/html,<button id=b style="position:absolute;left:100px;top:100px;width:120px;height:40px">Click</button>';

      const t0 = performance.now();

      const navRes = await goto(ctx, { url: dataUrl });
      expect(navRes.ok).toBe(true);

      const shot1 = await captureScreenshot(ctx, {});
      expect(shot1.ok).toBe(true);

      const click = await clickAtXY(ctx, {
        x: 160,
        y: 120,
        button: 'left',
        clicks: 1,
      });
      expect(click.ok).toBe(true);

      const shot2 = await captureScreenshot(ctx, {});
      expect(shot2.ok).toBe(true);

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
    chrome.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!chrome.killed) chrome.kill('SIGKILL');
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});
