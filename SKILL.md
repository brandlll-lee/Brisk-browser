---
name: brisk
description: Direct browser control via CDP using the Brisk MCP server. 37 tools for observation, interaction, navigation, waits, network, file uploads, and skill self-learning. Connects to the user's Chrome or to one launched by `brisk chrome`.
---

# Brisk — agent skill description

Brisk is the **muscle**. You — the agent — are the brain. Brisk gives
you 37 MCP tools to drive Chrome at the CDP layer. Read this skill
once at task start; it tells you what's reachable.

## What's available

You can call any of these tools via `tools/call`:

### Observation (6)

| Tool | What it does |
|---|---|
| `page_info` | URL, title, viewport, scroll, page size. Always cheap. |
| `capture_screenshot` | PNG. Default trims to 1800px max dim. Pass `fullPage: true` for whole-document. |
| `dom` | Query the DOM with a CSS selector. Pierces shadow roots by default. |
| `get_console_logs` | Stream of `console.log/warn/error` + page exceptions since last drain. |
| `drain_events` | Raw CDP events (Network, Page, Runtime). Read once, gone. |
| `connection_status` | Is daemon attached? Useful before doing anything heavy. |

### Interaction (8)

| Tool | What it does |
|---|---|
| `click_at_xy` | Mouse click at pixel coordinates. **Default action.** |
| `hover_at_xy` | Mouse move (no press). For revealing hover states. |
| `type_text` | Type into the focused element. |
| `fill_input` | Click + clear + type, with a selector. |
| `press_key` | Send a key (`Enter`, `Tab`, etc.) with modifiers. |
| `scroll` | Wheel scroll at coordinates or by amount. |
| `select_option` | Set a native `<select>` value. |
| `dispatch_key` | Send a keyboard event without typing focus. |

### Navigation (8)

`goto_url`, `list_tabs`, `current_tab`, `switch_tab`, `new_tab`,
`close_tab`, `ensure_real_tab`, `iframe_target`.

### Waits (3)

`wait`, `wait_for_load`, `wait_for_element`.

### Network (2)

| Tool | What it does |
|---|---|
| `http_get` | Bypass the browser entirely. Fetch a URL with raw HTTP. **Use for bulk scraping**. |
| `cdp` | Raw CDP passthrough — call any DevTools Protocol method. |

### Admin (3)

`pending_dialog`, `restart_daemon`, plus `connection_status` from above.

### Files (1)

`upload_file` — set files on an `<input type=file>` via
`DOM.setFileInputFiles`. Hidden inputs work fine.

### Skills (5)

| Tool | What it does |
|---|---|
| `list_skills` | All skills the agent has written, optionally filtered. |
| `read_skill` | Read one skill by id. |
| `write_skill` | Persist new domain knowledge as markdown. **Call when you discover something non-obvious.** |
| `record_failure` | Log "I tried X and it didn't work + why". Helps future you. |
| `attach_helper` | Register a small JS helper in the agent workspace. |

## How to think about Brisk

1. **Screenshots first**: `capture_screenshot` to understand the page;
   read the pixels yourself to find targets; `click_at_xy` to act.
   Don't reach for `dom` unless the screenshot doesn't tell you what
   you need to know.
2. **`new_tab` for the first navigation**, not `goto_url`. `goto_url`
   navigates the current tab, which may be the user's work tab.
3. **`wait_for_load` after navigation**. CDP doesn't auto-block.
4. **`http_get` for bulk static content**. The browser is for stateful
   pages; `http_get` is ~100× faster for plain HTML / JSON / CSV.
5. **Iframes and shadow DOM**: click coordinates pass through both at
   the compositor. Don't try to traverse manually unless you need to
   inspect/mutate.
6. **Authentication**: do NOT type passwords from screenshots. Stop
   and ask the user.
7. **Skills**: when something works after you struggled, write a
   `write_skill` so next time you (or another agent) skip the struggle.

## Resources (read-only context)

Brisk exposes three families of MCP resources via `resources/list` /
`resources/read`:

- **`mcp://brisk/interaction/<name>`** — 19 interaction-skill markdown
  files covering general browser mechanics (iframes, cookies,
  dropdowns, etc.). Worth reading on first encounter.
- **`mcp://brisk/domain-skill/<id>`** — your previously-written
  domain skills. List them when you start a task on a known site.
- **`mcp://brisk/failure/<id>`** — your previous failure records. Look
  here when something is failing the same way again.

## What Brisk does NOT do

- Brisk doesn't run the agent loop. *You* call tools.
- Brisk doesn't decide what tab to use. *You* call `new_tab` or
  `switch_tab`.
- Brisk doesn't synthesize skills from failures. *You* call
  `record_failure` and `write_skill`.
- Brisk doesn't manage the connection. If `connection_status` returns
  `disconnected`, call `restart_daemon`.
- Brisk doesn't handle dialogs. If `page_info` reports a pending
  dialog, decide and call the appropriate CDP method
  (`Page.handleJavaScriptDialog`) yourself via `cdp`.

## Errors

Every tool returns a `Result`. On failure, `isError: true` and
`content[0].text` is structured JSON like:

```jsonc
{"code": "DOM_NODE_NOT_FOUND", "message": "...", "details": {...}}
```

Standard codes: `CDP_NOT_CONNECTED`, `CDP_TIMEOUT`, `INVALID_ARGS`,
`DOM_NODE_NOT_FOUND`, `NETWORK_ERROR`, `SKILL_DB_ERROR`,
`SKILL_NOT_FOUND`, `INTERNAL`.

When you get an error, consider whether it's worth `record_failure`-ing
for your future self.

## Cookies and auth

If the site requires login, two paths:

1. **The user is logged in to their everyday Chrome.** Use Way 1
   (`chrome://inspect/#remote-debugging` is ticked). Cookies are
   already there.
2. **Fresh isolated profile.** No cookies. Either ask the user to log
   in (and they'll see Brisk operate after) or use `cdp` +
   `Network.setCookie` if you have token strings.

Don't get clever about this. Wrong cookies → cascading auth failures.

## When to give up

If you've tried 3 distinct approaches and none works:

1. Call `capture_screenshot` and `get_console_logs`.
2. Call `record_failure` with what you tried and the error patterns.
3. Tell the user what you observed and why you stopped.

Better one good failure record than ten attempts that drift.
