import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverCdpEndpoint = vi.fn(async () => ({
  webSocketDebuggerUrl: 'ws://127.0.0.1:9440/devtools/browser/test',
  host: '127.0.0.1',
}));

class MockCdpBackend {
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  isConnected = vi.fn(() => true);
}

class MockDaemon {
  start = vi.fn(async () => {});
  shutdown = vi.fn(() => {});
  getSession = vi.fn(() => ({ sessionId: 'S1', targetId: 'T1' }));
}

vi.mock('@brisk/core', () => ({
  CdpBackend: MockCdpBackend,
  Daemon: MockDaemon,
  discoverCdpEndpoint,
}));

vi.mock('@brisk/skills', () => ({
  SkillsManager: class {
    layout = { root: 'unused' };
    ensureWorkspace = vi.fn(async () => {});
    close = vi.fn(() => {});
  },
}));

describe('boot', () => {
  afterEach(() => {
    discoverCdpEndpoint.mockClear();
    vi.unstubAllEnvs();
  });

  it('treats cdpPort as an explicit endpoint and skips profile discovery', async () => {
    const { boot } = await import('./boot.js');

    const booted = await boot({ cdpPort: 9440, noSkills: true });
    await booted.shutdown();

    expect(discoverCdpEndpoint).toHaveBeenCalledWith({
      port: 9440,
      profileDirs: [],
    });
  });

  it('uses BRISK_CDP_WS when no CLI endpoint is provided', async () => {
    vi.stubEnv('BRISK_CDP_WS', 'ws://127.0.0.1:9555/devtools/browser/env');
    vi.stubEnv('BRISK_CDP_URL', 'http://127.0.0.1:9666');
    const { boot } = await import('./boot.js');

    const booted = await boot({ noSkills: true });
    await booted.shutdown();

    expect(discoverCdpEndpoint).toHaveBeenCalledWith({
      wsUrl: 'ws://127.0.0.1:9555/devtools/browser/env',
    });
  });

  it('uses BRISK_CDP_URL when BRISK_CDP_WS is unset', async () => {
    vi.stubEnv('BRISK_CDP_URL', 'http://127.0.0.1:9666');
    const { boot } = await import('./boot.js');

    const booted = await boot({ noSkills: true });
    await booted.shutdown();

    expect(discoverCdpEndpoint).toHaveBeenCalledWith({
      httpUrl: 'http://127.0.0.1:9666',
    });
  });

  it('lets CLI cdpWs override env endpoints', async () => {
    vi.stubEnv('BRISK_CDP_WS', 'ws://127.0.0.1:9555/devtools/browser/env');
    const { boot } = await import('./boot.js');

    const booted = await boot({
      cdpWs: 'ws://127.0.0.1:9777/devtools/browser/cli',
      noSkills: true,
    });
    await booted.shutdown();

    expect(discoverCdpEndpoint).toHaveBeenCalledWith({
      wsUrl: 'ws://127.0.0.1:9777/devtools/browser/cli',
    });
  });
});
