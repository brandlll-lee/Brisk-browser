---
title: Scrolling
tags: [scroll, viewport, virtualised-lists]
---

# Scrolling

`scroll` dispatches `Input.dispatchMouseEvent` for `mouseWheel` — the
same path the user's actual scroll wheel takes. That works for:

- The window itself.
- Native scroll containers (`overflow: auto/scroll` divs).
- iframes that share the parent target's compositor.

## The three modes

```text
scroll {deltaY: 600}              → scroll the window down 600px
scroll {x: 800, y: 400, deltaY: 300}  → scroll the container under (800,400) down 300px
scroll {deltaX: 200}              → horizontal scroll
```

Coordinates default to the viewport center. Pass `x, y` when you want
to scroll a specific container (e.g. a chat-history pane on the side).

## Smooth scrolling and JS

`scroll` is **instant**. If the page uses `scroll-behavior: smooth` or
JS-driven inertia, the visible movement may differ from the dispatched
delta. Always follow up with `capture_screenshot` or
`pageInfo` to verify position before continuing.

For programmatic precision (e.g. "scroll element X into view") prefer
the `dom` + CDP combo:

```text
dom {selector: "#section-7"}
cdp {method: "DOM.scrollIntoViewIfNeeded", params: {nodeId: <from dom>}}
```

That bypasses the wheel entirely and is guaranteed pixel-perfect.

## Virtualised lists

Frameworks like react-window / TanStack Virtual render only the
visible window. A naive `scroll {deltaY: 5000}` falls off the
rendered region and the next item isn't in the DOM. Workarounds:

- Scroll in small steps (`deltaY: 400`), screenshot after each, until
  the target appears.
- Use the framework's own API if you can reach the parent scroller
  (e.g. `js("document.querySelector('.virtualised').scrollTop = 5000")`)
  — but that often skips DOM hydration callbacks; verify.

## "Below the fold" pattern

To find an off-screen target:

```text
1. capture_screenshot                 → snapshot current viewport
2. js {expression: "document.body.scrollHeight"} → total page height
3. scroll {deltaY: 800}               → step down
4. capture_screenshot                 → check for target
5. ... loop until target visible or scrollTop ≈ scrollHeight
```

Don't use `fullPage: true` screenshots for this — they're slower and
on long pages can exceed the LLM image size limit.

## Container detection

If you don't know which container scrolls, `dom` it under the cursor
and look at the `overflowY` style:

```text
js {expression: "(()=>{const el = document.elementFromPoint(800, 400); while(el){if (getComputedStyle(el).overflowY === 'auto' || getComputedStyle(el).overflowY === 'scroll') return el.id || el.className; el = el.parentElement;}})()"}
```
