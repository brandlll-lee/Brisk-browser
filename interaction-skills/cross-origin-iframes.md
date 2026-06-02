---
title: Cross-Origin Iframes (OOPIF)
tags: [iframe, oopif, cross-origin]
---

# Cross-Origin Iframes (OOPIF)

A cross-origin iframe lives in a **different Chrome renderer process**
from the parent page. That has two consequences:

1. `js` / `dom` / `dispatch_key` in the parent session **cannot reach
   inside** the iframe.
2. The iframe has its own CDP target with `type: "iframe"`. You attach
   to it explicitly to interact with its DOM.

See `iframes.md` for the same-origin case (no separate process,
parent's session is enough).

## Detecting an OOPIF

```text
iframe_target {selector: "iframe[name=payment]"}
→ {targetId: "stripe-uuid", sessionId: "different-from-current"}
```

If the returned `sessionId` differs from `connection_status.sessionId`,
you're talking to an OOPIF.

## Driving an OOPIF

Once you have the iframe's sessionId, every helper that takes a
`sessionId` argument can target it:

```text
js     {expression: "document.querySelector('input').value", sessionId: "<oopif>"}
dom    {selector: ".paid-button", sessionId: "<oopif>"}
dispatch_key {text: "4242 4242 4242 4242", sessionId: "<oopif>"}
```

Note **not** the action helpers — `click_at_xy` and `scroll` use
compositor-level dispatch which already handles cross-origin. Only use
the iframe sessionId for DOM/Runtime-level work.

## Common OOPIF sites

| Site | Why OOPIF |
|---|---|
| Stripe Checkout | Card input isolated for PCI compliance |
| Google Sign-In button | OAuth confidentiality |
| YouTube embeds | Separate process for ad isolation |
| Salesforce Classic (some blades) | Cross-origin shells in lightning |
| Embed.ly / Sharetribe widgets | Generic embed CSP separation |
| Auth0 / Okta widgets | Token security boundary |

## OOPIF + screenshot

`capture_screenshot` from the parent shows the OOPIF rendered (because
the compositor composes both processes). The pixel coordinates inside
the iframe are still in the parent's coordinate space. `click_at_xy` on
those pixels also lands correctly. The only thing you can't do with
parent-process tools is read or mutate the iframe's DOM.

## OOPIF + cookies

OOPIFs run under the iframe's origin's cookie jar. Setting a cookie on
the parent's origin doesn't help. To seed an OOPIF session:

```text
cdp Network.setCookie {url: "https://iframe.origin", name, value, ...}
```

Brisk's `cdp` tool is browser-scoped — sessionId isn't required for
`Network.setCookie`.

## Console logs and OOPIFs

Console output from an OOPIF lands on the **OOPIF's session**, not the
parent. The `ConsoleCollector` watches both, but each event is tagged
with its `sessionId`:

```text
get_console_logs {sessionId: "<oopif>"}
→ entries scoped to the iframe
get_console_logs   (no sessionId)
→ aggregates across all sessions the daemon has touched
```

## Detach and re-attach

If the iframe navigates (e.g. Stripe redirects to 3DS), the targetId
changes. `iframe_target` re-resolves on every call, so re-calling it
between actions is cheap insurance.

```text
1. iframe_target {selector: "iframe[name=stripe]"} → s1
2. dispatch_key {sessionId: s1, text: "4242..."}
3. click_at_xy on submit (parent coord)
4. wait_for_load
5. iframe_target {selector: "iframe[name=stripe]"} → s2 (DIFFERENT after redirect)
6. js {sessionId: s2, expression: "document.querySelector('input.otp').value"}
```

## OOPIF inside OOPIF

Yes — common in ad networks. `iframe_target` resolves one level at a
time. You may need to recurse:

```text
iframe_target {selector: "iframe.ad-frame"} → s_ad
# Inside s_ad, query for nested iframe via raw CDP:
cdp Target.getTargets   # find children of s_ad
```

V0.1.0 surfaces one level; deeper trees need raw CDP for now.
