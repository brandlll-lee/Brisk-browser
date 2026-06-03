# Brisk Interaction Skills

General-purpose browser interaction patterns — **not site-specific**.
These docs are bundled with Brisk and exposed as MCP **resources** (URI
`mcp://brisk/interaction/<name>`) so any connected agent can `resources/list`
and `resources/read` to learn how the harness behaves around common edge
cases (iframes, shadow DOM, file uploads, popup dialogs, etc).

Compare with `agent-workspace/domain-skills/` which is **agent-owned** and
**site-specific**. Interaction skills are tool-agnostic; domain skills
encode "GitHub's star button is a controlled React input, use form.submit".

## Files

The interaction skills are:

| File | Owner | Topic |
|---|---|---|
| `connection.md` | W1 | Way 1 vs Way 2, CDP discovery, troubleshooting |
| `screenshots.md` | W1 | max_dim heuristics, base64 vs path, retina |
| `tabs.md` | W1 | Target lifecycle, omnibox-popup trap, new_tab race |
| `dialogs.md` | W1 | alert/confirm/prompt handling, beforeunload |
| `iframes.md` | W5 | Same-origin traversal, cross-origin attach |
| `scrolling.md` | W5 | window vs container vs virtualized lists |
| `dropdowns.md` | W5 | Native select vs ARIA combobox vs custom overlay |
| `cookies.md` | W5 | Network.setCookie, scoping, secure flag |
| `shadow-dom.md` | W5 | Recursive shadowRoot traversal |
| `uploads.md` | W5 | DOM.setFileInputFiles, drag-drop alternative |
| `network-requests.md` | W5 | Network domain events, request body capture |
| `downloads.md` | W5 | Page.setDownloadBehavior |
| `drag-and-drop.md` | W5 | Coordinate-based, native HTML5 vs CDP |
| `cross-origin-iframes.md` | W5 | OOPIF targetId attach |
| `print-as-pdf.md` | W5 | Page.printToPDF options |
| `viewport.md` | W5 | Emulation.setDeviceMetricsOverride |
| `profile-sync.md` | V0.1.1 | Cookie / extension / bookmark sync (deferred) |
