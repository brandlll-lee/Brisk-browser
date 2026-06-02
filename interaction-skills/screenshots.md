---
title: Screenshots
tags: [screenshot, observation]
---

# Screenshots

`capture_screenshot` returns the raw bytes of a PNG (default) or JPEG
encoded by the browser via `Page.captureScreenshot`. Brisk packs them
into MCP `image` content parts — no temp file, no extra round-trip.

That has two consequences agents should internalise:

1. **Click coordinates are CSS pixels, not image pixels.**
   On a 2× display a 1920×1080 CSS viewport produces a 3840×2160 PNG.
   If you read a target off the bitmap, divide x/y by
   `devicePixelRatio` (use `js("window.devicePixelRatio")`) before
   passing them to `click_at_xy`. Better: use proportions
   (`x_ratio * inner_width`).

2. **Some LLMs reject images > 2000 px per side.**
   For long sessions on 2× displays, pass a `clip` to capture only
   the relevant region:

   ```json
   {"clip": {"x": 0, "y": 0, "width": 1280, "height": 800, "scale": 1}}
   ```

   Brisk does not downscale automatically — it ships the raw bytes,
   pixel-perfect, so the agent can decide on a per-call basis whether
   to crop or to allocate the context.

## fullPage

`fullPage: true` calls `Page.captureScreenshot` with
`captureBeyondViewport: true`. Useful for "see everything below the
fold", but the screenshot can easily exceed 30 MB on a long docs page.
Prefer viewport-only screenshots followed by `scroll` + another shot.

## format

`jpeg` with `quality: 60` typically shrinks the payload 5–10×. Use it
when you're just verifying "did the click land?". For text-heavy
pages stay on PNG so OCR-ish workflows don't suffer.

## When the screenshot is wrong

If the screenshot doesn't look like what the user expects:

- Call `page_info` — confirm the URL and viewport match expectations.
- Call `connection_status` — make sure you're attached to a *page*
  target, not a service-worker.
- Call `ensure_real_tab` — the daemon may have attached to an invisible
  omnibox popup.
- Call `capture_screenshot` again with `fromSurface: true` — captures
  from the GPU surface; helps when the renderer is occluded.
