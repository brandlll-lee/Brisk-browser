# Brisk Architecture

Brisk V0.1.0 is six TypeScript packages stitched together in a single
process. This document explains what each does and how they talk.

## Process topology

```text
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   MCP Client (Cursor / Claude / Cline / ...)                        │
│                                                                     │
└─────────────────┬───────────────────────────────────────────────────┘
                  │ stdio  OR  HTTP /mcp
                  │ (JSON-RPC 2.0, MCP 2025-06-18)
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  brisk serve                                                        │
│                                                                     │
│   ┌──────────────────────────────────────┐                          │
│   │  MCP server (@brisk/mcp)             │                          │
│   │  • 37 tools                          │                          │
│   │  • interaction-skills resources      │                          │
│   │  • domain-skills resources           │                          │
│   └──────────┬───────────────────────────┘                          │
│              │ HelperContext + BriskToolContext                     │
│              ▼                                                      │
│   ┌──────────────────────────────────────┐                          │
│   │  helpers (@brisk/core)               │  ┌─────────────────────┐ │
│   │  • observation                       │  │                     │ │
│   │  • interaction                       │  │  Skills DB          │ │
│   │  • navigation                        │  │ (@brisk/skills)     │ │
│   │  • waits                             │◀─┤ better-sqlite3      │ │
│   │  • network                           │  │ + FTS5              │ │
│   │  • admin                             │  │                     │ │
│   └──────────┬───────────────────────────┘  └─────────────────────┘ │
│              │ CdpBackend                                           │
│              ▼                                                      │
│   ┌──────────────────────────────────────┐                          │
│   │  CDP backend (@brisk/core/cdp)       │                          │
│   │  • discoverCdpEndpoint               │                          │
│   │  • WebSocket connect/reconnect       │                          │
│   │  • Browser.getVersion keepalive      │                          │
│   │  • pending Map + session cache       │                          │
│   └──────────┬───────────────────────────┘                          │
│              │                                                      │
│              │ (optional, when daemon mode)                         │
│              ▼                                                      │
│   ┌──────────────────────────────────────┐                          │
│   │  IPC server (@brisk/ipc)             │                          │
│   │  • Unix socket (POSIX)               │                          │
│   │  • Named pipe (Windows)              │                          │
│   │  • Newline-delimited JSON            │                          │
│   └──────────────────────────────────────┘                          │
└─────────────────┬───────────────────────────────────────────────────┘
                  │ WebSocket
                  │ ws://localhost:9222/devtools/browser/...
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Chrome / Chromium / Edge / Brave                                  │
│   (Way 1 current profile, or Way 2 isolated remote-debugging profile)│
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Packages

All packages are `private: true` workspace members in pnpm. They share
a `catalog:` for dependency versions.

### `@brisk/types`

Shared types and the `BriskError` discriminated union. No runtime code
except the `briskError(...)` factory. Used as a peer of every other
package to avoid type drift.

Key exports:
- `Result<T, E>` — `{ ok: true; value } | { ok: false; error }`
- `BriskError` with a fixed code set
- `ToolName` literal union
- `ToolCategory` literal union

### `@brisk/ipc`

Cross-platform JSON-line IPC. POSIX uses Unix sockets at
`/tmp/brisk-<instance>.sock`; Windows uses named pipes at
`\\.\pipe\brisk-<instance>`. The protocol is one JSON object per line,
LF-terminated.

Frame:
- Request: `{id?, method, params, sessionId?}` or `{meta: <op>}`
- Response: `{id?, result?, error?, events?, sessionId?}`

The `meta:` channel is for daemon control (shutdown, session,
connection_status). Everything else is forwarded to the daemon's
`handle()`.

### `@brisk/core`

The heart. Three subsystems:

1. **`cdp/`** — `CdpBackend` is a single CDP WebSocket connection.
   Owns:
   - Reconnect with exponential backoff
   - `Browser.getVersion` keepalive (every 5s)
   - Pending request Map (timeouts, cancellation)
   - Session cache for `Target.attachToTarget({flatten: true})`
   - Event stream (a single AsyncIterable for all CDP events)

2. **`daemon/`** — `Daemon` orchestrates a single browser session:
   - `attachToSession` to a Chrome target
   - Re-attach on browser close + reopen
   - ConsoleCollector buffers `Runtime.consoleAPICalled`
   - Pending dialog tracker (auto-surfaced in `page_info`)
   - Active-tab tracking via `TAB_MARKER` (horse emoji)

3. **`helpers/`** — Pure functions taking `HelperContext`. One function
   per MCP tool. These are the units of automation:
   - `observation/` — `pageInfo`, `captureScreenshot`, `dom`, `getConsoleLogs`, `drainEvents`, `connectionStatus`
   - `interaction/` — `clickAtXy`, `typeText`, `fillInput`, `pressKey`, `scroll`, `hoverAtXy`, `selectOption`, `dispatchKey`
   - `navigation/` — `gotoUrl`, `listTabs`, `newTab`, `switchTab`, `closeTab`, `currentTab`, `ensureRealTab`, `iframeTarget`
   - `waits/` — `wait`, `waitForLoad`, `waitForElement`
   - `network/` — `httpGet`, `cdpRaw`
   - `admin/` — `connectionStatus`, `restartDaemon`, `pendingDialog`
   - `files/` — `uploadFile`

Helpers are intentionally thin. No retry loops, no element-hunting, no
DOM tree flattening. Just CDP calls with type-safe wrappers.

### `@brisk/skills`

The agent's persistent learning store. `SkillsManager` wraps a
`better-sqlite3` database with FTS5. Three concepts:

- **Skill** — a markdown file with YAML front-matter, scoped to a
  domain (host name). Written by the agent itself via `write_skill`.
- **Failure** — a structured record of "I tried X and it didn't work".
  Includes context, error, and what was attempted.
- **Helper** — a JavaScript expression the agent can attach to its
  context. (Future: full code via `attach_helper`.)

The store sits on disk in `agent-workspace/`. Each workspace can be
mounted by N MCP servers concurrently — they share the FTS index.

### `@brisk/mcp`

Wraps `@modelcontextprotocol/sdk`. Three pieces:

1. **`framework.ts`** — `BriskTool<S, R>` interface: name, category,
   description, Zod schema, handler. `executeTool` runs the handler
   and turns a `Result<T>` into MCP content.

2. **`tools/`** — 37 tool definitions, organised by category. Each
   tool is a thin wrapper over a helper.

3. **`resources.ts`** — Static and dynamic MCP resource templates:
   - Static: 19 interaction-skill markdown files (mounted from disk).
   - Dynamic: domain-skills enumerated from SQLite.
   - Dynamic: failure records, also from SQLite.

4. **`transports/`** — `stdio` and `http` adapters. Both produce a
   ready-to-call `McpServer` via `createBriskMcpServer`.

### `@brisk/cli`

The user-facing `brisk` binary. Commands:

- `brisk doctor` — environment check
- `brisk chrome` — launch Chrome cross-platform (W5 addition)
- `brisk serve` — start the MCP server (stdio or HTTP)
- `brisk daemon start|stop|status` — manage the IPC daemon

`commands/boot.ts` is shared bootstrap: discover CDP, connect, attach,
init skills, wire helpers — the same flow regardless of which command
you ran.

## Lifecycle: a typical `brisk serve` run

```
1. CLI parses argv, calls runServe(opts)
2. boot() discovers CDP endpoint. CLI flags are most explicit; without
   them the env/profile cascade is:
   BRISK_CDP_WS > BRISK_CDP_URL > DevToolsActivePort sweep > 9222/9223
