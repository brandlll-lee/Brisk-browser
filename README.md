# Brisk

> An AI-native browser harness — thin CDP layer that any MCP-capable agent can drive.

**Status**: V0.1.0 in active development. Foundation laid 2026-06-02.

## What is Brisk?

Brisk is the local **brain** that will eventually live inside a forked
Chromium browser. Today it runs as a standalone Node.js daemon that
attaches to your existing Chrome / Edge / Brave / Chromium over CDP
and exposes **37 browser-control tools** through the
[Model Context Protocol](https://modelcontextprotocol.io) — so
Claude Code, Cursor, Cline, Codex, Continue, ChatGPT Desktop, or any
other MCP client can drive the browser directly.

Three things make Brisk different:

1. **Thin by design.** No selector hunt, no DOM tree flattening, no
   agent loop, no LLM provider lock-in. The harness is the muscle; the
   LLM is the brain. browser-harness was right.
2. **Native MCP.** Both `stdio` (Claude Desktop, Cline) and Streamable
   HTTP (Cursor, web clients) — same daemon, switch with one flag.
3. **Self-learning skills.** When the agent hits something unexpected,
   it calls `record_failure` and `write_skill`. Next time it visits the
   same site, the skill auto-attaches as a domain resource. Brisk
   learns by doing — and it's the **harness** that does the housekeeping,
   not the LLM's memory.

## Quick start

```bash
npm install -g @brisk/cli

brisk doctor                              # check the environment
brisk chrome --port 9222                  # spawn a Chrome for Brisk (Way 2)
                                          # — leave this terminal running
                                          
# In another terminal:
brisk serve --transport stdio             # MCP server on stdin/stdout
# OR
brisk serve --transport http --port 9100  # MCP server on http://127.0.0.1:9100/mcp
```

Then point your MCP client at Brisk. See
[`docs/install.md`](docs/install.md) for Claude Desktop / Cursor /
Cline / Continue / Claude Code setup.

## Demo flow

```bash
# 1. Start Brisk attached to your local Chrome
brisk chrome --port 9222 --headless &
brisk serve --transport stdio &

# 2. From an MCP client, ask the agent:
#   "Open github.com/browser-use/browser-harness and read the README."

# Behind the scenes, the agent calls:
#   tools/call new_tab          {"url": "https://github.com/browser-use/browser-harness"}
#   tools/call wait_for_load    {}
#   tools/call capture_screenshot {}
#   tools/call dom              {"selector": "article.markdown-body"}
#   ... and returns the README summary.
```

## What's in V0.1.0?

| | Status |
|---|---|
| 37 MCP tools (observation / interaction / navigation / waits / network / admin / files / events / skills) | ✓ |
| stdio + Streamable HTTP transports | ✓ |
| 19 interaction-skills markdown resources | ✓ |
| Skill self-learning (write_skill / record_failure / list_skills) | ✓ |
| Cross-platform (Windows + macOS + Linux) | ✓ |
| `brisk doctor` (env check) | ✓ |
| `brisk chrome` (cross-platform launcher) | ✓ |
| `brisk daemon start|stop|status` (IPC daemon) | ✓ |
| E2E tests against real Chrome | ✓ |

What V0.1.0 doesn't have (intentional):

| | |
|---|---|
| AI Agent brain | V0.2.x |
| LLM provider integration | V0.2.x |
| Domain skills bundle | V0.1.1 |
| Browser Use Cloud / remote browsers | V0.1.1 |
| Profile sync | V0.1.1 |
| Chromium fork | V0.3.x |

## Architecture

```text
+----------+   stdio or HTTP/mcp   +---------------+   WebSocket   +-----------+
| MCP      | <===================> | Brisk server  | <===========> | Chrome /  |
| client   |   (37 tools)          | (Node.js 22+) |   (CDP)       | Chromium  |
+----------+                       +---------------+               +-----------+
                                    @brisk/cli, mcp,
                                    core, skills, ipc
```

Six packages, single process, zero native deps (except
`better-sqlite3` for the skill store). See
[`docs/architecture.md`](docs/architecture.md).

## Repository layout

```
brisk/
├── packages/
│   ├── brisk-types     Shared TypeScript types (IPC, tools, CDP)
│   ├── brisk-ipc       Cross-platform IPC (unix socket / named pipe)
│   ├── brisk-core      CDP client + daemon + browser helpers
│   ├── brisk-skills    SQLite FTS5 skill store + failure log
│   ├── brisk-mcp       MCP tools + stdio + Streamable HTTP transports
│   └── brisk-cli       brisk doctor / serve / chrome / daemon
├── agent-workspace/    Agent-editable: skills.db, agent_helpers.ts, domain-skills/, failures/
├── interaction-skills/ General browser interaction reference (19 .md files served as MCP resources)
├── references/         browser-harness + BrowserOS source (read-only, for study)
└── docs/               install.md / mcp-protocol.md / architecture.md / chromium-embedding.md / v0.1.0-plan.md
```

## Documentation

| | |
|---|---|
| [`docs/install.md`](docs/install.md) | Install + Way 1 + Way 2 + per-client MCP setup |
| [`docs/mcp-protocol.md`](docs/mcp-protocol.md) | MCP wire format, tool list, error codes |
| [`docs/architecture.md`](docs/architecture.md) | Package map, data flow, lifecycle |
| [`docs/chromium-embedding.md`](docs/chromium-embedding.md) | V0.3 design contract (deferred) |
| [`docs/v0.1.0-plan.md`](docs/v0.1.0-plan.md) | The exhaustive V0.1.0 plan |
| [`SKILL.md`](SKILL.md) | Agent-facing skill description for Claude Code / Cursor |

## Tech stack

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js LTS | `>=22.12.0` (22.x or 24.x recommended) |
| Language | TypeScript strict | `^5.6.0` |
| Schemas | Zod | `^4.0.0` |
| MCP SDK | `@modelcontextprotocol/sdk` | `^1.29.0` |
| HTTP | Hono + `@hono/node-server` | `^4.12.16` |
| CDP | Node built-in `globalThis.WebSocket` | (stable since Node 22) |
| DB | `better-sqlite3` (FTS5) | `^12.0.0` |
| Lint+format | Biome | `^2.0.0` |
| Package mgr | pnpm + catalogs | `^10.14.0` |

See [`docs/v0.1.0-plan.md`](docs/v0.1.0-plan.md) §3 for the rationale
on every choice.

## Roadmap

- **V0.1.0** (you are here) — Node.js daemon, 37 MCP tools, two
  transports, skill self-learning, three platforms.
- **V0.1.1** — Browser Use Cloud, profile sync, domain-skills bundle.
- **V0.2.x** — AI Agent SDK on top of Brisk. First task-driven agent.
- **V0.3.x** — Fork Chromium 152+; Brisk runs in-process. AI sidebar,
  agent tab strip, semantic bookmarks. See
  [`docs/chromium-embedding.md`](docs/chromium-embedding.md).
- **V1.0** — Full Brisk Browser distribution (dmg / msi / AppImage).

## License

Apache-2.0.

References under `references/` are kept verbatim from their upstream
projects (browser-harness — AGPL-3.0; BrowserOS — AGPL-3.0) for study
only. They're not redistributed as part of any Brisk binary.

## Contributing

See [`docs/v0.1.0-plan.md`](docs/v0.1.0-plan.md) for the full design.
Issues and PRs welcome on
[github.com/yourusername/brisk](https://github.com/yourusername/brisk).
For now, the surest path to a good PR is reading `docs/architecture.md`
+ one of the existing helpers (e.g. `packages/brisk-core/src/helpers/interaction/click.ts`)
and matching that style.
