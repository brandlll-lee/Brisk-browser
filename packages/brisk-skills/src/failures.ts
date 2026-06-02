/**
 * FailureLog — append-only JSONL ledger of agent-reported failures.
 *
 * Files live under `agent-workspace/failures/<YYYY-MM-DD>.jsonl`, one
 * JSON record per line. This is intentionally append-only and
 * human-readable: a failure log is forensic evidence, not a database.
 *
 * Schema (one line):
 *
 *   { "id": "f_2026-06-02_001", "domain": "github.com", ... }
 *
 * The id is `<date>_<sequence>` so it sorts chronologically.
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { FailureRecord } from '@brisk/types';

import { failureLogPath, type WorkspaceLayout } from './paths.js';

export interface RecordInput {
  readonly domain: string;
  readonly action: string;
  readonly expected: string;
  readonly observed: string;
  readonly rootCause?: string;
  readonly workaround?: string;
  readonly tags?: readonly string[];
}

export class FailureLog {
  constructor(private readonly layout: WorkspaceLayout) {}

  async record(input: RecordInput): Promise<FailureRecord> {
    const now = new Date();
    const dateIso = todayIso(now);
    const path = failureLogPath(this.layout, dateIso);
    await mkdir(dirname(path), { recursive: true });

    const sequence = await this.nextSequence(dateIso);
    const id = `f_${dateIso}_${String(sequence).padStart(3, '0')}`;
    const record: FailureRecord = {
      id,
      domain: input.domain,
      action: input.action,
      expected: input.expected,
      observed: input.observed,
      tags: input.tags ?? [],
      createdAt: Math.floor(now.getTime() / 1000),
      ...(input.rootCause ? { rootCause: input.rootCause } : {}),
      ...(input.workaround ? { workaround: input.workaround } : {}),
    };
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async list(limit = 50): Promise<FailureRecord[]> {
    const entries: FailureRecord[] = [];
    const files = (await safeReaddir(this.layout.failuresRoot))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    for (const file of files) {
      const path = join(this.layout.failuresRoot, file);
      const raw = await readFile(path, 'utf8').catch(() => '');
      const lines = raw.split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        if (entries.length >= limit) return entries;
        try {
          entries.push(JSON.parse(line) as FailureRecord);
        } catch {
          // skip malformed lines (operator hand-edits, etc.)
        }
      }
    }
    return entries;
  }

  /** Mark a failure as resolved by a skill name. Rewrites the line in-place. */
  async linkResolvedSkill(failureId: string, skillName: string): Promise<boolean> {
    const dateIso = failureId.split('_')[1] ?? '';
    if (!dateIso) return false;
    const path = failureLogPath(this.layout, dateIso);
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) return false;
    const lines = raw.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: FailureRecord;
      try {
        parsed = JSON.parse(line) as FailureRecord;
      } catch {
        continue;
      }
      if (parsed.id !== failureId) continue;
      const updated = { ...parsed, resolvedBySkill: skillName };
      lines[i] = JSON.stringify(updated);
      changed = true;
      break;
    }
    if (!changed) return false;
    await writeFile(path, lines.join('\n'), 'utf8');
    return true;
  }

  private async nextSequence(dateIso: string): Promise<number> {
    const path = failureLogPath(this.layout, dateIso);
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (!raw) return 1;
    const count = raw.split(/\r?\n/).filter(Boolean).length;
    return count + 1;
  }
}

function todayIso(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

// Re-export for tests that want to pre-create bucket paths.
export const _internal = { failureLogPath, resolve };
