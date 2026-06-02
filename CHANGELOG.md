# Changelog

All notable changes to Brisk will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-06-03

Brisk 0.1.0 GA hardens the release candidate for a first public
developer release.

### Changed

- Unified package, CLI, MCP, core, and skills versions to `0.1.0`.
- Made `@brisk/cli` publishable with npm metadata and public publish config.
- Tightened Streamable HTTP safety: non-loopback hosts now require
  `--allow-remote`, and Origin checks use an exact allow-list.
- Stabilized benchmark E2E by using isolated CDP ports, exact page readiness,
  and screenshot compositor wake-up before capture.
- Added GitHub Actions CI across Windows, macOS, and Ubuntu.

### Fixed

- Removed lint failures from non-null assertions and local Cursor config formatting.
- Fixed explicit `--cdp-port` handling so Brisk no longer discovers a stale
  user-profile DevTools endpoint before probing the requested port.

## [0.1.0-rc.1] — 2026-06-02

The first release candidate of Brisk — an AI-native browser harness
that any MCP-capable agent can drive.

### Added

**Core packages (6)**

- `@brisk/types` — shared types, `Result<T, E>`, `BriskError` discriminated union.
- `@brisk/ipc` — cross-platform JSON-line IPC (Unix socket on POSIX,
  named pipe on Windows).
- `@brisk/core` — CDP client (WebSocket + keepalive + reconnect),
  daemon orchestrator, 25 browser helpers across observation /
  interaction / navigation / waits / network / admin / files.
- `@brisk/skills` — SQLite FTS5 skill store, failure log, agent
  workspace layout.
- `@brisk/mcp` — Model Context Protocol server: 37 tools, stdio
  transport, Streamable HTTP transport, three resource families
  (interaction-skills static markdown, domain-skills dynamic,
  failure dynamic).
- `@brisk/cli` — user-facing `brisk` binary: `doctor`, `chrome`,
  `serve`, `daemon start|stop|status`.

**MCP tools (37 total)**

- Observation (6): `page_info`, `capture_screenshot`, `js`, `dom`,
  `get_console_logs`, `drain_events`, `connection_status` (shared
  with admin).
- Interaction (8): `click_at_xy`, `hover_at_xy`, `type_text`,
  `fill_input`, `press_key`, `scroll`, `select_option`, `dispatch_key`.
- Navigation (8): `goto_url`, `list_tabs`, `current_tab`,
  `switch_tab`, `new_tab`, `close_tab`, `ensure_real_tab`,
  `iframe_target`.
- Waits (3): `wait`, `wait_for_load`, `wait_for_element`.
- Network (2): `http_get`, `cdp` (raw CDP passthrough).
- Admin (3): `connection_status`, `restart_daemon`, `pending_dialog`.
- Files (1): `upload_file`.
- Events (1): `drain_events`.
- Skills (5): `list_skills`, `read_skill`, `write_skill`,
  `record_failure`, `attach_helper`.

**Interaction-skill documentation (19 markdown files served as MCP resources)**

- W4 set: `connection`, `screenshots`, `tabs`, `dialogs`, `iframes`,
  `dom-inspection`, `console-logs`, `scrolling` (8).
- W5 set: `cookies`, `cross-origin-iframes`, `downloads`,
  `drag-and-drop`, `dropdowns`, `network-requests`, `print-as-pdf`,
  `profile-sync`, `shadow-dom`, `uploads`, `viewport` (11).

**CLI commands**

- `brisk doctor` — env health check: Node, platform (Windows
  named-pipe / macOS osascript / Linux Wayland/X11 + Snap warnings),
  Chrome binary discovery, CDP endpoint, IPC daemon, stale socket
  detection.
- `brisk chrome` — cross-platform Chrome launcher with
  `--remote-debugging-port` enforcement, refuses platform-default
  user-data-dirs (Chrome 136+ regression), handles Snap warnings,
  Wayland notes, `DevToolsActivePort` poll, headless mode, dry-run.
- `brisk serve` — start MCP server (`--transport stdio|http`,
  `--port`, `--host`, `--workspace`, `--no-skills`).
- `brisk daemon start|stop|status` — long-running IPC daemon with
  graceful shutdown, status PID/uptime, connection_status round-trip.

**Documentation**

- `docs/install.md` — Way 1 (chrome://inspect) + Way 2 (`brisk chrome`)
  + per-client MCP setup (Claude Desktop, Cursor, Cline, Continue,
  Claude Code, ChatGPT Desktop, generic MCP).
- `docs/mcp-protocol.md` — full MCP wire-format reference, tool
  groupings, error codes, transport differences, compatibility matrix.
- `docs/architecture.md` — process topology, package graph, data
  flow for tool calls, skill self-learning loop, reserved V0.3
  interfaces.
- `docs/chromium-embedding.md` — V0.3 contract for embedded Chromium
  build, mojo channel migration path, invariant interfaces.
- `docs/v0.1.0-plan.md` — exhaustive implementation plan.
- `README.md` — user-facing entry point.
- `SKILL.md` — agent-facing skill description.

**Testing**

- 100+ unit tests across all packages, 100% pass rate.
- Real-Chrome smoke test (`packages/brisk-cli/src/e2e.test.ts`)
  validating Chrome attach, all 37 MCP tools registered, interaction
  skill resources exposed, `connection_status` round-trip.
- Playwright W6 E2E suite (`packages/brisk-cli/tests-e2e/`):
  - `stdio.spec.ts` — JSON-RPC initialize + tools/list returns 37 +
    `connection_status` round-trip over stdio.
  - `http.spec.ts` — Streamable HTTP transport with `Mcp-Session-Id`
    propagation, initialize + tools/list + tools/call.
  - `benchmark.spec.ts` — `goto + capture + click + capture` budget
    (≤ 800 ms; measured ≈ 170 ms locally).
  - `memory.spec.ts` — 200 sustained screenshots (1000 via env var)
    stay under 200 MB RSS.

### Performance & limits

- E2E benchmark (Windows 11, headless Chrome): full
  `goto + capture_screenshot + click_at_xy + capture_screenshot`
  cycle: **170 ms** (budget 800 ms, 4.7× under budget).
- Memory: 200 sustained screenshots, peak 166-189 MB RSS
  (budget 200 MB). Memory returns to ~120-160 MB after GC; no
  unbounded growth observed.

### Platform support

- Windows 10/11 x64 — primary dev environment, all features tested.
- macOS (12+) — supported (osascript-aware doctor, Unix socket IPC).
- Linux (Ubuntu 22.04+) — supported (Wayland/X11/Snap-aware doctor).

### Known limits (deferred)

- No domain-skills bundle yet (V0.1.1).
- No Browser Use Cloud / remote browsers (V0.1.1).
- No profile sync from local Chrome (V0.1.1).
- 1000-shot stress: headless Chrome compositor backpressure on
  about:blank above ~60 rapid-fire screenshots. Set
  `BRISK_MEMORY_ITERATIONS=1000` to opt into the longer run with
  recovery delays; default is 200.

### Internal

- pnpm 10+ workspaces with `catalog:` version pinning.
- Biome 2.x lint+format, TypeScript 5.6 strict, vitest 2.x for units.
- All test budgets enforced in test code rather than scripts (so
  CI surfaces regressions automatically).

[Unreleased]: https://github.com/brandlll-lee/Brisk-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/brandlll-lee/Brisk-browser/releases/tag/v0.1.0
[0.1.0-rc.1]: https://github.com/brandlll-lee/Brisk-browser/releases/tag/v0.1.0-rc.1
