/**
 * Lightweight YAML-ish front matter parser tailored to Brisk skill files.
 *
 * A skill markdown looks like:
 *
 *     ---
 *     title: "Star button trap on GitHub"
 *     tags: [github, button]
 *     created_at: 1717400000
 *     based_on_failure: f_2026-06-02_001
 *     ---
 *
 *     # Body…
 *
 * We don't pull in `yaml` or `gray-matter` for V0.1.0 — both add ≥30 KB
 * of dependencies for what reduces to scalar/array of scalars. The parser
 * supports the subset documented in `docs/v0.1.0-plan.md §7.3.1`.
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface FrontMatter {
  /** Required: human-readable title. */
  title?: string;
  /** Optional: tag array (`[a, b]` or `[a]`). */
  tags?: readonly string[];
  /** Optional unix seconds. */
  createdAt?: number;
  /** Optional: linked failure id. */
  basedOnFailure?: string;
  /** Any extra keys preserved as raw strings. */
  extras?: Readonly<Record<string, string>>;
}

export interface SkillDocument {
  readonly frontMatter: FrontMatter;
  readonly body: string;
}

/** Parse a markdown skill document. */
export function parseSkillDocument(raw: string): SkillDocument {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) {
    return { frontMatter: {}, body: raw };
  }
  const fmText = match[1] ?? '';
  const body = raw.slice(match[0].length);
  return { frontMatter: parseFrontMatter(fmText), body };
}

/** Serialize a skill document back to a single string. */
export function stringifySkillDocument(doc: SkillDocument): string {
  const fm = stringifyFrontMatter(doc.frontMatter);
  return `${fm}${doc.body}`;
}

function parseFrontMatter(text: string): FrontMatter {
  const out: FrontMatter & { extras: Record<string, string> } = { extras: {} };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    switch (key) {
      case 'title':
        out.title = stripQuotes(rawValue);
        break;
      case 'tags':
        out.tags = parseStringArray(rawValue);
        break;
      case 'created_at':
      case 'createdAt': {
        const n = Number(rawValue);
        if (Number.isFinite(n)) out.createdAt = n;
        break;
      }
      case 'based_on_failure':
      case 'basedOnFailure':
        out.basedOnFailure = stripQuotes(rawValue);
        break;
      default:
        out.extras[key] = stripQuotes(rawValue);
    }
  }
  if (Object.keys(out.extras).length === 0) {
    const { extras: _extras, ...rest } = out;
    return rest;
  }
  return out;
}

function stringifyFrontMatter(fm: FrontMatter): string {
  const lines: string[] = ['---'];
  if (fm.title !== undefined) lines.push(`title: ${quoteIfNeeded(fm.title)}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(quoteIfNeeded).join(', ')}]`);
  }
  if (fm.createdAt !== undefined) lines.push(`created_at: ${fm.createdAt}`);
  if (fm.basedOnFailure !== undefined) {
    lines.push(`based_on_failure: ${quoteIfNeeded(fm.basedOnFailure)}`);
  }
  if (fm.extras) {
    for (const [k, v] of Object.entries(fm.extras)) {
      lines.push(`${k}: ${quoteIfNeeded(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter(Boolean);
  }
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
