/**
 * SkillsManager — public-facing facade orchestrating writer + store +
 * failure log. Tools in `brisk-mcp/tools/skills.ts` consume this
 * (not the lower-level building blocks).
 *
 * The manager keeps the SQLite index synced from disk on demand
 * (`reindex()`) and after every write. This way:
 *   • hand-edits land via `reindex()` (CLI command)
 *   • agent writes go through `write()` which performs the upsert
 *     atomically
 */

import type { FailureRecord, SkillRecord, SkillSummary } from '@brisk/types';

import { FailureLog, type RecordInput } from './failures.js';
import { resolveWorkspace, type WorkspaceLayout } from './paths.js';
import { type SearchOptions, type SkillRow, SkillsStore } from './store.js';
import { SkillsWriter, type WriteSkillInput } from './writer.js';

export interface ManagerOptions {
  /** Override workspace root. Defaults to `BRISK_AGENT_WORKSPACE` or `<cwd>/agent-workspace`. */
  readonly workspaceRoot?: string;
}

export class SkillsManager {
  readonly layout: WorkspaceLayout;
  readonly store: SkillsStore;
  readonly writer: SkillsWriter;
  readonly failures: FailureLog;

  constructor(options: ManagerOptions = {}) {
    this.layout = options.workspaceRoot
      ? resolveWorkspaceFromRoot(options.workspaceRoot)
      : resolveWorkspace();
    this.store = new SkillsStore(this.layout.dbPath);
    this.writer = new SkillsWriter(this.layout);
    this.failures = new FailureLog(this.layout);
  }

  close(): void {
    this.store.close();
  }

  async ensureWorkspace(): Promise<void> {
    await this.writer.ensureDirs();
  }

  // ─── Read paths ───────────────────────────────────────────────

  search(opts: SearchOptions = {}): SkillSummary[] {
    return this.store.search(opts).map(SkillsStore.toSummary);
  }

  async read(domain: string, name: string): Promise<SkillRecord | null> {
    const row = this.store.getRow(domain, name);
    const disk = await this.writer.read(domain, name);
    if (!row && !disk) return null;
    if (row && disk) return SkillsStore.toRecord(row, disk.body);
    if (disk) {
      // disk-only: synthesise a transient summary so the agent still
      // sees content even if reindex hasn't run.
      return {
        domain,
        name,
        title: disk.frontMatter.title ?? name,
        tags: disk.frontMatter.tags ?? [],
        summary: '',
        uri: `mcp://brisk/skill/${encodeURIComponent(domain)}/${encodeURIComponent(name)}`,
        createdAt: disk.frontMatter.createdAt ?? 0,
        updatedAt: 0,
        content: disk.body,
        ...(disk.frontMatter.basedOnFailure
          ? { basedOnFailure: disk.frontMatter.basedOnFailure }
          : {}),
      };
    }
    // row-only is a defect: index has a record but the file is gone.
    // We get here only when row is truthy (covered by the !row && !disk
    // check above), so the non-null assertions are safe.
    if (!row) return null;
    return {
      ...SkillsStore.toSummary(row),
      content: '[file missing on disk — run brisk skills reindex]',
      createdAt: row.createdAt,
    };
  }

  // ─── Write paths ──────────────────────────────────────────────

  async write(input: WriteSkillInput): Promise<{
    summary: SkillSummary;
    record: SkillRecord;
    created: boolean;
  }> {
    await this.ensureWorkspace();
    const fileResult = await this.writer.write(input);
    const row = this.store.upsert({
      domain: fileResult.domain,
      name: fileResult.name,
      title: fileResult.frontMatter.title ?? input.title,
      summary: fileResult.summary,
      tags: fileResult.frontMatter.tags ?? input.tags,
      path: fileResult.path,
      body: fileResult.body,
      ...(fileResult.frontMatter.createdAt !== undefined
        ? { createdAt: fileResult.frontMatter.createdAt }
        : {}),
      ...(input.basedOnFailure ? { basedOnFailure: input.basedOnFailure } : {}),
    });
    const summary = SkillsStore.toSummary(row);
    const record = SkillsStore.toRecord(row, fileResult.body);
    return { summary, record, created: fileResult.created };
  }

  async delete(domain: string, name: string): Promise<boolean> {
    const onDisk = await this.writer.delete(domain, name);
    const inDb = this.store.delete(domain, name);
    return onDisk || inDb;
  }

  // ─── Failures ─────────────────────────────────────────────────

  async recordFailure(input: RecordInput): Promise<FailureRecord> {
    await this.ensureWorkspace();
    return this.failures.record(input);
  }

  async listFailures(limit?: number): Promise<FailureRecord[]> {
    return this.failures.list(limit);
  }

  async resolveFailureWithSkill(failureId: string, skillName: string): Promise<boolean> {
    return this.failures.linkResolvedSkill(failureId, skillName);
  }

  // ─── Reindex ──────────────────────────────────────────────────

  /** Walk the disk corpus and rebuild the SQLite index. */
  async reindex(): Promise<{ scanned: number; upserted: number }> {
    await this.ensureWorkspace();
    let scanned = 0;
    let upserted = 0;
    const rowsByKey = new Set<string>();
    for (const row of this.allRows()) rowsByKey.add(`${row.domain}/${row.name}`);

    for await (const entry of this.writer.scan()) {
      scanned++;
      this.store.upsert({
        domain: entry.domain,
        name: entry.name,
        title: entry.frontMatter.title ?? entry.name,
        summary: entry.body.slice(0, 200),
        tags: entry.frontMatter.tags ?? [],
        path: entry.path,
        body: entry.body,
        ...(entry.frontMatter.createdAt ? { createdAt: entry.frontMatter.createdAt } : {}),
        ...(entry.frontMatter.basedOnFailure
          ? { basedOnFailure: entry.frontMatter.basedOnFailure }
          : {}),
      });
      upserted++;
      rowsByKey.delete(`${entry.domain}/${entry.name}`);
    }
    // Anything left in `rowsByKey` is in the DB but missing on disk —
    // delete from index to keep them in sync.
    for (const key of rowsByKey) {
      const [domain, name] = key.split('/');
      if (domain && name) this.store.delete(domain, name);
    }
    return { scanned, upserted };
  }

  /** Iterate every indexed row. */
  private *allRows(): Generator<SkillRow> {
    for (const row of this.store.search({ limit: 10_000 })) yield row;
  }
}

function resolveWorkspaceFromRoot(root: string): WorkspaceLayout {
  process.env.BRISK_AGENT_WORKSPACE = root;
  return resolveWorkspace();
}
