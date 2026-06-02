---
title: Console Logs
tags: [console, debugging, runtime, log]
---

# Console Logs

`get_console_logs` returns three classes of events buffered by the
daemon since the last `clear: true` (or since the session started):

1. **`console`** — every `console.log`, `console.warn`, `console.error`
   call from the page. Source: `Runtime.consoleAPICalled`.
2. **`exception`** — uncaught exceptions and unhandled promise
   rejections. Source: `Runtime.exceptionThrown`.
3. **`browser`** — entries logged by the browser itself (CSP violations,
   deprecated API warnings). Source: `Log.entryAdded`.

The collector is wired in the daemon's `attach` step — every domain
gets `Runtime.enable`, `Log.enable`, and a frame-navigated listener
that clears stale entries for the previous URL.

## Reading

```text
get_console_logs                          → all entries since last clear
get_console_logs {level: "error"}         → only errors
get_console_logs {search: "CORS"}         → text-match
get_console_logs {limit: 20}              → last 20
get_console_logs {clear: true}            → fetch + reset
```

`level` defaults to `info` (which means *info + warning + error*).
Set explicitly to `error` when you only care about failures.

## Verifying actions via console

Common pattern: after an action that *should* have triggered a
console message (e.g. a debug log on form submit), check:

```text
1. js {expression: "document.querySelector('form').submit()"}
2. wait_for_load {timeoutMs: 5000}
3. get_console_logs {search: "submit", level: "info"}
```

If no entry appears, the submit didn't fire — bail to the next plan.

## Capturing exceptions from injected JS

Errors thrown inside `js` calls bubble up as **tool errors**, not
console entries. But errors in *async* code (e.g. a `fetch` you
spawned) land in the console:

```text
js {expression: "fetch('/api').then(r => r.json()).then(d => console.log(d.id))"}
sleep 1
get_console_logs {search: "id"}
```

## Frame navigation flushes browser-log entries

CDP's `Log.entryAdded` is per-page, not per-frame. When the page
navigates, the daemon doesn't auto-clear console entries (so you can
see what happened before the redirect). Use `clear: true` after a
deliberate navigation to start fresh.

## Limits

- The collector buffers up to **1000 entries per session** (FIFO). If
  you blow past that, oldest entries are dropped. Set `limit` to
  the size you actually care about.
- Strings longer than ~10KB are truncated by Chrome before CDP emits
  them — known quirk; not Brisk's choice.
- `console.table` and other rich console types are serialised as
  text. For structured logging, pipe through JSON.stringify in the
  page itself.
