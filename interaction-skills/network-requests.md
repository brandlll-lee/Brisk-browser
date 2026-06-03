---
title: Network Requests
tags: [network, xhr, fetch, intercept]
---

# Network Requests

CDP's `Network` domain exposes every HTTP call the page makes. Brisk
keeps the domain `enable`d by default, so events accumulate in the
buffer accessible via `drain_events`.

## Observe

```text
drain_events
→ [{method: "Network.requestWillBeSent", params: {...}}, {method: "Network.responseReceived", ...}, ...]
```

Useful events:

| Event | When | Key fields |
|---|---|---|
| `Network.requestWillBeSent` | before request goes out | `request.url`, `request.method`, `request.headers`, `request.postData` |
| `Network.responseReceived` | response headers received | `response.status`, `response.headers`, `response.mimeType` |
| `Network.loadingFinished` | full body received | `encodedDataLength`, `requestId` |
| `Network.loadingFailed` | request errored | `errorText`, `canceled`, `blockedReason` |
| `Network.requestServedFromCache` | served from disk cache | `requestId` only |
| `Network.webSocketCreated` | WS opened | `url` |

Filter in user code:

```text
drain_events
→ filter where method === "Network.responseReceived" && params.response.status >= 400
```

## Fetch response bodies

Bodies aren't in the event stream — CDP would balloon the wire. Pull
them on demand:

```text
cdp {method: "Network.getResponseBody", params: {requestId: "<from event>"}}
→ {body: "...", base64Encoded: false}
```

Bodies are GC'd ~5-10 seconds after `loadingFinished`. Fetch eagerly if
you need them.

## Intercept (block / mock / redirect)

Brisk doesn't ship typed interceptors — use `cdp` directly. The flow:

```text
1. Enable: cdp {method: "Fetch.enable", params: {patterns: [{urlPattern: "*api/*"}]}}
2. Wait for: drain_events → Fetch.requestPaused event with {requestId, request}
3. Respond:
   - Continue: cdp {method: "Fetch.continueRequest", params: {requestId}}
   - Mock:     cdp {method: "Fetch.fulfillRequest", params: {requestId, responseCode: 200, body: <base64>}}
   - Block:    cdp {method: "Fetch.failRequest", params: {requestId, errorReason: "BlockedByClient"}}
4. Disable: cdp {method: "Fetch.disable"}
```

**Don't leave `Fetch.enable` on forever** — every request waits for the
agent loop to call continue/fail, which slows down the page to your
react time.

## Bulk patterns

For "scrape all JSON API responses on a page" without intercept:

```text
1. Navigate
2. wait_for_network_idle
3. drain_events
4. for each Network.responseReceived where mimeType contains "json":
     cdp Network.getResponseBody {requestId}
     parse
```

This is read-only and doesn't slow the page.

For product pages such as Amazon, prefer DOM extraction first:

```text
1. new_tab "https://www.amazon.com/dp/<ASIN>"
2. wait_for_load
3. wait 2
4. js extract title / price / rating from stable selectors
```

Use network body capture only when the page visibly loads data from a
JSON API that is easier to parse than the rendered DOM. If a CAPTCHA or
anti-bot page appears, stop and notify the user; do not try to bypass it.

## CORS / preflight

OPTIONS preflight requests show up as `requestWillBeSent` with
`request.method: "OPTIONS"`. They have their own `requestId` separate
from the actual POST/PUT. If a request seems to "disappear" it's often
because the preflight was blocked.

## Cookies on requests

Cookies attached by the browser show in `requestWillBeSent.request.headers`
but only with `Network.enable {extraInfo: true}`. By default Chrome
hides cookies in the event payload. Brisk enables `extraInfo` so the
agent sees the full picture:

```text
drain_events
→ Network.requestWillBeSentExtraInfo {headers: {cookie: "..."}}
```

## ServiceWorker traffic

Calls intercepted by a ServiceWorker show as `Network.requestServedFromCache`
with `Fetch.handledByServiceWorker: true`. The actual upstream request
the SW makes is also visible — same `Network` domain, different
`requestId`.
