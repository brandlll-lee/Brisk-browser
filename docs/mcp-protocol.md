# Brisk MCP Protocol Reference

Brisk implements the MCP specification revision **2025-06-18**, exposed
over two transports:

| Transport | Use case | Command |
|---|---|---|
| **stdio** | Subprocess MCP clients (Claude Desktop, Cline, Codex) | `brisk serve --transport stdio` |
| **Streamable HTTP** | Network MCP clients (Cursor, Continue, custom) | `brisk serve --transport http --port 9100` |

All MCP methods, content types, and error codes are wire-compatible with
the spec — no Brisk extensions to the protocol envelope.

## Initialize

Brisk advertises:

```json
{
  "protocolVersion": "2025-06-18",
  "serverInfo": {
    "name": "Brisk Browser",
    "version": "0.1.0"
  },
  "capabilities": {
    "tools": { "listChanged": false },
    "resources": { "listChanged": false, "subscribe": false }
  }
}
```

No `prompts`, `roots`, `sampling`, or `logging` capabilities in V0.1.0.

## Tools (37)

`tools/list` returns every tool. Tools are grouped by category:

| Category | Count | Examples |
|---|---|---|
| **Observation** (6) | observe page state | `page_info`, `capture_screenshot`, `dom`, `get_console_logs` |
| **Interaction** (8) | drive input | `click_at_xy`, `type_text`, `fill_input`, `press_key`, `scroll`, `hover_at_xy`, `select_option`, `dispatch_key` |
| **Navigation** (8) | move between pages / tabs | `goto_url`, `list_tabs`, `new_tab`, `switch_tab`, `close_tab`, `current_tab`, `ensure_real_tab`, `iframe_target` |
| **Waits** (3) | pace the agent | `wait`, `wait_for_load`, `wait_for_element` |
| **Network** (2) | bypass / probe | `http_get`, `cdp` |
| **Admin** (3) | daemon health | `connection_status`, `restart_daemon`, `pending_dialog` |
| **Files** (1) | upload | `upload_file` |
| **Events** (1) | inspect | `drain_events` |
| **Skills** (5) | self-learning | `list_skills`, `read_skill`, `write_skill`, `record_failure`, `attach_helper` |

Full schemas live in `packages/brisk-mcp/src/tools/`. The MCP server's
`tools/list` is the source of truth.

### Calling tools

```jsonc
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "click_at_xy",
    "arguments": {"x": 120, "y": 340, "button": "left", "clicks": 1}
  }
}
```

```jsonc
// Successful response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{"type": "text", "text": "{\"ok\": true}"}],
    "isError": false
  }
}
```

```jsonc
// Failure (Brisk surfaces structured errors as text + isError:true)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {"type": "text", "text": "{\"code\":\"CDP_NOT_CONNECTED\",\"message\":\"...\"}"}
    ],
    "isError": true
  }
}
```

Errors in the **transport** layer use standard JSON-RPC codes
(-32600 / -32601 / -32602). Brisk's domain errors are always returned
as a `tools/call` result with `isError: true` and structured JSON in
the `text` content.

### Brisk error codes

| Code | Meaning |
|---|---|
| `CDP_NOT_CONNECTED` | Daemon hasn't attached to a Chrome session yet |
| `CDP_TIMEOUT` | A CDP call exceeded its budget |
| `CDP_PROTOCOL_ERROR` | CDP returned an error response |
| `INVALID_ARGS` | Zod validation failed on the call args |
| `DOM_NODE_NOT_FOUND` | Selector returned nothing |
| `NETWORK_ERROR` | http_get / network probe failed |
| `SKILL_DB_ERROR` | SQLite write failed |
| `SKILL_NOT_FOUND` | Read a non-existent skill |
| `INTERNAL` | Programmer error; please file |

## Resources

`resources/list` returns three families. Each resource has a URI under
`mcp://brisk/`.

| URI prefix | What | Use case |
|---|---|---|
| `mcp://brisk/interaction/<name>` | Static interaction-skill markdown | Default agent prompt context |
| `mcp://brisk/domain-skill/<id>` | Dynamic per-domain skills from SQLite | Site-specific knowledge |
| `mcp://brisk/failure/<id>` | Dynamic failure records | Debugging the agent's own failures |

