---
title: Drag and Drop
tags: [drag, drop, dnd, mouse]
---

# Drag and Drop

Three protocols share the "drag and drop" name. Identify which one the
target page uses before you write a click sequence.

| Protocol | Signal | Brisk strategy |
|---|---|---|
| **Native HTML5 DnD** | `draggable="true"` + `ondragstart` | Coordinate-based mouse sequence (this doc) |
| **Pointer / mouse-only DnD** | `onmousedown` + `onmousemove` + `onmouseup` (no `dragstart`) | Same coordinate sequence works |
| **File drop** | `ondrop` on a zone, no drag source on the page | Synthetic `DataTransfer` (see `uploads.md`) |

## The mouse sequence

A real drag is **three** mouse events with movement in between:

```text
1. mouse down at source (x_a, y_a)
2. mouse move toward target — one or more intermediate points
3. mouse up at target (x_b, y_b)
```

Direct `cdp` sequence:

```text
cdp Input.dispatchMouseEvent {type: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1}
cdp Input.dispatchMouseEvent {type: "mouseMoved", x: 150, y: 230, button: "left"}
cdp Input.dispatchMouseEvent {type: "mouseMoved", x: 200, y: 260, button: "left"}
cdp Input.dispatchMouseEvent {type: "mouseMoved", x: 300, y: 300, button: "left"}
cdp Input.dispatchMouseEvent {type: "mouseReleased", x: 300, y: 300, button: "left", clickCount: 1}
```

**Why multiple `mouseMoved`:** some DnD libraries (react-dnd, dnd-kit)
have a `dragThreshold` (typically 4-8 px). They won't fire `dragstart`
until the cursor has moved at least that distance. A single jump from
press to release looks like a click.

## Why no `drag_to` helper

Brisk deliberately doesn't ship `drag_from_to(x_a, y_a, x_b, y_b)` —
sites vary too much in what they expect:

- Some need `mouseover` on each waypoint (overlay highlighting)
- Some need a real delay between events (`Input.dispatchMouseEvent`'s
  default frame timing is "as fast as possible")
- Some need `Input.dispatchDragEvent` (HTML5 explicit drag API)

Write the sequence inline so the LLM can adjust per-site.

## Native HTML5 DnD

For pages that use `draggable="true"`, the coordinate sequence above
generally works because Chrome synthesises `dragstart`/`dragover`/`drop`
events from mouse moves on draggables. But some sites listen for
custom events. If the coordinate sequence doesn't trigger the drop,
fall back to synthesising the events directly:

```javascript
const source = document.querySelector('.draggable');
const target = document.querySelector('.dropzone');
const dt = new DataTransfer();

source.dispatchEvent(new DragEvent('dragstart', {dataTransfer: dt, bubbles: true}));
target.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true}));
target.dispatchEvent(new DragEvent('dragover',  {dataTransfer: dt, bubbles: true}));
target.dispatchEvent(new DragEvent('drop',      {dataTransfer: dt, bubbles: true}));
source.dispatchEvent(new DragEvent('dragend',   {dataTransfer: dt, bubbles: true}));
```

Caveat: `event.isTrusted: false`. Sites checking trust will reject.

## react-dnd / dnd-kit

These libraries dominate React DnD in 2026. Both use the pointer events
API (`onMouseDown` listener on the source). Coordinate sequence works
reliably. Make sure to:

- Hit the **drag handle**, not the card body (some cards have a small
  grip icon as the only draggable region).
- Include at least 3 `mouseMoved` events spanning > 8px from press.
- End with `mouseReleased` exactly on the target (not "near" — some
  drop zones have small hit-test regions).

## Sortable lists (re-ordering)

Drop indicator usually appears between items. Your `y` coordinate
should target the gap line, not the center of a neighbouring item.
Read the layout via `dom` first to get exact positions.

## Verifying

After a successful drop:

- The source element moves to the target's position (visual screenshot)
- The page emits a state-change event (check `get_console_logs`)
- The DOM mutates (`dom` shows reordered children)

If none of these change, the drop didn't register — try a longer drag
path or fall back to synthetic `DragEvent`s.
