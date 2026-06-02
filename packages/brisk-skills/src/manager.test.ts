import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkillsManager } from './manager.js';

describe('SkillsManager', () => {
  let dir: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brisk-skills-mgr-'));
    manager = new SkillsManager({ workspaceRoot: dir });
    await manager.ensureWorkspace();
  });

  afterEach(async () => {
    manager.close();
    delete process.env.BRISK_AGENT_WORKSPACE;
    await rm(dir, { recursive: true, force: true });
  });

  it('write -> read -> search round trip', async () => {
    const w = await manager.write({
      domain: 'github.com',
      name: 'Star Button Trap',
      title: 'Star button trap',
      tags: ['button', 'github'],
      content:
        '# Star button trap\n\n' +
        'When starring a repo the button briefly disables during the optimistic update.\n',
    });
    expect(w.created).toBe(true);
    expect(w.summary.uri).toBe('mcp://brisk/skill/github.com/star-button-trap');

    const r = await manager.read('github.com', 'star-button-trap');
    expect(r?.title).toBe('Star button trap');
    expect(r?.tags).toEqual(['button', 'github']);
    expect(r?.content).toContain('# Star button trap');

    const hits = manager.search({ query: 'optimistic update' });
    expect(hits[0]?.name).toBe('star-button-trap');
  });

  it('write creates a real markdown file with front matter', async () => {
    const w = await manager.write({
      domain: 'example.com',
      name: 'my skill',
      title: 'Hello',
      tags: ['a'],
      content: 'body line',
    });
    const onDisk = await readFile(
      w.summary.uri.startsWith('mcp://')
        ? join(dir, 'domain-skills', 'example.com', 'my-skill.md')
        : '',
      'utf8',
    );
    expect(onDisk).toContain('title: Hello');
    expect(onDisk).toContain('tags: [a]');
    expect(onDisk).toContain('body line');
  });

  it('rejects invalid domain', async () => {
    await expect(
      manager.write({ domain: 'in valid', name: 'x', title: 'T', tags: [], content: 'b' }),
    ).rejects.toThrow(/Invalid domain/);
  });

  it('records and lists failures', async () => {
    const f1 = await manager.recordFailure({
      domain: 'a.com',
      action: 'click',
      expected: 'modal opens',
      observed: 'nothing',
    });
    const f2 = await manager.recordFailure({
      domain: 'a.com',
      action: 'click2',
      expected: 'x',
      observed: 'y',
    });
    expect(f1.id).toMatch(/^f_\d{4}-\d{2}-\d{2}_001$/);
    expect(f2.id).toMatch(/^f_\d{4}-\d{2}-\d{2}_002$/);
    const list = await manager.listFailures();
    expect(list).toHaveLength(2);
  });

  it('reindex picks up hand-edited files', async () => {
    // Create a file directly (simulate user PR).
    const fs = await import('node:fs/promises');
    const dirPath = join(dir, 'domain-skills', 'manual.com');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(
      join(dirPath, 'hand.md'),
      '---\ntitle: Hand-written\ntags: [manual]\n---\nbody body\n',
      'utf8',
    );

    const result = await manager.reindex();
    expect(result.scanned).toBe(1);
    expect(result.upserted).toBe(1);
    const found = manager.search({ domain: 'manual.com' });
    expect(found[0]?.title).toBe('Hand-written');
  });

  it('delete removes from disk and index', async () => {
    await manager.write({
      domain: 'g.com',
      name: 'doomed',
      title: 'T',
      tags: [],
      content: 'x',
    });
    expect(await manager.delete('g.com', 'doomed')).toBe(true);
    expect(manager.search({ domain: 'g.com' })).toHaveLength(0);
  });
});
