import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkillsStore } from './store.js';

describe('SkillsStore', () => {
  let dir: string;
  let store: SkillsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brisk-skills-'));
    store = new SkillsStore(join(dir, 'skills.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('upserts and reads back a row', () => {
    const row = store.upsert({
      domain: 'github.com',
      name: 'star-button-trap',
      title: 'Star button trap',
      summary: 'short summary',
      tags: ['button', 'github'],
      path: '/tmp/x.md',
      body: 'when starring a repo, the button momentarily disables',
    });
    expect(row.title).toBe('Star button trap');
    const fetched = store.getRow('github.com', 'star-button-trap');
    expect(fetched?.title).toBe('Star button trap');
    expect(SkillsStore.toSummary(fetched!).tags).toEqual(['button', 'github']);
    expect(SkillsStore.toSummary(fetched!).uri).toBe(
      'mcp://brisk/skill/github.com/star-button-trap',
    );
  });

  it('upserts twice → 1 row, updated_at advances', () => {
    store.upsert({
      domain: 'd.com',
      name: 's',
      title: 'v1',
      summary: '',
      tags: [],
      path: '/x',
      body: 'a',
    });
    const v2 = store.upsert({
      domain: 'd.com',
      name: 's',
      title: 'v2',
      summary: '',
      tags: [],
      path: '/x',
      body: 'b',
    });
    expect(v2.title).toBe('v2');
    expect(store.search()).toHaveLength(1);
  });

  it('searches by domain prefix', () => {
    store.upsert({
      domain: 'foo.com',
      name: 'a',
      title: 'A',
      summary: '',
      tags: [],
      path: '/a',
      body: 'aaa',
    });
    store.upsert({
      domain: 'bar.com',
      name: 'b',
      title: 'B',
      summary: '',
      tags: [],
      path: '/b',
      body: 'bbb',
    });
    const result = store.search({ domain: 'foo.com' });
    expect(result.map((r) => r.name)).toEqual(['a']);
  });

  it('FTS5 full-text search finds words inside body', () => {
    store.upsert({
      domain: 'g.com',
      name: 'select',
      title: 'Select element',
      summary: '',
      tags: [],
      path: '/p',
      body: 'The drop-down requires fireChange after value=',
    });
    const hits = store.search({ query: 'fireChange' });
    expect(hits.map((r) => r.name)).toEqual(['select']);
  });

  it('search with tags filters to that tag', () => {
    store.upsert({
      domain: 'g.com',
      name: 'a',
      title: 'A',
      summary: '',
      tags: ['x', 'y'],
      path: '/a',
      body: '',
    });
    store.upsert({
      domain: 'g.com',
      name: 'b',
      title: 'B',
      summary: '',
      tags: ['y'],
      path: '/b',
      body: '',
    });
    const hits = store.search({ tags: ['x'] });
    expect(hits.map((r) => r.name)).toEqual(['a']);
  });

  it('delete removes from FTS too', () => {
    store.upsert({
      domain: 'g.com',
      name: 'gone',
      title: 'T',
      summary: '',
      tags: [],
      path: '/g',
      body: 'magic word',
    });
    expect(store.delete('g.com', 'gone')).toBe(true);
    expect(store.search({ query: 'magic' })).toHaveLength(0);
  });

  it('survives sanitizing FTS-reserved characters', () => {
    store.upsert({
      domain: 'g.com',
      name: 'q',
      title: 'Q',
      summary: '',
      tags: [],
      path: '/q',
      body: 'lorem ipsum',
    });
    const hits = store.search({ query: 'lorem"(ipsum' });
    expect(hits).toHaveLength(1);
  });
});
