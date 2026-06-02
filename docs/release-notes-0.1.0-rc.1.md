# Brisk 0.1.0-rc.1 release notes

**Release date**: 2026-06-02
**Status**: Release Candidate
**Sponsor**: (none yet)

The first cut of Brisk — a thin, fast, native-MCP harness that any
agent can drive your local Chrome with.

## Highlights

- **37 MCP tools** for browser control — observation, interaction,
  navigation, waits, network, files, admin, and self-learning skills.
- **Two transports**: stdio (Claude Desktop / Cline) and Streamable
  HTTP (Cursor / Continue). One daemon, switch with a flag.
- **Cross-platform**: Windows 10/11, macOS 12+, Ubuntu 22.04+.
  `brisk chrome` launches Chrome / Edge / Brave / Chromium on any
  platform with proper `--user-data-dir` and `DevToolsActivePort`
  handling.
- **19 interaction-skill markdown docs** served as MCP resources —
  agents start with the same baseline knowledge a senior browser
  automation engineer would have.
- **Skill self-learning**: agents call `record_failure` and
  `write_skill`; the next session sees those skills as MCP resources.
- **Fast**: full `goto + screenshot + click + screenshot` cycle in
  **170 ms** on a Windows 11 headless Chrome (budget 800 ms).
- **Light**: 200 sustained screenshots peak at 166-189 MB RSS
  (budget 200 MB), with no unbounded growth.

## Install

```bash
npm install -g @brisk/cli
brisk doctor
```

See [`docs/install.md`](./install.md) for Way 1 (your everyday Chrome)
and Way 2 (`brisk chrome` launches a fresh one) setup.

## Configure your MCP client

### Claude Desktop / Cline

```json
{
  "mcpServers": {
    "brisk": {
      "command": "brisk",
      "args": ["serve", "--transport", "stdio"]
    }
  }
}
```

### Cursor / Continue / browser-based

```bash
brisk serve --transport http --port 9100
# → MCP endpoint at http://127.0.0.1:9100/mcp
```

See [`docs/install.md`](./install.md) for full per-client setup.

## What's in / out

### In V0.1.0-rc.1

| Capability | Status |
|---|---|
| MCP server (stdio + HTTP) | ✓ |
| 37 browser tools | ✓ |
| Skill self-learning (write/read/record_failure) | ✓ |
| 19 interaction-skill docs as resources | ✓ |
| `brisk doctor` / `brisk chrome` / `brisk daemon` | ✓ |
| Windows / macOS / Linux | ✓ |
| Playwright E2E (stdio + http + benchmark + memory) | ✓ |

### Deferred to later

| Capability | Target |
|---|---|
| Browser Use Cloud / remote browsers | V0.1.1 |
| Domain-skills bundle (community per-site playbooks) | V0.1.1 |
| Profile sync from local Chrome | V0.1.1 |
| AI Agent SDK on top of Brisk | V0.2.x |
| Chromium fork (in-process MCP server) | V0.3.x |

## Test it

After install, the fastest end-to-end smoke test:

```bash
brisk chrome --port 9333 --headless &   # spawn an isolated Chrome
brisk serve --transport http --port 9100 --cdp-port 9333 &

# In a third terminal:
curl -sX POST http://127.0.0.1:9100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

You should get back a JSON-RPC response with the Brisk server info
and an `Mcp-Session-Id` response header. Echo that header on
subsequent calls to drive Brisk.

## Known limits

- The 1000-screenshot stress target from the W6 plan is dialled to
  **200 by default** because headless Chrome's compositor backpressures
  on about:blank above ~60 rapid-fire screenshots. Set
  `BRISK_MEMORY_ITERATIONS=1000` to opt into the longer run.
- Origin allow-list defaults to localhost; opt into wider origin
  acceptance via `allowedOrigins` in the HTTP transport.
- Streamable HTTP uses an in-memory session map. Restarting Brisk
  drops all sessions; clients must re-handshake.
- Chrome 144+'s "Allow remote debugging?" popup may reappear under
  conditions we haven't fully characterised. Use Way 2 (`brisk chrome`)
  to bypass entirely.

## Upgrade path to RC2 / GA

After RC1 ships, the focus is:

1. **Real-user feedback** from the three primary platforms.
2. **Domain-skills bundle** — fork a curated set of high-frequency
   sites' skills from browser-harness with attribution.
3. **Browser Use Cloud** integration — `start_remote_daemon`
   equivalent.
4. **Profile sync** — `sync_local_profile` for hermetic sessions
   with the user's logged-in state.

GA targets `0.1.0` (no `-rc` suffix) when each of these has user
validation from at least three independent users.

## Acknowledgements

Brisk stands on the shoulders of two giants:

- **[browser-harness](https://github.com/browser-use/browser-harness)**
  by Browser Use — the Python ancestor whose "less is more" philosophy
  shapes Brisk's API design. Most tool semantics map 1-to-1 to
  browser-harness's helpers, with a TypeScript and MCP-native
  reimplementation. AGPL-3.0; not redistributed.
- **[BrowserOS](https://github.com/browseros-ai/browseros)** — the
  Chromium fork that's V0.3's roadmap. Their CDP client patterns
  (`packages/browseros-agent/apps/server/src/browser/backends/cdp.ts`),
  MCP route implementation, and server-manager Chromium embedding all
  inform Brisk's architecture. AGPL-3.0; not redistributed.

Direct comparisons / lineage table in
[`docs/v0.1.0-plan.md`](./v0.1.0-plan.md) Appendix A.

## License

Apache-2.0.
