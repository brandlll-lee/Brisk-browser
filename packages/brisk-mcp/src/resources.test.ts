/**
 * Tests for `resources.ts` — interaction-skill discovery, dynamic
 * domain-skill listing, and failure listing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverInteractionSkills, registerBriskResources } from './resources.js';

interface RequestExtra {
  signal: AbortSignal;
  requestId: string;
  sendNotification: () => void;
  sendRequest: () => Promise<unknown>;
}

function extra(): RequestExtra {
  return {
    signal: new AbortController().signal,
    requestId: '1',
    sendNotification: () => {},
    sendRequest: () => Promise.resolve({}),
  };
}

function getHandlers(server: McpServer) {
  return (
    server as unknown as {
      server: {
        _requestHandlers: Map<
          string,
          (
            req: unknown,
            e: unknown,
          ) => Promise<{
            contents?: unknown[];
            resources?: unknown[];
            resourceTemplates?: unknown[];
          }>
        >;
      };
    }
  ).server._requestHandlers;
}

describe('discoverInteractionSkills', () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('returns [] for a missing directory', async () => {
    const res = await discoverInteractionSkills(
      resolve(tmpdir(), `brisk-nonexistent-${Date.now()}`),
    );
    expect(res).toEqual([]);
  });

  it('lists *.md files alphabetically and ignores README.md', async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'brisk-resources-'));
    writeFileSync(resolve(tmp, 'tabs.md'), '# Tabs');
    writeFileSync(resolve(tmp, 'iframes.md'), '# Iframes');
    writeFileSync(resolve(tmp, 'README.md'), 'index');
    writeFileSync(resolve(tmp, 'notes.txt'), 'skip me');
    const skills = await discoverInteractionSkills(tmp);
    expect(skills.map((s) => s.name)).toEqual(['iframes', 'tabs']);
  });
});

describe('registerBriskResources', () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('registers interaction-skill resources and serves their content', async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'brisk-mcp-res-'));
    writeFileSync(resolve(tmp, 'connection.md'), '# Connection skill body');
    writeFileSync(resolve(tmp, 'iframes.md'), '# Iframes skill body');

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const summary = await registerBriskResources({
      server,
      skills: null,
      interactionSkillsDir: tmp,
    });

    expect(summary.interactionCount).toBe(2);
    expect(summary.hasDomainSkills).toBe(false);

    const handlers = getHandlers(server);
    const listFn = handlers.get(ListResourcesRequestSchema.shape.method.value);
    expect(listFn).toBeDefined();
    const list = await listFn?.({ method: 'resources/list', params: {} }, extra());
    const names = (list?.resources as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['interaction-connection', 'interaction-iframes']);

    const readFn = handlers.get(ReadResourceRequestSchema.shape.method.value);
    expect(readFn).toBeDefined();
    const read = await readFn?.(
      { method: 'resources/read', params: { uri: 'mcp://brisk/interaction/connection' } },
      extra(),
    );
    const contents = read?.contents as Array<{ text: string; mimeType: string }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.text).toContain('Connection skill body');
    expect(contents[0]?.mimeType).toBe('text/markdown');
  });

  it('registers dynamic domain-skill + failure templates when skills manager is provided', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const failureList = [
      {
        id: 'fail-1',
        domain: 'example.com',
        action: 'click signup button',
        expected: 'modal opens',
        observed: 'nothing happens',
        rootCause: undefined as string | undefined,
        workaround: undefined as string | undefined,
        tags: [] as string[],
        timestamp: 1,
        resolvedSkill: undefined as string | undefined,
      },
    ];

    const skills = {
      search: () => [
        {
          domain: 'example.com',
          name: 'login',
          title: 'Login flow',
          tags: ['auth'],
          summary: 'sso redirect',
          uri: 'mcp://brisk/skill/example.com/login',
          updatedAt: 1,
        },
      ],
      read: async (domain: string, name: string) => ({
        domain,
        name,
        title: 'Login flow',
        tags: ['auth'],
        summary: 'sso redirect',
        uri: `mcp://brisk/skill/${domain}/${name}`,
        createdAt: 1,
        updatedAt: 2,
        content: '# Login skill body',
      }),
      listFailures: async () => failureList,
    } as never;

    const summary = await registerBriskResources({
      server,
      skills,
      interactionSkillsDir: undefined,
    });

    expect(summary.hasDomainSkills).toBe(true);
    expect(summary.hasFailures).toBe(true);

    const handlers = getHandlers(server);
    const templatesFn = handlers.get(ListResourceTemplatesRequestSchema.shape.method.value);
    expect(templatesFn).toBeDefined();
    const templates = await templatesFn?.(
      { method: 'resources/templates/list', params: {} },
      extra(),
    );
    const uriTemplates = (templates?.resourceTemplates as { uriTemplate: string }[]).map(
      (t) => t.uriTemplate,
    );
    expect(uriTemplates).toContain('mcp://brisk/skill/{domain}/{name}');
    expect(uriTemplates).toContain('mcp://brisk/failure/{id}');

    const listFn = handlers.get(ListResourcesRequestSchema.shape.method.value);
    expect(listFn).toBeDefined();
    const list = await listFn?.({ method: 'resources/list', params: {} }, extra());
    const resources = list?.resources as { uri: string }[];
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['mcp://brisk/skill/example.com/login', 'mcp://brisk/failure/fail-1']),
    );

    const readFn = handlers.get(ReadResourceRequestSchema.shape.method.value);
    const skillRead = await readFn?.(
      {
        method: 'resources/read',
        params: { uri: 'mcp://brisk/skill/example.com/login' },
      },
      extra(),
    );
    const skillContent = skillRead?.contents as Array<{ text: string }>;
    expect(skillContent[0]?.text).toContain('Login skill body');

    const failureRead = await readFn?.(
      {
        method: 'resources/read',
        params: { uri: 'mcp://brisk/failure/fail-1' },
      },
      extra(),
    );
    const failureContent = failureRead?.contents as Array<{ text: string; mimeType: string }>;
    expect(failureContent[0]?.mimeType).toBe('application/json');
    expect(failureContent[0]?.text).toContain('fail-1');
    expect(failureContent[0]?.text).toContain('example.com');
  });

  it('returns interactionCount=0 when interactionSkillsDir is missing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const summary = await registerBriskResources({
      server,
      skills: null,
      interactionSkillsDir: resolve(tmpdir(), `brisk-truly-nonexistent-${Date.now()}`),
    });
    expect(summary.interactionCount).toBe(0);
  });
});