3. CdpBackend.connect() opens the WebSocket
4. Daemon.start() picks a target (first real non-internal tab), runs
   Target.attachToTarget(flatten:true) → cached sessionId
5. SkillsManager.open() initialises agent-workspace/skills.db
6. createBriskMcpServer({ helpers, daemon, skills, interactionSkillsDir })
   wires everything into one McpServer instance
7. Transport-specific:
   - stdio: server.connect(stdio transport); blocks on stdin
   - http:  Hono app + @hono/node-server.serve
8. On SIGINT: orderly shutdown
   - close MCP transport (in-flight requests finish)
   - close Skills DB
   - close CDP WebSocket (sends Target.detachFromTarget first)
   - exit 0
```

## Data flow: a single `click_at_xy` call

```
Client                              Brisk                             Chrome
──────                              ─────                             ──────
tools/call name=click_at_xy
args={x:120,y:340,button:left,clicks:1}
  ──JSON-RPC─▶
                  parse + Zod validate
                  framework.executeTool calls helper
                  clickAtXy(ctx, args)
                    ├─ cdp.send("Input.dispatchMouseEvent",
                    │              {type:"mousePressed", x, y, button, clickCount:1})
                    │   ─────WebSocket─▶
                    │                                          accepts; dispatches at compositor
                    │   ◀───response────
                    └─ cdp.send("Input.dispatchMouseEvent",
                                  {type:"mouseReleased", x, y, button, clickCount:1})
                        ─────WebSocket─▶
                                                                  fires onclick handlers
                        ◀───response────
                  Result.ok({})
                  serialize to MCP content
  ◀──JSON-RPC───
