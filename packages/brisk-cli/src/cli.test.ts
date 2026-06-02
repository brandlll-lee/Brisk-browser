/**
 * Smoke tests for the Brisk CLI surface.
 *
 * We don't exercise the full daemon/serve commands here (those need a
 * live Chrome; they get an E2E test). Instead we verify:
 *   1. `brisk --version` prints the version
 *   2. `brisk --help` lists doctor / serve / daemon
 *   3. `brisk daemon --help` lists start / stop / status
 *   4. `brisk daemon status` against a fake instance returns "not running"
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..', 'dist', 'index.js');

function brisk(args: string[]): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status ?? -1,
  };
}

describe('brisk cli', () => {
  it('--version prints the version', () => {
    const { stdout, code } = brisk(['--version']);
    expect(code).toBe(0);
    expect(stdout).toContain('0.1.0');
  });

  it('--help advertises every top-level command', () => {
    const { stdout, code } = brisk(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('serve');
    expect(stdout).toContain('daemon');
    expect(stdout).toContain('chrome');
  });

  it('chrome --help advertises launch options', () => {
    const { stdout, code } = brisk(['chrome', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--user-data-dir');
    expect(stdout).toContain('--headless');
    expect(stdout).toContain('--dry-run');
  });

  it('serve --help advertises remote binding guard', () => {
    const { stdout, code } = brisk(['serve', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--allow-remote');
  });

  it('daemon --help advertises start / stop / status', () => {
    const { stdout, code } = brisk(['daemon', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('start');
    expect(stdout).toContain('stop');
    expect(stdout).toContain('status');
  });

  it('daemon status reports not running for an unused instance', () => {
    const { stdout, code } = brisk([
      'daemon',
      'status',
      '--instance',
      `brisk-test-unused-${Date.now()}`,
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('not running');
  });
});
