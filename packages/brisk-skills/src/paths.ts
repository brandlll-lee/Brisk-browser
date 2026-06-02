/**
 * Filesystem layout for the agent workspace.
 *
 * agent-workspace/
 *   domain-skills/<domain>/<name>.md
 *   failures/<YYYY-MM-DD>.jsonl
 *   skills.db
 *   agent_helpers.ts
 *
 * Override the root via the `BRISK_AGENT_WORKSPACE` env var; defaults
 * to `<cwd>/agent-workspace`. Matches `BH_AGENT_WORKSPACE` in
 * browser-harness's `helpers.py:107`.
 */

import { resolve } from 'node:path';

const ROOT_ENV = 'BRISK_AGENT_WORKSPACE';
const DEFAULT_NAME = 'agent-workspace';

export interface WorkspaceLayout {
  readonly root: string;
  readonly domainSkillsRoot: string;
  readonly failuresRoot: string;
  readonly dbPath: string;
  readonly agentHelpersPath: string;
}

/** Resolve the workspace layout. */
export function resolveWorkspace(cwd: string = process.cwd()): WorkspaceLayout {
  const root = process.env[ROOT_ENV] ? resolve(process.env[ROOT_ENV]) : resolve(cwd, DEFAULT_NAME);
  return {
    root,
    domainSkillsRoot: resolve(root, 'domain-skills'),
    failuresRoot: resolve(root, 'failures'),
    dbPath: resolve(root, 'skills.db'),
    agentHelpersPath: resolve(root, 'agent_helpers.ts'),
  };
}

/** Compute the canonical file path for a (domain, name) skill. */
export function skillFilePath(layout: WorkspaceLayout, domain: string, name: string): string {
  return resolve(layout.domainSkillsRoot, domain, `${name}.md`);
}

/** Compute the today-bucket JSONL path for a failure log. */
export function failureLogPath(layout: WorkspaceLayout, dateIso: string): string {
  return resolve(layout.failuresRoot, `${dateIso}.jsonl`);
}

/** Compute the canonical `mcp://brisk/skill/<domain>/<name>` URI. */
export function skillUri(domain: string, name: string): string {
  return `mcp://brisk/skill/${encodeURIComponent(domain)}/${encodeURIComponent(name)}`;
}

/** Parse a Brisk skill URI back into `(domain, name)`. */
export function parseSkillUri(uri: string): { domain: string; name: string } | null {
  const match = /^mcp:\/\/brisk\/skill\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match?.[1] || !match[2]) return null;
  return { domain: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
}

/** Canonicalize a hostname (lowercase, no trailing dot). Returns null if invalid. */
export function canonicalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) return null;
  if (/[^a-z0-9.-]/.test(trimmed)) return null;
  return trimmed;
}

/** Slugify a name for use as a filename. */
export function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
