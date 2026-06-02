/**
 * SkillsStore — SQLite + FTS5 backed index over the markdown skill corpus.
 *
 * Schema (versioned via PRAGMA user_version):
 *
 *   CREATE TABLE skills (
 *     domain          TEXT NOT NULL,
 *     name            TEXT NOT NULL,
 *     title           TEXT NOT NULL,
 *     tags_json       TEXT NOT NULL DEFAULT '[]',   -- JSON array
 *     summary         TEXT NOT NULL DEFAULT '',
 *     path            TEXT NOT NULL UNIQUE,
 *     based_on_failure TEXT,
 *     created_at      INTEGER NOT NULL,
 *     updated_at      INTEGER NOT NULL,
 *     content_sha     TEXT NOT NULL,
 *     PRIMARY KEY (domain, name)
 *   );
 *
 *   CREATE VIRTUAL TABLE skills_fts USING fts5(
 *     domain UNINDEXED, name UNINDEXED, title, tags, body,
 *     content='', tokenize='porter unicode61'
 *   );
 *
 * The FTS5 table is "external content" mode (content='') — we always
 * write to it through `INSERT INTO skills_fts(...)` from our triggers.
 * That keeps the search index in lock-step with the canonical table.
 *
 * Concurrency: better-sqlite3 is synchronous, single-threaded; we run
 * inside a single Node process (Brisk daemon). WAL mode + `transaction`
 * are still used because they make crash recovery + multi-process
 * read-only access well-behaved (CLI / future REPL).
 *
 * 来源:
 *   - https://github.com/wiselibs/better-sqlite3/blob/master/docs/api.md
 *   - https://www.sqlite.org/fts5.html#external_content_and_contentless_tables
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillRecord, SkillSummary } from '@brisk/types';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

export interface SkillRow {
  readonly domain: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly tagsJson: string;
  readonly path: string;
  readonly basedOnFailure: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentSha: string;
}

export interface UpsertInput {
  readonly domain: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly path: string;
  readonly body: string;
  readonly createdAt?: number;
  readonly basedOnFailure?: string;
}

export interface SearchOptions {
  readonly domain?: string;
  readonly tags?: readonly string[];
  readonly query?: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class SkillsStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ─── Migrations ────────────────────────────────────────────────

  private migrate(): void {
    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (current >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (current < 1) this.applyV1();
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  private applyV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        domain           TEXT NOT NULL,
        name             TEXT NOT NULL,
        title            TEXT NOT NULL,
        tags_json        TEXT NOT NULL DEFAULT '[]',
        summary          TEXT NOT NULL DEFAULT '',
        path             TEXT NOT NULL UNIQUE,
        based_on_failure TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        content_sha      TEXT NOT NULL,
        PRIMARY KEY (domain, name)
      );

      CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);
      CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        domain UNINDEXED,
        name UNINDEXED,
        title,
        tags,
        body,
        content='',
        tokenize='porter unicode61'
      );
    `);
  }

  // ─── CRUD ──────────────────────────────────────────────────────

  upsert(input: UpsertInput): SkillRow {
    const tagsJson = JSON.stringify([...input.tags]);
    const contentSha = sha256(input.body);
    const now = nowSeconds();
    const createdAt = input.createdAt ?? now;

    const existing = this.getRow(input.domain, input.name);

    const upsertStmt = this.db.prepare(`
      INSERT INTO skills (domain, name, title, tags_json, summary, path, based_on_failure, created_at, updated_at, content_sha)
      VALUES (@domain, @name, @title, @tagsJson, @summary, @path, @basedOnFailure, @createdAt, @updatedAt, @contentSha)
      ON CONFLICT(domain, name) DO UPDATE SET
        title=excluded.title,
        tags_json=excluded.tags_json,
        summary=excluded.summary,
        path=excluded.path,
        based_on_failure=excluded.based_on_failure,
        updated_at=excluded.updated_at,
        content_sha=excluded.content_sha
    `);
    const ftsInsertStmt = this.db.prepare(`
      INSERT INTO skills_fts(rowid, domain, name, title, tags, body)
      VALUES (
        (SELECT rowid FROM skills WHERE domain=? AND name=?),
        ?, ?, ?, ?, ?
      )
    `);
    const ftsDelOneStmt = this.db.prepare(`
      INSERT INTO skills_fts(skills_fts, rowid, domain, name, title, tags, body)
      VALUES ('delete', (SELECT rowid FROM skills WHERE domain=? AND name=?), ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      if (existing) {
        ftsDelOneStmt.run(
          existing.domain,
          existing.name,
          existing.domain,
          existing.name,
          existing.title,
          existing.tagsJson,
          '',
        );
      }
      upsertStmt.run({
        domain: input.domain,
        name: input.name,
        title: input.title,
        tagsJson,
        summary: input.summary,
        path: input.path,
        basedOnFailure: input.basedOnFailure ?? null,
        createdAt,
        updatedAt: now,
        contentSha,
      });
      ftsInsertStmt.run(
        input.domain,
        input.name,
        input.domain,
        input.name,
        input.title,
        input.tags.join(' '),
        input.body,
      );
    });
    tx();
    const row = this.getRow(input.domain, input.name);
    if (!row) throw new Error(`upsert lost row: ${input.domain}/${input.name}`);
    return row;
  }

  delete(domain: string, name: string): boolean {
    const existing = this.getRow(domain, name);
    if (!existing) return false;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO skills_fts(skills_fts, rowid, domain, name, title, tags, body)
           VALUES ('delete', (SELECT rowid FROM skills WHERE domain=? AND name=?), ?, ?, ?, ?, ?)`,
        )
        .run(domain, name, domain, name, existing.title, existing.tagsJson, '');
      this.db.prepare('DELETE FROM skills WHERE domain=? AND name=?').run(domain, name);
    });
    tx();
    return true;
  }

  getRow(domain: string, name: string): SkillRow | undefined {
    return this.db
      .prepare(
        `SELECT
           domain, name, title, summary, tags_json AS tagsJson, path,
           based_on_failure AS basedOnFailure, created_at AS createdAt,
           updated_at AS updatedAt, content_sha AS contentSha
         FROM skills WHERE domain=? AND name=?`,
      )
      .get(domain, name) as SkillRow | undefined;
  }

  /**
   * Convert a SkillRow into the public SkillSummary shape (no body).
   */
  static toSummary(row: SkillRow): SkillSummary {
    let tags: string[];
    try {
      const parsed = JSON.parse(row.tagsJson);
      tags = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      tags = [];
    }
    return {
      domain: row.domain,
      name: row.name,
      title: row.title,
      tags,
      summary: row.summary,
      uri: `mcp://brisk/skill/${encodeURIComponent(row.domain)}/${encodeURIComponent(row.name)}`,
      updatedAt: row.updatedAt,
    };
  }

  /** Build a full SkillRecord. The caller provides the body (read from disk). */
  static toRecord(row: SkillRow, body: string): SkillRecord {
    const summary = SkillsStore.toSummary(row);
    return {
      ...summary,
      content: body,
      createdAt: row.createdAt,
      ...(row.basedOnFailure ? { basedOnFailure: row.basedOnFailure } : {}),
    };
  }

  // ─── Search ────────────────────────────────────────────────────

  search(opts: SearchOptions = {}): SkillRow[] {
    const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    let useFts = false;

    if (opts.domain) {
      conditions.push("domain = @domain OR domain LIKE '%.' || @domain");
      params.domain = opts.domain.toLowerCase();
    }

    if (opts.tags && opts.tags.length > 0) {
      // Each tag becomes a JSON-text LIKE match on tags_json.
      // We accept false positives across tags that share substrings — full
      // exact match would require a proper join table. The FTS index also
      // tracks the tag string so a `query` over tags works there too.
      opts.tags.forEach((tag, i) => {
        const key = `tag${i}`;
        conditions.push(`tags_json LIKE @${key}`);
        params[key] = `%"${tag.toLowerCase()}"%`;
      });
    }

    let sql: string;
    if (opts.query?.trim()) {
      useFts = true;
      params.query = sanitizeFtsQuery(opts.query);
      const where = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
      sql = `
        SELECT s.domain, s.name, s.title, s.summary, s.tags_json AS tagsJson, s.path,
               s.based_on_failure AS basedOnFailure, s.created_at AS createdAt,
               s.updated_at AS updatedAt, s.content_sha AS contentSha
        FROM skills_fts f
        JOIN skills s ON f.rowid = s.rowid
        WHERE skills_fts MATCH @query${where}
        ORDER BY bm25(skills_fts), s.updated_at DESC
        LIMIT ${limit}
      `;
    } else {
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      sql = `
        SELECT domain, name, title, summary, tags_json AS tagsJson, path,
               based_on_failure AS basedOnFailure, created_at AS createdAt,
               updated_at AS updatedAt, content_sha AS contentSha
        FROM skills ${where}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }

    void useFts;
    return this.db.prepare(sql).all(params) as SkillRow[];
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * FTS5 reserves `"`, `'`, `:`, `(`, `)`, `*` and a few others.
 * For Brisk's V0.1.0 we accept the agent's raw words and strip the
 * dangerous chars rather than build a full tokenizer. Multi-word
 * queries fall through as AND because FTS5's default is implicit AND.
 */
function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/["'():*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned;
}
