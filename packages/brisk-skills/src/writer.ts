/**
 * SkillsWriter — read/write/list the markdown corpus on disk.
 *
 * Disk is the source of truth (so users can hand-edit / git commit /
 * PR new skills). The SQLite index in `SkillsStore` is a derived view
 * that the writer keeps in sync. The split mirrors browser-harness's
 * `agent-workspace/domain-skills/` directory layout while adding
 * FTS-backed search.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { type FrontMatter, parseSkillDocument, stringifySkillDocument } from './frontmatter.js';
import { canonicalizeDomain, skillFilePath, slugifyName, type WorkspaceLayout } from './paths.js';

export interface WriteSkillInput {
  readonly domain: string;
  readonly name: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly content: string;
  readonly basedOnFailure?: string;
}

export interface WriteSkillResult {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly created: boolean;
  readonly summary: string;
  readonly body: string;
  readonly frontMatter: FrontMatter;
}

export interface ReadSkillResult {
  readonly path: string;
  readonly body: string;
  readonly frontMatter: FrontMatter;
}

export interface DiskSkillEntry {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  readonly body: string;
  readonly frontMatter: FrontMatter;
}

export class SkillsWriter {
  constructor(private readonly layout: WorkspaceLayout) {}

  /** Compute the canonical on-disk path. */
  resolvePath(domain: string, name: string): string {
    return skillFilePath(this.layout, domain, name);
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.layout.domainSkillsRoot, { recursive: true });
    await mkdir(this.layout.failuresRoot, { recursive: true });
  }

  async write(input: WriteSkillInput): Promise<WriteSkillResult> {
    const domain = canonicalizeDomain(input.domain);
    if (!domain) throw new Error(`Invalid domain: ${input.domain}`);
    const name = slugifyName(input.name);
    if (!name) throw new Error(`Invalid name: ${input.name}`);

    const path = this.resolvePath(domain, name);
    await mkdir(dirname(path), { recursive: true });

    const existed = await fileExists(path);
    const previous = existed ? parseSkillDocument(await readFile(path, 'utf8')) : null;
    const createdAt = previous?.frontMatter.createdAt ?? Math.floor(Date.now() / 1000);
    const fm: FrontMatter = {
      title: input.title,
      tags: input.tags,
      createdAt,
      ...(input.basedOnFailure ? { basedOnFailure: input.basedOnFailure } : {}),
    };
    const body = ensureTrailingNewline(input.content);
    const out = stringifySkillDocument({ frontMatter: fm, body });
    await writeFile(path, out, 'utf8');

    const summary = deriveSummary(body);
    return {
      domain,
      name,
      path,
      created: !existed,
      summary,
      body,
      frontMatter: fm,
    };
  }

  async read(domain: string, name: string): Promise<ReadSkillResult | null> {
    const path = this.resolvePath(domain, name);
    if (!(await fileExists(path))) return null;
    const raw = await readFile(path, 'utf8');
    const doc = parseSkillDocument(raw);
    return { path, body: doc.body, frontMatter: doc.frontMatter };
  }

  async delete(domain: string, name: string): Promise<boolean> {
    const path = this.resolvePath(domain, name);
    if (!(await fileExists(path))) return false;
    await rm(path);
    return true;
  }

  /** Walk the disk corpus. Streaming-friendly: yields one record at a time. */
  async *scan(): AsyncGenerator<DiskSkillEntry> {
    const root = this.layout.domainSkillsRoot;
    if (!(await fileExists(root))) return;
    for (const domain of await safeReaddir(root)) {
      const domainDir = join(root, domain);
      const isDir = (await stat(domainDir).catch(() => null))?.isDirectory();
      if (!isDir) continue;
      for (const file of await safeReaddir(domainDir)) {
        if (extname(file).toLowerCase() !== '.md') continue;
        const path = join(domainDir, file);
        const body = await readFile(path, 'utf8').catch(() => null);
        if (body === null) continue;
        const doc = parseSkillDocument(body);
        yield {
          domain,
          name: file.replace(/\.md$/, ''),
          path,
          body: doc.body,
          frontMatter: doc.frontMatter,
        };
      }
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * Pluck the first ~150 chars of meaningful body text (skipping the front
 * matter and the first H1 if present) to use as the skill's summary.
 */
function deriveSummary(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const without = lines.filter((s) => !s.startsWith('#'));
  const seed = without.join(' ');
  if (!seed) return '';
  return seed.length > 200 ? `${seed.slice(0, 197)}...` : seed;
}
