---
title: Print as PDF
tags: [pdf, print, save]
---

# Print as PDF

`Page.printToPDF` renders the current page to a PDF via Chrome's print
pipeline. Different from a navigated `.pdf` download — this is the
"File → Print → Save as PDF" path.

## Basic call

```text
cdp {method: "Page.printToPDF"}
→ {data: "<base64 PDF>"}
```

The PDF bytes return base64-encoded. Decode and write to disk
client-side; Brisk doesn't ship a typed wrapper because params change
year-over-year and most users want the full surface.

## Options that actually matter

| Param | Default | When to override |
|---|---|---|
| `printBackground` | `false` | Set `true` when CSS backgrounds matter (most marketing pages) |
| `displayHeaderFooter` | `false` | Set `true` only if you want page numbers / dates |
| `headerTemplate` / `footerTemplate` | empty | HTML template; use `<span class=pageNumber>` etc. |
| `paperWidth` / `paperHeight` | 8.5 × 11 inches | Pass A4 (8.27 × 11.69), Letter (8.5 × 11), or custom |
| `marginTop` / etc. | 0.4 in | Set to `0` for edge-to-edge |
| `preferCSSPageSize` | `false` | `true` when the page uses `@page { size: A4 }` |
| `landscape` | `false` | Trivial — switch w/h |
| `scale` | 1.0 | 0.1 to 2.0; 0.8 fits "1.2 page" content onto one page |
| `pageRanges` | "" (all) | "1-3,5,7-" for specific pages |
| `transferMode` | `ReturnAsBase64` | Set to `ReturnAsStream` for very large PDFs (Chrome 87+) |

Full set:

```text
cdp {method: "Page.printToPDF", params: {
  printBackground: true,
  paperWidth: 8.27,
  paperHeight: 11.69,
  marginTop: 0.5,
  marginBottom: 0.5,
  marginLeft: 0.5,
  marginRight: 0.5,
  scale: 1.0,
  landscape: false,
  preferCSSPageSize: false
}}
```

## Wait before printing

PDF is captured as the page is RIGHT NOW. Lazy-loaded images, fonts
still loading, animations in mid-frame — all bake into the output.

```text
1. goto / new_tab
2. wait_for_load {state: "networkidle"}
3. js {expression: "document.fonts.ready"}   # wait for web fonts
4. wait {durationMs: 250}                    # animations settle
5. cdp Page.printToPDF
```

For SPAs that defer rendering with `requestIdleCallback`, add an
explicit `wait_for_element` on a known content node before printing.

## Print media query

By default `printToPDF` emulates `media: "print"` — the page sees
itself in print mode. To force screen mode (so all CSS renders as on
screen), set the emulation first:

```text
cdp {method: "Emulation.setEmulatedMedia", params: {media: "screen"}}
cdp {method: "Page.printToPDF"}
cdp {method: "Emulation.setEmulatedMedia", params: {media: ""}}   # reset
```

## Multi-page screenshot vs PDF

If you only need the visual content (not the PDF structure / select-text /
search), `capture_screenshot {fullPage: true}` is faster and gives you
a PNG. Reserve PDF for documents you intend to share or archive.

## Encoding

```text
1. Get base64 from `Page.printToPDF`
2. js {expression: `window.__pdf_b64__ = '<base64>'`} (if you want it in page)
   OR decode in the harness process and write to a file via Node fs
```

Brisk doesn't auto-write — the harness deliberately stays out of the
local file system on behalf of the agent. Decode client-side.

## Memory considerations

PDFs of long pages (10,000+ rows of a data table) routinely exceed
50 MB base64. CDP doesn't chunk the response. For these cases:

- Use `pageRanges` to split into multiple calls.
- Or set `transferMode: "ReturnAsStream"`, then `IO.read` the stream.

```text
cdp Page.printToPDF {transferMode: "ReturnAsStream"} → {stream: "<handle>"}
loop:
  cdp IO.read {handle: "<handle>", size: 65536} → {data: "<base64-chunk>", eof: false}
cdp IO.close {handle: "<handle>"}
```

The stream API is the only path for PDFs > 100 MB.
