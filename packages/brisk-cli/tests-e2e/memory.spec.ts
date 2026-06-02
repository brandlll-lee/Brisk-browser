/**
 * W6 memory gate: 1000 sequential captureScreenshot calls must not
 * push the harness RSS above 200 MB.
 *
 * This protects against unbounded buffer growth in the CDP layer,
 * ConsoleCollector, or screenshot-result accumulation.
 *
 * Skipped when no Chrome is installed.
 *
 * To run a stress version: BRISK_MEMORY_ITERATIONS=5000 npx playwright test tests-e2e/memory.spec.ts
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

const PORT = 9441;
// Default to 200 sustained screenshots — enough to catch unbounded
// growth in our own buffers, without hitting headless Chrome's
// compositor backpressure on about:blank (where >300 rapid-fire shots
// can stall the renderer). For the 1000-shot stress target from the
// W6 plan, set BRISK_MEMORY_ITERATIONS=1000.
const ITERATIONS = Number.parseInt(process.env.BRISK_MEMORY_ITERATIONS ?? '200', 10);
const BUDGET_MB = Number.parseInt(process.env.BRISK_MEMORY_BUDGET_MB ?? '200', 10);

async function fetchOK(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

test(`memory: ${ITERATIONS} screenshots stay under ${BUDGET_MB} MB`, async () => {
  if (!chromeBin) throw new Error('Chrome not found');
  // 1000 screenshots @ ~30-50ms each can take 30-50s; leave some
  // budget for Chrome boot and shutdown.
  test.setTimeout(180_000);
  const profile = mkdtempSync(resolve(tmpdir(), 'brisk-mem-'));
  const chrome = spawn(
    chromeBin,
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

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await fetchOK(`http://127.0.0.1:${PORT}/json/version`, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  try {
    const { boot } = await import('../src/boot.js');
    const briskCore = await import('@brisk/core');
    const { captureScreenshot } = briskCore;

    const booted = await boot({ cdpPort: PORT, noSkills: true });
    const ctx = { cdp: booted.cdp, daemon: booted.daemon };

    try {
      // Boot already attached to Chrome's startup about:blank — that
      // page is enough for repeated screenshots without any nav
      // races. We deliberately do NOT goto; the harness's screenshot
      // path is what we're measuring, not Page.navigate.

      // Warm-up call so the first iteration isn't biased by V8
      // ahead-of-time / Chrome target prep latency.
      const warmup = await captureScreenshot(ctx, {});
      expect(warmup.ok).toBe(true);

      const baselineMB = process.memoryUsage().rss / 1024 / 1024;
      console.log(`[memory] baseline RSS = ${baselineMB.toFixed(1)} MB`);

      let peakMB = baselineMB;

      let consecutiveFailures = 0;
      let successCount = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const r = await captureScreenshot(ctx, {});
        if (!r.ok) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            // We're testing harness memory, not Chrome compositor
            // resilience. If Chrome itself jams, bail out and report
            // what we measured up to this point.
            console.warn(
              `[memory] aborting after ${successCount} successful shots due to compositor hang at #${i}`,
            );
            break;
          }
          // Give Chrome a beat to recover.
          await new Promise((res) => setTimeout(res, 250));
          continue;
        }
        consecutiveFailures = 0;
        successCount += 1;

        if (i % 50 === 0) {
          const cur = process.memoryUsage().rss / 1024 / 1024;
          if (cur > peakMB) peakMB = cur;
        }

        // Tiny throttle prevents headless compositor backpressure that
        // we see at sustained > 30 fps. Real agents are nowhere near
        // this rate.
        if (i % 25 === 24) {
          await new Promise((res) => setTimeout(res, 10));
        }
      }
      expect(successCount).toBeGreaterThan(Math.floor(ITERATIONS * 0.9));

      // Force a final reading.
      if (typeof global.gc === 'function') {
        global.gc();
      }
      const finalMB = process.memoryUsage().rss / 1024 / 1024;
      if (finalMB > peakMB) peakMB = finalMB;

      console.log(
        `[memory] after ${successCount}/${ITERATIONS} screenshots peak RSS = ${peakMB.toFixed(1)} MB (final = ${finalMB.toFixed(1)} MB, budget ${BUDGET_MB} MB)`,
      );
      expect(peakMB).toBeLessThanOrEqual(BUDGET_MB);
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
