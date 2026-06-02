---
title: Downloads
tags: [download, file, browser]
---

# Downloads

Browser downloads (the kind that pop a save-dialog or land in
`~/Downloads`) are governed by `Page.setDownloadBehavior`. CDP routes
them via the browser process, not the renderer.

## Set the download path

```text
cdp {method: "Browser.setDownloadBehavior", params: {
  behavior: "allow",
  downloadPath: "C:/Brisk/downloads",
  eventsEnabled: true
}}
```

- `behavior: "allow"` — files saved to `downloadPath`
- `behavior: "default"` — Chrome's default (asks the user)
- `behavior: "deny"` — cancel all downloads
- `behavior: "allowAndName"` — Chrome 110+; downloads named by `guid`

`eventsEnabled: true` is required to receive `Browser.downloadWillBegin`
and `Browser.downloadProgress` events on the daemon's event stream.

**Browser-scoped vs Page-scoped:** `Browser.setDownloadBehavior` (note:
`Browser`, not `Page`) sets it for every page in every context. Use
`Page.setDownloadBehavior` (deprecated since M118 but still works) for
just the attached session.

## Observe progress

```text
drain_events
→ Browser.downloadWillBegin {guid, suggestedFilename, url}
→ Browser.downloadProgress {guid, totalBytes, receivedBytes, state: "inProgress"}
→ Browser.downloadProgress {guid, totalBytes, receivedBytes, state: "completed"}
```

States: `"inProgress"`, `"completed"`, `"canceled"`. The filename on
disk is `<guid>` when `behavior: "allowAndName"`, otherwise the
`suggestedFilename`. Watch out for collisions if the suggested name
repeats — Chrome appends `(1)`, `(2)`, etc.

## Verify completion

```text
1. Click the download trigger (button/link)
2. wait until drain_events has a downloadProgress with state === "completed"
3. Read the file from disk using `node:fs` (out of band — Brisk doesn't expose this)
```

Or for "did SOMETHING download in the last N seconds?":

```text
1. List ~/Downloads before action
2. Trigger
3. Loop: list again, look for new file with mtime > start time
4. Time out after 30s
```

## Direct URL downloads — prefer `http_get`

If the download is just `<a href="...">` with `download` attribute,
the URL is hot. `http_get {url}` is faster than spawning a browser
download — bypasses the disk entirely.

```text
http_get {url: "https://example.com/report.csv"}
→ {text: "...,...,...\n", contentType: "text/csv", bytes: 12340}
```

**Limit:** `http_get` has a `maxLength` (default ~5 MB) and is plain
HTTP — no JS, no cookies attached unless you pass them in `headers`.
For authenticated downloads behind login, you need the browser path.

## Authenticated downloads through the browser

If the download requires a session cookie:

1. The browser already has the cookie (you navigated/logged in earlier).
2. Trigger the download via `click_at_xy` on the button.
3. `setDownloadBehavior {behavior: "allow"}` is already on (you set it
   at session start).
4. Watch `drain_events` until `state: "completed"`.

Don't try to extract cookies and replay them via `http_get` —
`SameSite=Strict` or token-bound auth will reject the replay. The
browser is the right tool.

## "Save Page As" PDFs

That's `Page.printToPDF` — see `print-as-pdf.md`. It's a different
mechanism (renderer-side) from a navigated PDF download.

## Cleanup

Browser downloads don't auto-clean. If you spawned a fresh
`--user-data-dir` for the session, `rm -rf $userDataDir/Downloads`
after teardown.
