# Chromium Embedding Contract (V0.3 preview)

**Status: DESIGN DOCUMENT. Implementation in V0.3 (estimated Q4 2026).**

This document is the interface contract between Brisk V0.1.0 (the
external "harness" model) and Brisk V0.3 (the "embedded" model where
Brisk runs as a `chrome::browser_process::*` service inside a forked
Chromium build).

The goal: V0.3 should change one thing only — how the CDP connection
is established. Every tool, every helper, every MCP resource is
identical.

## Today (V0.1.0): External harness

```
+----------+      WebSocket          +-------------+
| Brisk    | ◀──────────────────────▶| Chrome /    |
| daemon   | ws://localhost:9222/... | Chromium    |
+----------+                         +-------------+
```

The user runs Chrome with `--remote-debugging-port=9222`. Brisk
discovers the endpoint and connects via `ws` (Node `ws` library). All
CDP traffic crosses a TCP localhost socket.

Pros: works with any Chromium-family browser, no compile needed.
Cons: depends on the user enabling debug, popup confirmations on
Chrome 144+, 1-2 ms per CDP call over loopback.

## V0.3 (target): Embedded service

```
+----------+    in-process IPC    +-------------+
| Brisk    | ◀───────────────────▶| Chromium    |
| service  |  (mojo channel)      | (forked)    |
+----------+                       +-------------+
```

A forked Chromium build embeds Brisk as a service in the browser
process. CDP traffic stays in-process via a mojo channel (or a unix
pipe shared between threads). No popups, no port-discovery dance, no
external WebSocket.

This is the model **BrowserOS** uses, see their reference at
`references/BrowserOS/packages/browseros/chromium_patches/chrome/browser/browseros/server/browseros_server_manager.cc`.

## What's invariant

Code on the helper / MCP / tool side **must not change** when V0.3
ships. This means:

### 1. `CdpBackend` interface

```typescript
export interface CdpBackend {
  send<M extends string, P, R>(method: M, params: P, opts?: SendOptions): Promise<R>;
  on<E extends string>(event: E, handler: (params: unknown) => void): Unsubscribe;
  attachToTarget(targetId: string, flatten?: boolean): Promise<string>;
  detachFromTarget(sessionId: string): Promise<void>;
  isConnected(): boolean;
  close(): Promise<void>;
}
```

V0.1.0 implementation: `WebSocketCdpBackend`. V0.3 adds:
`InProcessCdpBackend` that satisfies the same interface but uses a
mojo `Receiver` instead of a `WebSocket`.

The helper layer accepts a `CdpBackend` — it doesn't care which is
underneath.

### 2. CDP wire format

All CDP messages stay the same JSON shape:

```jsonc
// request
{"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}, "sessionId": "ABCD"}
// response
{"id": 1, "result": {"data": "..."}, "sessionId": "ABCD"}
// event
{"method": "Page.frameNavigated", "params": {...}, "sessionId": "ABCD"}
```

V0.3 may add fields, but not remove or rename. New fields are
optional and ignored by V0.1.0 helpers.

### 3. Lifecycle hooks

```typescript
export interface BackendLifecycle {
  onConnect: (info: ConnectionInfo) => void;
  onDisconnect: (reason: DisconnectReason) => void;
  onReconnect: (info: ConnectionInfo) => void;
}
```

V0.3's `InProcessCdpBackend` fires `onConnect` once at boot, never
fires `onDisconnect` (the renderer is in the same process), never
fires `onReconnect`. Helpers handle this gracefully — they don't
assume reconnects happen.

### 4. Discovery

The discovery layer (`@brisk/core/cdp/discovery.ts`) is replaceable:

```typescript
export async function discoverCdpEndpoint(opts: DiscoveryOptions): Promise<CdpEndpoint> {
  // V0.1.0: scans ports + reads DevToolsActivePort + checks env vars
  // V0.3:   returns an "in-process" endpoint with no URL
}
```

V0.3 will register a different `discoverCdpEndpoint` implementation
at startup; everything downstream sees the same `CdpEndpoint` shape.

### 5. IPC

In V0.3, the `@brisk/ipc` Unix socket / named pipe daemon is **gone**.
Brisk runs as a Chromium service; there's no second process. MCP
clients connect to the browser's HTTP port instead.

