/**
 * MCP resources for Brisk.
 *
 * Three resource families:
 *   1. `mcp://brisk/interaction/<name>`  — bundled markdown shipped with Brisk
 *      (interaction-skills/<name>.md). Static; discovered at server boot.
 *   2. `mcp://brisk/skill/<domain>/<name>` — agent-written domain skills
 *      from `agent-workspace/domain-skills/`. Dynamic via ResourceTemplate
 *      so new skills surface without server restart.
 *   3. `mcp://brisk/failure/<id>` — failure ledger entries (latest 200).
 *      Read-only; the agent uses them to revisit past traps when planning
 *      a new task.
 *
 * Resource API spec: ResourceTemplate + registerResource(name, template, metadata, handler).
 * See @modelcontextprotocol/sdk/server/mcp.js v1.29.x.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve as resolvePath } from 'node:path';
import type { SkillsManager } from '@brisk/skills';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const INTERACTION_PREFIX = 'mcp://brisk/interaction/';

export interface ResourceLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface RegisterResourcesOptions {
  readonly server: McpServer;
  readonly skills: SkillsManager | null;
  /**
   * Directory containing `<name>.md` files exposed at
   * `mcp://brisk/interaction/<name>`. Optional — if it doesn't exist
   * Brisk still boots and just skips static resources.
   */
  readonly interactionSkillsDir?: string;
  readonly logger?: ResourceLogger;
}

interface InteractionSkill {
  readonly name: string;
  readonly path: string;
}

/**
 * Discover `<name>.md` files in `dir` (non-recursive). Returns an empty
 * array if `dir` doesn't exist.
 */
export async function discoverInteractionSkills(dir: string): Promise<InteractionSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: InteractionSkill[] = [];
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.md') continue;
    if (entry.toLowerCase() === 'readme.md') continue;
    const full = resolvePath(dir, entry);
    let info: import('node:fs').Stats;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    skills.push({ name: entry.replace(/\.md$/i, ''), path: full });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Register the three Brisk resource families on `server`.
 *
 * Static interaction skills are registered eagerly so they appear in
 * `resources/list`. Dynamic families use `ResourceTemplate` with a
 * `list` callback that queries `SkillsManager` on every call.
 */
export async function registerBriskResources(opts: RegisterResourcesOptions): Promise<{
  interactionCount: number;
  hasDomainSkills: boolean;
  hasFailures: boolean;
}> {
  const { server, skills, interactionSkillsDir, logger } = opts;

  // ─── Family 1: interaction-skills (static) ─────────────────────
  let interactionCount = 0;
  if (interactionSkillsDir) {
    const found = await discoverInteractionSkills(interactionSkillsDir);
    for (const skill of found) {
      const uri = `${INTERACTION_PREFIX}${skill.name}`;
      const resourceName = `interaction-${skill.name}`;
      server.registerResource(
        resourceName,
        uri,
        {
          title: `Interaction skill: ${skill.name}`,
          description: `General-purpose ${skill.name} pattern for the browser harness`,
          mimeType: 'text/markdown',
        },
        async (resourceUri) => {
          const text = await readFile(skill.path, 'utf8');
          return {
            contents: [
              {
                uri: resourceUri.href,
                mimeType: 'text/markdown',
                text,
              },
            ],
          };
        },
      );
      interactionCount++;
    }
    logger?.info(
      `[resources] registered ${interactionCount} interaction-skills from ${interactionSkillsDir}`,
    );
  }

  if (!skills) {
    return { interactionCount, hasDomainSkills: false, hasFailures: false };
  }

  // ─── Family 2: domain skills (dynamic) ─────────────────────────
  server.registerResource(
    'domain-skill',
    new ResourceTemplate('mcp://brisk/skill/{domain}/{name}', {
      list: async () => {
        const summaries = skills.search({ limit: 1000 });
        return {
          resources: summaries.map((s) => ({
            uri: s.uri,
            name: `${s.domain}/${s.name}`,
            title: s.title,
            description: s.summary || s.title,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    {
      title: 'Domain skill',
      description: 'Agent-written, site-specific knowledge (`agent-workspace/domain-skills/`)',
      mimeType: 'text/markdown',
    },
    async (resourceUri, vars) => {
      const domain = decodeURIComponent(String(vars.domain ?? ''));
      const name = decodeURIComponent(String(vars.name ?? ''));
      if (!domain || !name) {
        throw new Error(`Invalid skill URI: ${resourceUri.href}`);
      }
      const record = await skills.read(domain, name);
      if (!record) {
        throw new Error(`No skill at ${domain}/${name}`);
      }
      return {
        contents: [
          {
            uri: resourceUri.href,
            mimeType: 'text/markdown',
            text: record.content,
          },
        ],
      };
    },
  );

  // ─── Family 3: failures (dynamic) ──────────────────────────────
  server.registerResource(
    'failure',
    new ResourceTemplate('mcp://brisk/failure/{id}', {
      list: async () => {
        const failures = await skills.listFailures(200);
        return {
          resources: failures.map((f) => ({
            uri: `mcp://brisk/failure/${f.id}`,
            name: f.id,
            title: `${f.domain} — ${f.action.slice(0, 60)}`,
            description: f.observed.slice(0, 200),
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Failure record',
      description: 'Append-only ledger of agent-reported failures (latest 200)',
      mimeType: 'application/json',
    },
    async (resourceUri, vars) => {
      const id = String(vars.id ?? '');
      if (!id) throw new Error('failure id required');
      const failures = await skills.listFailures(2000);
      const record = failures.find((f) => f.id === id);
      if (!record) {
        throw new Error(`No failure record ${id}`);
      }
      return {
        contents: [
          {
            uri: resourceUri.href,
            mimeType: 'application/json',
            text: JSON.stringify(record, null, 2),
          },
        ],
      };
    },
  );

  logger?.info('[resources] registered domain-skill + failure resource templates');

  return { interactionCount, hasDomainSkills: true, hasFailures: true };
}
