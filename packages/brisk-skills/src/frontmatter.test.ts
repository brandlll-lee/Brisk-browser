import { describe, expect, it } from 'vitest';

import { parseSkillDocument, type SkillDocument, stringifySkillDocument } from './frontmatter.js';

describe('parseSkillDocument', () => {
  it('parses a complete document', () => {
    const raw = [
      '---',
      'title: "Star button trap"',
      'tags: [github, button]',
      'created_at: 1700000000',
      'based_on_failure: f_2026-06-02_001',
      '---',
      '',
      '# Body',
      'Hello',
      '',
    ].join('\n');
    const doc = parseSkillDocument(raw);
    expect(doc.frontMatter.title).toBe('Star button trap');
    expect(doc.frontMatter.tags).toEqual(['github', 'button']);
    expect(doc.frontMatter.createdAt).toBe(1700000000);
    expect(doc.frontMatter.basedOnFailure).toBe('f_2026-06-02_001');
    expect(doc.body.trim().startsWith('# Body')).toBe(true);
  });

  it('returns body verbatim when no front matter', () => {
    const raw = '# just a heading\n\nstuff';
    const doc = parseSkillDocument(raw);
    expect(doc.frontMatter).toEqual({});
    expect(doc.body).toBe(raw);
  });

  it('round-trips through stringify', () => {
    const doc: SkillDocument = {
      frontMatter: { title: 'Hi', tags: ['a', 'b'], createdAt: 1 },
      body: 'Body\n',
    };
    const round = parseSkillDocument(stringifySkillDocument(doc));
    expect(round.frontMatter.title).toBe('Hi');
    expect(round.frontMatter.tags).toEqual(['a', 'b']);
    expect(round.frontMatter.createdAt).toBe(1);
    expect(round.body.trim()).toBe('Body');
  });

  it('captures unknown keys in extras', () => {
    const raw = '---\nauthor: alice\ncategory: scraping\n---\nbody';
    const doc = parseSkillDocument(raw);
    expect(doc.frontMatter.extras?.author).toBe('alice');
    expect(doc.frontMatter.extras?.category).toBe('scraping');
  });

  it('tolerates spaces inside tag arrays', () => {
    const doc = parseSkillDocument('---\ntags: [ a , b ,c]\n---\nx');
    expect(doc.frontMatter.tags).toEqual(['a', 'b', 'c']);
  });
});
