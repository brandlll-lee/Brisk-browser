import { describe, expect, it, vi } from 'vitest';

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
  it('treats cdpPort as an explicit endpoint and skips profile discovery', async () => {
    const { boot } = await import('./boot.js');

    const booted = await boot({ cdpPort: 9440, noSkills: true });
    await booted.shutdown();

    expect(discoverCdpEndpoint).toHaveBeenCalledWith({
      port: 9440,
      profileDirs: [],
    });
  });
});
