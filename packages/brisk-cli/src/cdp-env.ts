import type { DiscoveryOptions } from '@brisk/core';

import type { BootOptions } from './boot.js';

export const BRISK_CDP_WS_ENV = 'BRISK_CDP_WS' as const;
export const BRISK_CDP_URL_ENV = 'BRISK_CDP_URL' as const;

export interface ResolvedCdpConfig {
  readonly cdpWs?: string;
  readonly cdpUrl?: string;
  readonly cdpPort?: number;
  readonly source: 'cli-ws' | 'cli-url' | 'cli-port' | 'env-ws' | 'env-url' | 'auto';
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve CLI + env CDP config without changing discovery's cascade.
 *
 * Explicit CLI flags win because they are closest to the user's command.
 * Without CLI flags, env precedence is:
 *   BRISK_CDP_WS > BRISK_CDP_URL > DevToolsActivePort > 9222/9223
 */
export function resolveCdpConfig(options: BootOptions): ResolvedCdpConfig {
  if (options.cdpWs) return { cdpWs: options.cdpWs, source: 'cli-ws' };
  if (options.cdpUrl) return { cdpUrl: options.cdpUrl, source: 'cli-url' };
  if (options.cdpPort !== undefined) return { cdpPort: options.cdpPort, source: 'cli-port' };

  const envWs = nonEmptyEnv(BRISK_CDP_WS_ENV);
  if (envWs) return { cdpWs: envWs, source: 'env-ws' };
  const envUrl = nonEmptyEnv(BRISK_CDP_URL_ENV);
  if (envUrl) return { cdpUrl: envUrl, source: 'env-url' };
  return { source: 'auto' };
}

export function discoveryOptionsFromResolvedCdp(config: ResolvedCdpConfig): DiscoveryOptions {
  return {
    ...(config.cdpWs ? { wsUrl: config.cdpWs } : {}),
    ...(config.cdpUrl ? { httpUrl: config.cdpUrl } : {}),
    ...(config.cdpPort !== undefined ? { port: config.cdpPort, profileDirs: [] } : {}),
  };
}
