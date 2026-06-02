/**
 * Shared boot path for `brisk serve` and `brisk daemon start`.
 *
 * 1. Resolve CDP endpoint via the four-stage discovery cascade.
 * 2. Connect a CdpBackend with the standard keepalive / reconnect policy.
 * 3. Build a Daemon and call `start()` (attaches to a real page).
 * 4. Lazily construct a SkillsManager pointing at the workspace dir.
 * 5. Return a shutdown closure that tears it all down in reverse order.
 *
 * The skills layer is opt-out via `noSkills: true` — used by hermetic
 * smoke tests and by users who don't care about the self-learning
 * pipeline.
 */

import {
  type BackendLogger,
  type CdpBackend,
  CdpBackend as CdpBackendImpl,
  type CdpEndpoint,
  Daemon,
  discoverCdpEndpoint,
} from '@brisk/core';
import { SkillsManager } from '@brisk/skills';

import type { CliLogger } from './logger.js';

export interface BootOptions {
  /** Direct CDP WebSocket URL (overrides cascade). */
  readonly cdpWs?: string;
  /** HTTP base URL (e.g. http://localhost:9222) — used for /json/version. */
  readonly cdpUrl?: string;
  /** Default debugging port (used as the last-resort probe). */
  readonly cdpPort?: number;
  /** Override the workspace root for skills. */
  readonly workspaceRoot?: string;
  /** Skip SkillsManager initialisation (still passes `null` through). */
  readonly noSkills?: boolean;
  /** Logger for boot messages. Defaults to stderr. */
  readonly logger?: CliLogger;
}

export interface Boot {
  readonly endpoint: CdpEndpoint;
  readonly cdp: CdpBackend;
  readonly daemon: Daemon;
  readonly skills: SkillsManager | null;
  shutdown(): Promise<void>;
}

const NOOP_BACKEND_LOGGER: BackendLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function bridge(cli: CliLogger | undefined): BackendLogger {
  if (!cli) return NOOP_BACKEND_LOGGER;
  return {
    debug: (m) => cli.debug(m),
    info: (m) => cli.info(m),
    warn: (m) => cli.warn(m),
    error: (m) => cli.error(m),
  };
}

/**
 * Bring up the Brisk runtime against an existing Chrome.
 *
 * Throws BriskError on discovery / connection failure. Caller is
 * responsible for surfacing the error to the user.
 */
export async function boot(options: BootOptions): Promise<Boot> {
  const cliLogger = options.logger;
  const backendLogger = bridge(cliLogger);

  cliLogger?.info('Discovering CDP endpoint…');
  const endpoint = await discoverCdpEndpoint({
    ...(options.cdpWs ? { wsUrl: options.cdpWs } : {}),
    ...(options.cdpUrl ? { httpUrl: options.cdpUrl } : {}),
    ...(options.cdpPort ? { port: options.cdpPort } : {}),
  });
  cliLogger?.info(`Using CDP endpoint: ${endpoint.webSocketDebuggerUrl}`);

  const cdp = new CdpBackendImpl({
    endpoint: endpoint.webSocketDebuggerUrl,
    logger: backendLogger,
  });
  await cdp.connect();
  cliLogger?.info('CDP connected.');

  const daemon = new Daemon(cdp, { logger: backendLogger });
  await daemon.start();
  cliLogger?.info(
    `Daemon attached: session=${daemon.getSession().sessionId} target=${daemon.getSession().targetId}`,
  );

  const skills = options.noSkills
    ? null
    : new SkillsManager(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {});
  if (skills) {
    await skills.ensureWorkspace();
    cliLogger?.info(`Skills workspace ready at ${skills.layout.root}`);
  }

  let closed = false;
  return {
    endpoint,
    cdp,
    daemon,
    skills,
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        daemon.shutdown();
      } catch (cause) {
        cliLogger?.warn(`daemon shutdown failed: ${(cause as Error).message}`);
      }
      try {
        skills?.close();
      } catch (cause) {
        cliLogger?.warn(`skills close failed: ${(cause as Error).message}`);
      }
      try {
        await cdp.disconnect();
      } catch (cause) {
        cliLogger?.warn(`cdp disconnect failed: ${(cause as Error).message}`);
      }
    },
  };
}
