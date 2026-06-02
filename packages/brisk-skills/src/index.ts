/**
 * @brisk/skills — self-learning skill store.
 *
 * Three layers:
 *   • SkillsWriter — markdown file I/O under `agent-workspace/domain-skills/`
 *   • SkillsStore  — SQLite + FTS5 index for fast search
 *   • FailureLog   — append-only JSONL ledger of agent failures
 *
 * Public entry point: `SkillsManager`.
 */

export const BRISK_SKILLS_VERSION = '0.1.0-dev' as const;

export { FailureLog, type RecordInput } from './failures.js';
export {
  type FrontMatter,
  parseSkillDocument,
  type SkillDocument,
  stringifySkillDocument,
} from './frontmatter.js';
export { type ManagerOptions, SkillsManager } from './manager.js';
export {
  canonicalizeDomain,
  failureLogPath,
  parseSkillUri,
  resolveWorkspace,
  skillFilePath,
  skillUri,
  slugifyName,
  type WorkspaceLayout,
} from './paths.js';
export { type SearchOptions, type SkillRow, SkillsStore, type UpsertInput } from './store.js';
export {
  type DiskSkillEntry,
  type ReadSkillResult,
  SkillsWriter,
  type WriteSkillInput,
  type WriteSkillResult,
} from './writer.js';
