---
title: Tabs
tags: [tabs, navigation, target-lifecycle]
---

# Tabs

A Brisk "tab" is a CDP target of type `page`. The daemon tracks one
active session at a time (the page it's attached to). Switching tabs
means detaching from the old `sessionId` and attaching to a new one.

## Listing

```text
list_tabs                       → [{targetId, title, url, active}]
list_tabs {includeAll: true}    → also includes background pages, OOPIFs, service workers
```

The `active` flag marks the tab Brisk is currently attached to —
**not** the tab that has focus in Chrome's UI. To bring a tab to front
in Chrome too, use `switch_tab` (it calls `Target.activateTarget`).

## Creating

`new_tab(url)` is the safe path for navigation — it creates a fresh
`Target.createTarget`, then attaches, then waits for the navigation
to land. Compare with `goto_url(url)` which navigates the *current*
tab and clobbers whatever the user was looking at.

```text
new_tab {url: "https://example.com"}   → fresh tab, attached, ready
goto_url {url: "https://example.com"}  → reuses current tab
```

## The mark emoji

Once Brisk attaches to a tab, the daemon paints a horse emoji
(`🐴`) into the document title via `Runtime.evaluate`. This is the
**TAB_MARKER** — it lets the user spot at a glance which tab the agent
is driving when Chrome shows many tabs. Removing it is automatic on
detach.

## Closing

`close_tab` calls `Target.closeTarget` and, if the closed tab was the
active session, auto-attaches to the next real tab via
`ensure_real_tab`. You don't need to clean up the session yourself.

```text
close_tab {targetId: "ABC123"}  → tab gone, daemon reattaches if needed
```

## Common pitfalls

- **Race on new_tab + screenshot** — `new_tab` waits for
  `Page.loadEventFired`, but JS-heavy SPAs hide content until
  `requestIdleCallback`. Follow up with
  `wait_for_load {state: "networkidle"}` if the screenshot looks empty.

- **Wrong tab after extension navigation** — extensions sometimes
  open a popup tab that becomes active. Always call `list_tabs`
  + `ensure_real_tab` after an action that *might* have spawned a tab.

- **Closed tab leaves stale events** — events buffered for a closed
  target are dropped silently. Drain events *before* closing if you
  need them.