`resources/read {uri}` returns the markdown content. Resources have
`mimeType: text/markdown`.

### Resource templates

The dynamic resources are exposed as templates. To list, the client
sends:

```jsonc
{
  "method": "resources/list",
  "params": {"cursor": null}
}
```

Brisk returns up to 100 resources at a time with a pagination cursor.
Templates support filtering via the standard `uri` matching.

## Transports

### stdio

```bash
brisk serve --transport stdio
```

- One process per MCP client.
- Daemon embedded in the same process — no separate `brisk daemon start`
  needed.
- `console.log` is redirected to stderr to avoid contaminating the
  JSON-RPC stream.
- Termination: SIGINT or stdin close.

### Streamable HTTP

```bash
brisk serve --transport http --host 127.0.0.1 --port 9100
```

- POST `/mcp` — request/response.
- GET `/mcp` — Server-Sent Events stream (push notifications, future).
- Defaults to `127.0.0.1` (localhost only). Exposing the transport on a
  non-loopback interface requires both `--host <address>` and
  `--allow-remote`. **Only do this on a trusted network**; Brisk has no
  auth in V0.1.0.
- Browser-origin requests are gated by an exact Origin allow-list. The
  default list is loopback only (`http://localhost`, `http://127.0.0.1`,
  `http://[::1]`); non-browser clients without an Origin header are allowed.
- Multiple clients can connect to the same HTTP server simultaneously.
  They share the same Chrome session.

### Why both?

- **stdio**: zero-config for desktop apps. The client spawns Brisk;
  Brisk dies when the client closes.
- **HTTP**: persistent. Survives client restarts. Allows multiple
  clients (e.g. Cursor + Continue + custom script). Required for
  containerized clients that can't spawn child processes.

## Compatibility matrix

Tested against:

| Client | Transport | Brisk Version |
|---|---|---|
| Claude Desktop 1.0.6+ | stdio | ✓ |
| Cursor 0.42+ | stdio + http | ✓ |
| Cline 3.x | stdio | ✓ |
| Continue 1.0+ | http | ✓ |
| Claude Code (CLI) | stdio | ✓ |
| ChatGPT Desktop 1.x | stdio | ✓ |
| Generic JSON-RPC 2.0 + MCP 2025-06-18 | both | should work |

Untested but expected to work: Codex, Aider's MCP support, Goose, custom
scripts using the official `@modelcontextprotocol/sdk` client.

## Version negotiation

Brisk requires `protocolVersion: "2025-06-18"`. Older or newer values
in the client's `initialize` request return:

```jsonc
{"error": {"code": -32602, "message": "unsupported protocolVersion"}}
```

When the spec next revs (likely 2026-06 cycle), Brisk will add
compatibility shims and document them here.

## Wire-format examples

### Streamable HTTP request

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:9100
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"page_info","arguments":{}}}
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"info\":{\"url\":\"https://...\",\"title\":\"...\",\"w\":1280,\"h\":800}}"}],"isError":false}}
```

### stdio request (newline-delimited JSON-RPC)

```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"page_info","arguments":{}}}\n
```

stdio responses are also newline-delimited, one JSON object per line.

## Method support matrix

| Method | Implemented | Notes |
|---|---|---|
| `initialize` | ✓ | |
| `initialized` | ✓ | (notification) |
| `tools/list` | ✓ | |
| `tools/call` | ✓ | |
| `resources/list` | ✓ | paginated |
| `resources/read` | ✓ | |
| `resources/templates/list` | ✓ | |
| `resources/subscribe` | — | V0.1.1 |
| `resources/unsubscribe` | — | V0.1.1 |
| `prompts/list` | — | not used |
| `prompts/get` | — | not used |
| `sampling/createMessage` | — | not used |
| `logging/setLevel` | — | future |
| `ping` | ✓ | |
| `completion/complete` | — | not used |

The `—` rows return a JSON-RPC `-32601 Method not found`.

## Schema source of truth

The TypeScript schemas backing each tool live in
`packages/brisk-mcp/src/tools/`. They are Zod schemas; the MCP server
converts them to JSON Schema via `zod-to-json-schema` and serves them
through `tools/list`.

When in doubt: ask the server. `brisk serve --transport stdio` plus a
client that prints `tools/list` is the canonical reference.
