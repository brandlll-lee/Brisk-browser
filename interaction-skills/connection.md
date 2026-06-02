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
# 1. Start Chrome with remote debugging enabled
chrome --remote-debugging-port=9222 --user-data-dir=$BRISK_PROFILE

# 2. Start the Brisk daemon (or let brisk serve do it lazily)
brisk daemon start
```

Inside an agent session:

```text
1. connection_status  → confirm the WS is up + sessionId is set
2. list_tabs          → see what's open
3. ensure_real_tab    → guarantee we're on a navigable page
4. capture_screenshot → verify visually
```

## Discovery cascade

The daemon resolves the CDP WebSocket URL in this order:

1. `BRISK_CDP_WS` environment variable (full `ws://…/devtools/browser/<id>` URL).
2. `BRISK_CDP_URL` environment variable (HTTP base URL — `/json/version` is queried).
3. `--remote-debugging-port` discovered via the 27 standard Chrome /
   Edge / Brave / Vivaldi profile paths' `DevToolsActivePort` file.
4. Probe `http://localhost:{9222,9223,9000}` for a JSON Version response.

If none succeed, the daemon emits `CDP_DISCOVERY_FAILED` — there's no
running browser, or the port is firewalled. Tell the user to start
Chrome with `--remote-debugging-port=9222`.

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
