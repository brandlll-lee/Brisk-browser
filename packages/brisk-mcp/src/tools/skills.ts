/**
 * Skills tool wrappers — 5 tools (Brisk-original).
 *
 * Skill tools require `ctx.skills` to be non-null; otherwise they
 * return `SKILL_DB_ERROR` so the agent can record a failure and
 * surface a clear actionable message to the user.
 */

import { briskError, err, ok } from '@brisk/types';
import { z } from 'zod';

import { type BriskToolContext, defineTool } from '../framework.js';

function requireSkills(ctx: BriskToolContext) {
  if (!ctx.skills) {
    return err(
      briskError('SKILL_DB_ERROR', 'Skills are disabled in this Brisk instance', {
        details: { hint: 'Re-run `brisk serve` without `--no-skills`' },
      }),
    );
  }
  return ok(ctx.skills);
}

const SKILL_URI = z.string().regex(/^mcp:\/\/brisk\/skill\/[^/]+\/[^/]+$/);

export const listSkillsTool = defineTool({
  name: 'list_skills',
  category: 'skills',
  title: 'List Skills',
  description:
    'Search Brisk skills by domain, tags, or full-text query. Returns summaries (not full content). ' +
    'Use this BEFORE attempting a task on a new site — the corpus often has trapdoor notes.',
  inputSchema: {
    domain: z.string().optional().describe('Hostname like "github.com"; matches subdomain prefix'),
    tags: z.array(z.string()).optional(),
    query: z.string().optional().describe('FTS5 query across title/tags/body'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  outputSchema: {
    skills: z.array(
      z.object({
        domain: z.string(),
        name: z.string(),
        title: z.string(),
        tags: z.array(z.string()),
        summary: z.string(),
        uri: z.string(),
        updatedAt: z.number(),
      }),
    ),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    const guard = requireSkills(ctx);
    if (!guard.ok) return guard;
    const skills = guard.value.search({
      ...(args.domain !== undefined ? { domain: args.domain as string } : {}),
      ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
      ...(args.query !== undefined ? { query: args.query as string } : {}),
      ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
    });
    return ok({ skills });
  },
});

export const readSkillTool = defineTool({
  name: 'read_skill',
  category: 'skills',
  title: 'Read Skill',
  description:
    'Read the full markdown content of a Brisk skill. Use either (domain + name) OR the canonical URI.',
  inputSchema: {
    uri: SKILL_URI.optional(),
    domain: z.string().optional(),
    name: z.string().optional(),
  },
  outputSchema: {
    domain: z.string(),
    name: z.string(),
    title: z.string(),
    tags: z.array(z.string()),
    content: z.string(),
    summary: z.string(),
    uri: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, ctx) => {
    const guard = requireSkills(ctx);
    if (!guard.ok) return guard;
    let domain: string | undefined;
    let name: string | undefined;
    if (typeof args.uri === 'string') {
      const match = /^mcp:\/\/brisk\/skill\/([^/]+)\/([^/]+)$/.exec(args.uri);
      if (!match?.[1] || !match[2]) {
        return err(briskError('HELPER_INVALID_ARGS', `read_skill: invalid uri "${args.uri}"`));
      }
      domain = decodeURIComponent(match[1]);
      name = decodeURIComponent(match[2]);
    } else {
      domain = args.domain as string | undefined;
      name = args.name as string | undefined;
    }
    if (!domain || !name) {
      return err(briskError('HELPER_INVALID_ARGS', 'read_skill: domain + name (or uri) required'));
    }
    const record = await guard.value.read(domain, name);
    if (!record) {
      return err(briskError('SKILL_NOT_FOUND', `No skill at ${domain}/${name}`));
    }
    return ok(record);
  },
});

export const writeSkillTool = defineTool({
  name: 'write_skill',
  category: 'skills',
  title: 'Write Skill',
  description:
    'Write or update a skill for a domain. Use this when you learn something non-obvious about a ' +
    'site (a selector, a flow, a trap) that will help future tasks. The skill is committed to ' +
    '`agent-workspace/domain-skills/<domain>/<name>.md` and indexed for full-text search.',
  inputSchema: {
    domain: z.string().min(1).describe('Hostname like "github.com"'),
    name: z.string().min(1).describe('Slug for the skill file (no spaces)'),
    title: z.string().min(1),
    tags: z.array(z.string()).default([]),
    content: z
      .string()
      .min(1)
      .describe('Markdown body — describe the trap, the workaround, code snippets'),
    basedOnFailure: z.string().optional(),
  },
  outputSchema: {
    domain: z.string(),
    name: z.string(),
    uri: z.string(),
    path: z.string(),
    created: z.boolean(),
    summary: z.object({
      domain: z.string(),
      name: z.string(),
      title: z.string(),
      tags: z.array(z.string()),
      summary: z.string(),
      uri: z.string(),
      updatedAt: z.number(),
    }),
  },
  annotations: { destructiveHint: false },
  handler: async (args, ctx) => {
    const guard = requireSkills(ctx);
    if (!guard.ok) return guard;
    try {
      const { summary, record, created } = await guard.value.write({
        domain: args.domain as string,
        name: args.name as string,
        title: args.title as string,
        tags: (args.tags as string[]) ?? [],
        content: args.content as string,
        ...(args.basedOnFailure ? { basedOnFailure: args.basedOnFailure as string } : {}),
      });
      const path = guard.value.writer.resolvePath(summary.domain, summary.name);
      return ok({
        domain: record.domain,
        name: record.name,
        uri: record.uri,
        path,
        created,
        summary,
      });
    } catch (cause) {
      return err(
        briskError('SKILL_INVALID', `write_skill failed: ${(cause as Error).message}`, {
          cause: cause as Error,
        }),
      );
    }
  },
});

export const recordFailureTool = defineTool({
  name: 'record_failure',
  category: 'skills',
  title: 'Record Failure',
  description:
    'Append a failure record to `agent-workspace/failures/<date>.jsonl`. Always call this BEFORE ' +
    'writing a new skill — structurally pairs the trap with the workaround. Returns the failure ' +
    'id; pass it to `write_skill` as `basedOnFailure`.',
  inputSchema: {
    domain: z.string().min(1),
    action: z.string().min(1).describe('What you tried, e.g. "click button[name=star]"'),
    expected: z.string().min(1),
    observed: z.string().min(1),
    rootCause: z.string().optional(),
    workaround: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  outputSchema: {
    id: z.string(),
    suggestion: z.string(),
    relatedSkills: z.array(
      z.object({ domain: z.string(), name: z.string(), title: z.string(), uri: z.string() }),
    ),
  },
  annotations: { destructiveHint: false },
  handler: async (args, ctx) => {
    const guard = requireSkills(ctx);
    if (!guard.ok) return guard;
    const record = await guard.value.recordFailure({
      domain: args.domain as string,
      action: args.action as string,
      expected: args.expected as string,
      observed: args.observed as string,
      ...(args.rootCause ? { rootCause: args.rootCause as string } : {}),
      ...(args.workaround ? { workaround: args.workaround as string } : {}),
      ...(args.tags ? { tags: args.tags as string[] } : {}),
    });
    const related = guard.value
      .search({ domain: record.domain, limit: 3 })
      .map((s) => ({ domain: s.domain, name: s.name, title: s.title, uri: s.uri }));
    const suggestion =
      `Consider write_skill({domain:"${record.domain}", name:"<slug>", title:"<short title>", ` +
      `tags:${JSON.stringify(record.tags)}, content:"<markdown body>", basedOnFailure:"${record.id}"})`;
    return ok({ id: record.id, suggestion, relatedSkills: related });
  },
});

export const attachHelperTool = defineTool({
  name: 'attach_helper',
  category: 'skills',
  title: 'Attach Helper (preview)',
  description:
    'PREVIEW (V0.1.0): records an intent to register a TypeScript helper hot-loaded from ' +
    'agent-workspace/agent_helpers.ts. The actual hot-reload lands in V0.1.1 — for now the tool ' +
    'just returns the workspace path so the agent can stage code there for human review.',
  inputSchema: {
    name: z.string().min(1),
    source: z.string().min(1),
  },
  outputSchema: {
    note: z.string(),
    path: z.string(),
  },
  annotations: { destructiveHint: false },
  handler: async (_args, ctx) => {
    const guard = requireSkills(ctx);
    if (!guard.ok) return guard;
    return ok({
      note: 'attach_helper preview: edit agent_helpers.ts and restart the daemon to load (hot-reload coming in V0.1.1)',
      path: guard.value.layout.agentHelpersPath,
    });
  },
});

export const skillsTools = [
  listSkillsTool,
  readSkillTool,
  writeSkillTool,
  recordFailureTool,
  attachHelperTool,
];
