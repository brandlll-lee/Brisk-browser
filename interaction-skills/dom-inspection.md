---
title: DOM Inspection
tags: [dom, querySelector, observation]
---

# DOM Inspection

`dom` wraps three CDP methods:

| Call | What it returns |
|---|---|
| `dom {}`                              | `DOM.getDocument` — root node, depth 2, pierce on |
| `dom {selector}`                      | `DOM.querySelector` from the root + describeNode |
| `dom {selector, depth: 4, pierce: false}` | finer control |

`pierce` defaults to **true** — that traverses shadow DOM and
same-origin iframes. Set `pierce: false` when you specifically need
to stay inside the light tree.

## When to use `dom` vs `js`

| Use `dom` when… | Use `js` when… |
|---|---|
| You want a stable `nodeId` (to feed into `DOM.scrollIntoViewIfNeeded`, `DOM.focus`, etc) | You want a value (textContent, value, attribute) |
| You're testing element existence (selector returns 0 nodeId → not in tree) | You want to compute something across multiple nodes |
| You need bounding-box metadata via subsequent `DOM.getBoxModel` | You want to fire a custom event or mutate state |

`dom` is **read-only**. To mutate, drop down to `js` or `cdpRaw`.

## Reading attributes

```text
dom {selector: "form#login input[name=email]"}
→ {nodeId: 42, tree: {nodeType: 1, localName: "input", attributes: ["type", "email", "name", "email", "required", ""], ...}}
```

CDP's attribute format is a flat `["k1", "v1", "k2", "v2", ...]`
array. Brisk passes it through verbatim because that's what `cdp` /
`Runtime.callFunctionOn` expects. To pretty-print:

```javascript
const attrs = Object.fromEntries(tree.attributes.reduce((acc, _, i, a) => i % 2 === 0 ? [...acc, [a[i], a[i+1]]] : acc, []));
```

## Shadow DOM

With `pierce: true`, shadow roots appear as `shadowRoots: [...]` in
the tree, with each entry having its own `nodeId` you can query
further. Walk recursively.

```text
dom {selector: "host-element", pierce: true}
→ {nodeId, tree: {shadowRoots: [{nodeId: 99, children: [...]}]}}
```

## Searching the whole DOM

CDP also has `DOM.performSearch` (faster than walking) — but Brisk
doesn't wrap it because the result format requires a follow-up
`DOM.getSearchResults` call. Use raw `cdp` if you need it:

```text
cdp {method: "DOM.performSearch", params: {query: "button"}}
cdp {method: "DOM.getSearchResults", params: {searchId: "...", fromIndex: 0, toIndex: 100}}
cdp {method: "DOM.discardSearchResults", params: {searchId: "..."}}
```

## Speed

`dom` is fast (≈10ms locally) because it bypasses the V8 isolate.
`js` is slower (≈30ms) because it goes through the runtime. For pure
inspection, `dom` is the right call.

## When `dom` returns `nodeId: null`

The selector matched zero elements *or* the element is in a target
the current session can't see (most often: an OOPIF). Either:

- Switch to the iframe target via `iframe_target`, retry.
- Use `js` with a `getElementsByClassName` / `querySelector` you can
  fall back to — sometimes Chrome's CSS engine is faster than CDP's.
