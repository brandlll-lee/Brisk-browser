---
title: Connection & Tab Visibility
tags: [connection, daemon, startup]
---

# Connection & Tab Visibility

## The omnibox-popup trap

When Chrome boots, the only CDP `type: "page"` targets are often
`chrome://inspect` and `chrome://omnibox-popup.top-chrome/`
(a 1px invisible viewport). If Brisk attaches to the omnibox popup,
every subsequent screenshot looks empty and clicks land on nothing.

The daemon's `ensure_real_tab` runs the same heuristics as
browser-harness:

1. Skip targets whose `url` matches the blocklist patterns:
   `chrome://omnibox-popup.top-chrome/`, `devtools://`,
   `chrome://newtab-takeover/...`, `view-source:`.
2. Prefer targets whose `type === "page"` and whose URL is `http(s)`
   or `about:blank` *and* has a navigable history.
3. If nothing qualifies, create `about:blank` via
   `Target.createTarget` and attach to that.

Call `ensure_real_tab` whenever `page_info` returns
`{kind: "background"}` (i.e. the current target is a service-worker or
omnibox popup).

## Startup sequence

```bash
# Way 1: use the user's current browser (recommended for interactive work)
# Open this in Chrome once and tick the remote-debugging checkbox:
chrome://inspect/#remote-debugging

# Then start the MCP server. It attaches to the existing browser.
brisk serve --transport stdio
```

Way 2 is the fallback for unattended, CI, or headless work:

```bash
brisk chrome --port 9222
brisk serve --transport stdio --cdp-port 9222
```

Inside an agent session:

```text
1. connection_status  → confirm the WS is up + sessionId is set
2. list_tabs          → see what's open
3. ensure_real_tab    → guarantee we're on a navigable page
4. capture_screenshot → verify visually
```

## Discovery cascade

CLI flags are most explicit. Without CLI flags, Brisk resolves the CDP
WebSocket URL in this order:

1. `BRISK_CDP_WS` environment variable (full `ws://…/devtools/browser/<id>` URL).
2. `BRISK_CDP_URL` environment variable (HTTP base URL — `/json/version` is queried).
3. `DevToolsActivePort` files from standard Chrome / Edge / Brave profile paths,
   plus any paths in `BRISK_PROFILE_DIRS`.
4. Probe loopback ports `9222` and `9223` for a JSON Version response.

If none succeed, the daemon emits `CDP_DISCOVERY_FAILED` — there's no
running browser, or remote debugging is not enabled. Run `brisk doctor`;
if Chrome is already running, it points the user to
`chrome://inspect/#remote-debugging` and tries to open it.

## Restarting after Chrome reload

If Chrome reloads (extension install, profile switch, crash), the CDP
WebSocket disconnects. The daemon auto-reconnects with backoff
(`100ms → 200ms → 400ms → 800ms → 1.6s`, capped at 8 attempts).
While it's reconnecting, tool calls return `CDP_NOT_CONNECTED`. Two
choices:

- **Wait + retry** — usually 1–2 seconds is enough.
- **Force restart** — call `restart_daemon` to tear down everything
  and re-attach to the first real tab.

`connection_status` always shows the current state; check it whenever
something feels stale.
