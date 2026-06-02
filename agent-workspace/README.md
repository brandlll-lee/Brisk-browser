# Brisk Agent Workspace

This directory belongs to **the Agent** (LLM client driving Brisk via MCP).
Brisk itself reads from here at runtime but **does not own its contents** —
you (the user) and your agents do.

Three things live here:

| Path | Owner | Purpose |
|---|---|---|
| `agent_helpers.ts` | Agent (via `attach_helper`) | Task-specific helper functions, hot-reloaded at runtime |
| `domain-skills/<domain>/<name>.md` | Agent (via `write_skill`) | Per-domain knowledge sediment (selectors, traps, flows) |
| `failures/<YYYY-MM-DD>.jsonl` | Agent (via `record_failure`) | Structured failure log; informs future skills |
| `skills.db` | Brisk runtime | SQLite FTS5 index over the markdown skills above. Auto-generated. Safe to delete (rebuilds). |

## Editing rules

- **Agents** must use the MCP tools (`write_skill`, `record_failure`, `attach_helper`) to update files here. They give you provenance + indexing + safety checks.
- **Humans** can edit markdown files directly — just delete `skills.db` afterwards so Brisk rebuilds the index.
- `skills.db` is gitignored. The markdown files and JSONL logs are NOT gitignored — they're meant to be committed.

## Privacy

These files may contain hints about what sites you visit and what tasks you run. Treat the workspace like your `.bash_history` — review before sharing.
