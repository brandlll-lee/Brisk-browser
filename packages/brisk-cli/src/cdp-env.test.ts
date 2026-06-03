import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoveryOptionsFromResolvedCdp, resolveCdpConfig } from './cdp-env.js';

describe('resolveCdpConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers CLI ws over every other endpoint', () => {
    vi.stubEnv('BRISK_CDP_WS', 'ws://env/devtools/browser/x');
    vi.stubEnv('BRISK_CDP_URL', 'http://127.0.0.1:9222');

    expect(resolveCdpConfig({ cdpWs: 'ws://cli/devtools/browser/y' })).toEqual({
      cdpWs: 'ws://cli/devtools/browser/y',
      source: 'cli-ws',
    });
  });

  it('applies env precedence when CLI endpoint flags are absent', () => {
    vi.stubEnv('BRISK_CDP_WS', 'ws://env/devtools/browser/x');
    vi.stubEnv('BRISK_CDP_URL', 'http://127.0.0.1:9222');

    expect(resolveCdpConfig({})).toEqual({
      cdpWs: 'ws://env/devtools/browser/x',
      source: 'env-ws',
    });
  });

  it('falls back to BRISK_CDP_URL when BRISK_CDP_WS is blank', () => {
    vi.stubEnv('BRISK_CDP_WS', '  ');
    vi.stubEnv('BRISK_CDP_URL', 'http://127.0.0.1:9222');

    expect(resolveCdpConfig({})).toEqual({
      cdpUrl: 'http://127.0.0.1:9222',
      source: 'env-url',
    });
  });

  it('converts resolved port to profile-skipping discovery options', () => {
    expect(discoveryOptionsFromResolvedCdp({ cdpPort: 9333, source: 'cli-port' })).toEqual({
      port: 9333,
      profileDirs: [],
    });
  });
});