result.content[0].text = "{\"ok\":true}"
result.isError = false
```

Two CDP round-trips per click. Brisk doesn't try to be smart about it
(no "smart click" with element resolution). The LLM picks coordinates
from a prior screenshot. Bitter Lesson: trust the model.

## Skill self-learning loop

```
Agent tries an action  →  fails  →  record_failure(context, error)
                                          │
                                          ▼
                                   stored in SQLite
                                   resources/list emits mcp://brisk/failure/<id>
                                          │
                                          ▼
                          Agent reads its OWN failures next session
                                          │
                                          ▼
                          Synthesizes a skill: write_skill(domain, name, body)
                                          │
                                          ▼
                                   stored in SQLite + .md on disk
                                   resources/list emits mcp://brisk/domain-skill/<id>
                                          │
                                          ▼
                       Next agent visiting that domain reads the skill
                                          │
                                          ▼
                                  Action succeeds without retry
```

The agent is responsible for writing skills — Brisk doesn't synthesise
them automatically. This is the simplest possible thing that works:
the LLM is smart, the harness is dumb.

## Reserved interfaces for V0.2+

Several abstractions exist *only* so they can be cleanly replaced
later:

- **`HelperContext`** — currently `{cdp, daemon, signal?}`. V0.2 will
  add `{agent?: AgentBrain}` for harnesses that embed an LLM.

- **`CdpBackend` interface** — currently implemented by
  `WebSocketCdpBackend`. V0.3 (Chromium embedding) will add an
  `InProcessCdpBackend` that talks to a forked Chromium via
  `chrome::content::DevToolsAgentHost`.

- **`BriskToolContext`** — currently `{cdp, daemon, skills, signal?}`.
  V0.2 will add `{memory?: SessionMemory}` for compaction.

These types are stable surfaces; their implementations are not.

## What Brisk is NOT

- **Not a browser** — Chrome does the work. Brisk is a thin control
  plane.
- **Not an agent framework** — no LLM call, no loop, no memory, no
  planner. That's V0.2.
- **Not a Playwright** — no high-level abstractions like
  `page.click('text=Submit')`. Brisk's tools are CDP primitives with
  type checks.
- **Not a Selenium** — no W3C WebDriver wire format. CDP only.
- **Not a Puppeteer port** — Puppeteer is for engineers writing JS
  automation; Brisk is for LLMs deciding actions at runtime.

The distinction matters: Brisk's design assumes the caller is an LLM,
not a developer. Less framework = more bitter lesson.