Code that uses `@brisk/ipc` (the CLI's `brisk daemon` commands) is
V0.1.0-specific. It will be removed cleanly in V0.3.

## What changes

### Build pipeline

V0.3 requires a Chromium fork. Brisk source is compiled as part of
the Chromium build via a `BUILD.gn` target:

```python
# chrome/browser/brisk/BUILD.gn (preview)
source_set("brisk_service") {
  sources = [
    "brisk_service_manager.cc",
    "brisk_service_manager.h",
    "brisk_mcp_server.cc",
    "brisk_mcp_server.h",
  ]
  deps = [
    "//base",
    "//chrome/browser",
    "//content/public/browser",
    "//services/network/public/mojom",
  ]
}
```

The Brisk TypeScript code is built to a single `brisk-service.js`
bundle, embedded as a resource, and run inside a `v8::Isolate` owned
by the browser process.

Alternative: keep the Node.js process external but spawned by
Chromium at boot. That's what BrowserOS does; simpler, less elegant.
V0.3 design will compare both options.

### Installation

V0.3 ships as a Chromium build — `.dmg` on macOS, `.exe`/`.msi` on
Windows, `.deb`/`.AppImage` on Linux. No `npm install`.

V0.1.0's npm-installed `brisk` CLI becomes a thin command-line that
talks to the embedded service via HTTP/MCP.

### Performance

| Operation | V0.1.0 (WebSocket) | V0.3 (in-process) |
|---|---|---|
| Single CDP call | 1-2 ms | < 100 µs |
| `captureScreenshot` | 30-50 ms (network + encoding) | 10-15 ms (encoding only) |
| `goto + screenshot + click + screenshot` | 600-800 ms | 200-400 ms |
| Reconnect after Chrome restart | 2-5 s | N/A (no reconnect) |

Numbers from the BrowserOS reference. Brisk should land in the same
ballpark.

## Migration plan

V0.1.x → V0.2.x: no Chromium fork. Add AI Agent brain on top of the
external harness model. Tests, tools, MCP layer all stable.

V0.2.x → V0.3.0: fork Chromium 152 (or whatever LTS is at the time).
Add the `brisk_service_manager.cc` glue. Move `@brisk/ipc` to a
legacy package. Build for three platforms.

V0.3.0 → V0.4.0: ship UI features (AI tab strip, natural-language
address bar, integrated chat). Now we're a real browser.

## Why this contract matters now

Without this document, V0.1.0 implementors could lean on
WebSocket-specific assumptions (e.g. "the CDP connection can drop, so
add retries everywhere") that V0.3 would have to undo. By writing
down the abstractions explicitly, V0.1.0 stays portable.

Concrete rules every helper in `@brisk/core/helpers/` must follow:

1. **Take `HelperContext`, not `WebSocketCdpBackend`.** The context
   has a `cdp: CdpBackend`; the implementation is opaque.
2. **Don't assume reconnection.** Helpers should fail loudly if CDP
   is unavailable, not retry forever. The Daemon's reconnect logic
   sits *above* helpers, not in them.
3. **Don't peek at the WebSocket.** No accessing internal state, no
   inspecting buffer sizes, no calling `socket.ping()`. Use the
   `keepalive` exposed via `CdpBackend.send('Browser.getVersion')`.
4. **Don't assume localhost.** Even in V0.1.0, the user might
   `--cdp-url` to a remote browser. URL inspection should pass
   through the discovery layer.

Helpers that follow these rules work unchanged in V0.3.

## Reference: BrowserOS's approach

BrowserOS's `chromium_patches/chrome/browser/browseros/server/browseros_server_manager.cc`
is the closest existing analogue. Read it carefully when V0.3 starts.

Key takeaways:

- They spawn a Node.js subprocess at browser launch (`browseros_server.exe`).
- The subprocess does the actual MCP server work; the embedded code
  is just a launcher + IPC bridge.
- CDP traffic still uses the standard CDP WebSocket on a
  browser-internal port — they didn't go fully in-process.

Brisk V0.3 might do the same (spawn `brisk-service` subprocess from
the embedded launcher), or might go further in-process. Decision
point at V0.3 kickoff.

## Open questions for V0.3

| Question | When to decide |
|---|---|
| Embed Node or use V8 directly? | V0.3 kickoff |
| Which Chromium LTS to fork? | After Chrome 152 stable |
| Distribute as a separate browser, or as a Chrome extension? | After V0.2.0 user feedback |
| AGPL vs MIT for the fork? | V0.3 kickoff (legal) |
| Cross-platform packaging strategy? | V0.3 kickoff |

These are deferred to V0.3 planning. V0.1.0 commits to none of them.
