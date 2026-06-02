---
title: Viewport
tags: [viewport, emulation, mobile, retina]
---

# Viewport

The viewport defines what the page sees as `innerWidth` / `innerHeight`
and what gets composited into screenshots. By default it matches the OS
window. `Emulation.setDeviceMetricsOverride` lets you change it without
resizing any window.

## Resize for capture

```text
cdp {method: "Emulation.setDeviceMetricsOverride", params: {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false
}}
```

The page now sees `1280×800`. Subsequent screenshots and clicks use
these dimensions. Reset with:

```text
cdp {method: "Emulation.clearDeviceMetricsOverride"}
```

## DevicePixelRatio (retina)

`deviceScaleFactor: 2` simulates a retina display. The page sees the
same CSS dimensions (`1280×800`), but the rendered backing buffer is
`2560×1600`. Screenshots are PNG at the backing size — useful for
high-DPI captures but doubles the byte cost.

To verify what the page thinks it's on:

```text
js {expression: "window.devicePixelRatio"}
```

## Mobile emulation

```text
cdp {method: "Emulation.setDeviceMetricsOverride", params: {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844
}}

cdp {method: "Emulation.setUserAgentOverride", params: {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ..."
}}

cdp {method: "Emulation.setTouchEmulationEnabled", params: {enabled: true}}
```

The three together (`metrics`, `userAgent`, `touchEmulation`) form
"iPhone 15" emulation. Chrome's DevTools "Device Mode" sends all three
plus `Emulation.setOrientationOverride` and `Network.emulateNetworkConditions`.

For a one-shot screenshot of "what does this look like on mobile?",
these three are enough.

## Common viewport sizes

| Device | Width | Height | DPR | UA hint |
|---|---|---|---|---|
| iPhone SE | 375 | 667 | 2 | iPhone |
| iPhone 15 | 390 | 844 | 3 | iPhone |
| iPad | 768 | 1024 | 2 | iPad |
| MacBook (default) | 1280 | 800 | 2 | Mac |
| Desktop 1080p | 1920 | 1080 | 1 | — |
| Desktop 4K | 3840 | 2160 | 2 (or 1) | — |

## Reading the current viewport

```text
page_info → {info: {w, h, sx, sy, pw, ph}}
                      ^  ^  ^^  ^^  ^^  ^^
                      |  |  |   |   |   document.documentElement.scrollHeight
                      |  |  |   |   document.documentElement.scrollWidth
                      |  |  |   scrollY
                      |  |  scrollX
                      |  innerHeight
                      innerWidth
```

`w/h` are CSS pixels. `pw/ph` are the total page extent — useful for
"do I need to scroll to find X?".

## Element bounding box

```text
dom {selector: "#section-2"}
→ {nodeId: 42, tree: {...}}

cdp DOM.getBoxModel {nodeId: 42}
→ {model: {content: [x1,y1, x2,y1, x2,y2, x1,y2], width, height, ...}}
```

`content` is a quad — four corner coordinates in CSS pixels relative
to the document. To click the visual center:

```text
center_x = (x1 + x2) / 2
center_y = (y1 + y2) / 2
# then if scrolled: subtract scrollX/scrollY for viewport-relative click
click_at_xy {x: center_x - sx, y: center_y - sy}
```

`Element.scrollIntoViewIfNeeded` is simpler when the goal is just "make
sure it's in view, then click":

```text
cdp DOM.scrollIntoViewIfNeeded {nodeId: 42}
click_at_xy {x: center_x_in_viewport, y: center_y_in_viewport}
```

## Print emulation

Per `print-as-pdf.md`, `setEmulatedMedia: "print"` changes how CSS
renders. That includes the viewport — `@page` rules take over the
dimensions. To preview a print layout on screen:

```text
cdp Emulation.setEmulatedMedia {media: "print"}
capture_screenshot
cdp Emulation.setEmulatedMedia {media: ""}
```

## Dark mode emulation

```text
cdp Emulation.setEmulatedMedia {media: "screen", features: [{name: "prefers-color-scheme", value: "dark"}]}
```

Useful for "does the dark-mode banner show correctly?" without
toggling OS settings.
