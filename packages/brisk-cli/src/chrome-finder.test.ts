import { describe, expect, it } from 'vitest';

import {
  detectLinuxConfinement,
  detectLinuxDisplayServer,
  findAllChromes,
  findChrome,
} from './chrome-finder.js';

describe('chrome-finder', () => {
  it('runs without throwing on any platform', async () => {
    const found = await findChrome();
    // We can't assert it's non-null because CI may not have Chrome
    // installed; just assert the API contract.
    expect(found === null || typeof found === 'object').toBe(true);
    if (found) {
      expect(typeof found.path).toBe('string');
      expect(found.path.length).toBeGreaterThan(0);
      expect(['env', 'path', 'known-location']).toContain(found.source);
    }
  });

  it('findAllChromes returns an array', async () => {
    const all = await findAllChromes();
    expect(Array.isArray(all)).toBe(true);
    // Every entry should have a unique path
    const paths = all.map((b) => b.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('respects BRISK_CHROME_PATH override', async () => {
    const prev = process.env.BRISK_CHROME_PATH;
    process.env.BRISK_CHROME_PATH = process.execPath; // node itself is "executable"
    try {
      const found = await findChrome();
      expect(found).not.toBeNull();
      expect(found?.source).toBe('env');
      expect(found?.path).toBe(process.execPath);
    } finally {
      if (prev === undefined) delete process.env.BRISK_CHROME_PATH;
      else process.env.BRISK_CHROME_PATH = prev;
    }
  });

  it('respects ignoreEnv', async () => {
    const prev = process.env.BRISK_CHROME_PATH;
    process.env.BRISK_CHROME_PATH = process.execPath;
    try {
      const found = await findChrome({ ignoreEnv: true });
      // Either platform discovery worked, or it's null — but never env.
      expect(found?.source).not.toBe('env');
    } finally {
      if (prev === undefined) delete process.env.BRISK_CHROME_PATH;
      else process.env.BRISK_CHROME_PATH = prev;
    }
  });

  describe('detectLinuxConfinement', () => {
    it('flags snap paths on Linux', () => {
      if (process.platform !== 'linux') {
        expect(detectLinuxConfinement('/snap/bin/chromium')).toBe(null);
      } else {
        expect(detectLinuxConfinement('/snap/bin/chromium')).toBe('snap');
        expect(detectLinuxConfinement('/snap/chromium/current/chromium')).toBe('snap');
      }
    });

    it('flags flatpak paths on Linux', () => {
      if (process.platform === 'linux') {
        expect(detectLinuxConfinement('/var/lib/flatpak/exports/bin/com.google.Chrome')).toBe(
          'flatpak',
        );
      }
    });

    it('returns null for native installs', () => {
      if (process.platform === 'linux') {
        expect(detectLinuxConfinement('/usr/bin/google-chrome')).toBe(null);
      }
    });
  });

  describe('detectLinuxDisplayServer', () => {
    it('returns null on non-Linux', () => {
      if (process.platform !== 'linux') {
        expect(detectLinuxDisplayServer()).toBe(null);
      }
    });

    it('returns wayland|x11|null on Linux based on env', () => {
      if (process.platform !== 'linux') return;
      const result = detectLinuxDisplayServer();
      expect([null, 'wayland', 'x11']).toContain(result);
    });
  });
});
