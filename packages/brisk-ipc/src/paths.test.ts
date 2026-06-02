import { platform, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { ipcPath, isWindowsPipe } from './paths.js';

const IS_WINDOWS = platform() === 'win32';

describe('ipcPath', () => {
  it('returns a platform-correct path for a valid name', () => {
    const p = ipcPath('default');
    if (IS_WINDOWS) {
      expect(p).toBe('\\\\.\\pipe\\brisk-default');
      expect(isWindowsPipe(p)).toBe(true);
    } else {
      expect(p.startsWith(tmpdir())).toBe(true);
      expect(p.endsWith('brisk-default.sock')).toBe(true);
      expect(isWindowsPipe(p)).toBe(false);
    }
  });

  it('accepts letters, digits, dashes, underscores', () => {
    expect(() => ipcPath('a')).not.toThrow();
    expect(() => ipcPath('a1')).not.toThrow();
    expect(() => ipcPath('a_1')).not.toThrow();
    expect(() => ipcPath('A-B-2026')).not.toThrow();
    expect(() => ipcPath('a'.repeat(64))).not.toThrow();
  });

  it('rejects path-traversal & shell-meta', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a b', 'a;b', '$x', '*', '']) {
      expect(() => ipcPath(bad)).toThrow(/IPC name/);
    }
  });

  it('rejects names longer than 64 chars', () => {
    expect(() => ipcPath('a'.repeat(65))).toThrow(/IPC name/);
  });

  it('rejects names starting with a hyphen or underscore', () => {
    expect(() => ipcPath('-foo')).toThrow(/IPC name/);
    expect(() => ipcPath('_foo')).toThrow(/IPC name/);
  });
});
