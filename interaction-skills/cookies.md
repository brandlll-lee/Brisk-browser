---
title: Cookies
tags: [cookies, network, auth]
---

# Cookies

Cookies live in the browser process, not in the page. Reading them via
`document.cookie` is limited to non-`HttpOnly` cookies on the current
origin — useless for auth tokens. Always go through CDP.

In Way 1, Brisk is attached to the user's everyday Chrome profile. That
means the browser's existing login cookies are already available; prefer
using that state over exporting or injecting cookies manually.

## Read

```text
cdp {method: "Network.getAllCookies"}
→ {cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite, ...}]}

cdp {method: "Network.getCookies", params: {urls: ["https://example.com"]}}
→ filtered to cookies that would be sent to that URL
```

`Network.getAllCookies` returns the entire browser cookie jar — every
profile, every domain. `Network.getCookies` filters by URLs and respects
`SameSite` / `Secure` / path / domain rules.

Do not print full cookie values into chat unless the user explicitly
asks. For normal extraction tasks, only report cookie domain/count
metadata if you need to confirm whether a session exists.

## Write

```text
cdp {method: "Network.setCookie", params: {
  name: "session",
  value: "abc123",
  domain: ".example.com",
  path: "/",
  expires: 1893456000,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  url: "https://example.com"
}}
```

Brisk doesn't ship a typed wrapper because the parameter space is large
(11 fields including `priority`, `sameParty`, `sourceScheme`, `sourcePort`,
`partitionKey`) and most agents only need 2-3. Use the raw `cdp` tool.

**Pitfall:** `domain` is `.example.com` (leading dot for subdomain
match) per RFC 6265. Some CDP versions also accept `example.com` and
make it apex-only; if a cookie isn't sent on a subdomain you wrote it
to, that's why.

## Delete

```text
cdp {method: "Network.deleteCookies", params: {name: "session", url: "https://example.com"}}
```

Or clear everything:

```text
cdp {method: "Network.clearBrowserCookies"}
```

The latter wipes the entire profile — don't run it casually on the
user's own Chrome.

## Sync from a saved JSON

If you're seeding an agent with a previously-captured cookie jar:

```text
1. Read the JSON
2. for each cookie: cdp Network.setCookie {...spread fields, url}
3. Reload the page or navigate to trigger them
```

`Network.setCookies` (note the plural) accepts an array — one round
trip instead of N:

```text
cdp {method: "Network.setCookies", params: {cookies: [{name, value, ...}, ...]}}
```

## SameSite, Secure, partition

Modern Chrome enforces:

- **`Secure`** — cookie only sent on HTTPS. Setting `secure: true` on a
  `http://localhost` URL silently fails. Use `secure: false` for local
  dev origins.
- **`SameSite`** — `"Strict"` / `"Lax"` (default in Chrome 80+) /
  `"None"` (requires `Secure: true`).
- **CHIPS partitioning** (Chrome 114+) — partitioned cookies require
  `partitionKey: {topLevelSite: "https://parent.example", hasCrossSiteAncestor: false}`.

If a third-party cookie isn't sticking, it's almost always one of these
three.

## Cookies vs page state

Setting a cookie does NOT log the user in by itself — most apps cache
auth state in JS / localStorage at boot. After setting cookies, navigate
or reload (`Page.reload` or `goto`) so the page picks them up.
