---
title: Dialogs
tags: [dialog, alert, confirm, prompt, beforeunload]
---

# Dialogs

Browser dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) freeze
the JavaScript thread. The page's event loop is paused until the
dialog is dismissed. That has cascading consequences:

- `capture_screenshot` still works (rendering is on a different
  thread).
- `js`, `dom`, `wait_for_*` will **time out** — the JS context is
  blocked.
- The user's typing in Chrome's actual dialog is **not** observed by
  the daemon; we always intercept via CDP.

## Detect

```text
page_info  → returns {kind: "dialog", dialog: {type, message, defaultPrompt?, url}}
pending_dialog  → returns the same dialog object, or null
```

If you see `{kind: "dialog"}`, *do nothing else* until you handle it.

## Dismiss

Use the raw `cdp` tool — there's no first-class helper because we
want the agent to be explicit about accept vs cancel and to read the
message before answering. The page is frozen anyway.

```text
cdp {method: "Page.handleJavaScriptDialog", params: {accept: true}}
cdp {method: "Page.handleJavaScriptDialog", params: {accept: false}}
cdp {method: "Page.handleJavaScriptDialog", params: {accept: true, promptText: "value"}}  # for prompt()
```

After dismissal, `pending_dialog` returns `null` and the page
resumes. Verify with another `capture_screenshot`.

## Prevent (stub before triggering)

When you expect a sequence of `alert`/`confirm` calls (e.g. unsaved
changes warnings on a form), it's cheaper to stub them once via
`js` than to dismiss each one:

```javascript
window.__brisk_dialogs__ = [];
window.alert = (m) => window.__brisk_dialogs__.push({type: 'alert', message: String(m)});
window.confirm = (m) => { window.__brisk_dialogs__.push({type: 'confirm', message: String(m)}); return true; };
window.prompt = (m, d) => { window.__brisk_dialogs__.push({type: 'prompt', message: String(m), default: d}); return d || ''; };
```

Then read `window.__brisk_dialogs__` via `js` to recover what was
suppressed. This is *not* undetectable — sites can check
`alert.toString().includes('[native code]')`. For anti-bot-sensitive
sites prefer the reactive `Page.handleJavaScriptDialog` route.

## beforeunload

`beforeunload` dialogs surface when navigating away from a page with
unsaved state (e.g. a form). Accept = navigate, cancel = stay. Brisk
auto-dismisses `beforeunload` on `close_tab` (otherwise the close
would hang) but never auto-handles `alert` / `confirm` / `prompt`.
