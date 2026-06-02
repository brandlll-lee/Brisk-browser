---
title: Iframes (same-origin + OOPIF)
tags: [iframe, oopif, cross-origin]
---

# Iframes

There are **two kinds** of iframes from CDP's perspective:

1. **Same-origin iframes** live in the parent page's process. The
   parent's `js` context can reach them via `window.frames[i]` /
   `document.querySelector('iframe').contentDocument`. CDP's
   `DOM.querySelector` traverses them when `pierce: true`.
2. **Cross-origin iframes (OOPIF)** live in a *separate Chrome process*
   and have their own CDP target with `type: "iframe"`. You **must**
   create a new session for them via `Target.attachToTarget`.

## Coordinate clicks are free

Brisk's default `click_at_xy` dispatches a `Input.dispatchMouseEvent`
at the browser-process level, which hit-tests against the compositor.
The compositor sees the visual tree (iframes, shadow DOM, cross-origin
all flattened), so the click lands on the right element regardless of
whether the target is in an OOPIF.

This means: **don't go fishing for the iframe target unless you need
to read its DOM or run JS inside it.**

## When you actually need the iframe target

If a coordinate click doesn't work (the iframe is hidden, you need to
read text, you need to dispatch keys into a Monaco editor), grab the
OOPIF session:

```text
iframe_target {selector: "iframe#editor"}
# → returns {targetId, sessionId} for the iframe's CDP target
```

Then issue tool calls with that `sessionId`:

```text
js {expression: "document.querySelector('.monaco-editor').textContent", sessionId: "<from iframe_target>"}
dom {selector: ".monaco-editor", sessionId: "<from iframe_target>"}
dispatch_key {text: "console.log(1)", sessionId: "<from iframe_target>"}
```

For same-origin iframes, `iframe_target` returns the **parent**'s
session (because that's where the DOM lives) — you can skip the
helper entirely and just use `js("document.querySelector('iframe').contentDocument...")`
in the main session.

## Detecting cross-origin vs same-origin

`iframe_target` distinguishes them. If the returned `sessionId` is
**different** from your current session, you're talking to an OOPIF.
If it's the same, you're in same-origin territory and can stay in the
parent.

```text
iframe_target {selector: "iframe[name=payment]"}
→ {targetId: "...", sessionId: "different-from-current"}   # OOPIF
→ {targetId: "...", sessionId: "same-as-current"}          # same-origin
```

## Shadow DOM inside iframes

`DOM.querySelector` with `pierce: true` will *only* pierce shadow DOM
inside the **same** target. Iframes are a target boundary; you need
to attach to the iframe target first, then pierce inside it.

## Common iframe traps

- **Azure portal blades** — each blade is an iframe. `click_at_xy`
  works for buttons; `iframe_target` is needed to read input values.
- **Salesforce Lightning** — Aura iframes are same-origin in Lightning,
  cross-origin in Classic. `iframe_target` tells you which.
- **Stripe Checkout** — payment input is an OOPIF. You can click into
  the field with `click_at_xy`, but you have to type via
  `dispatch_key` with the OOPIF's `sessionId`.
- **Sandbox-allow=none** — some iframes block all CDP attachments.
  Falls back to coordinate clicks only.
