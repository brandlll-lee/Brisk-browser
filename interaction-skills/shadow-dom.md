---
title: Shadow DOM
tags: [shadow-dom, web-components, pierce]
---

# Shadow DOM

Web Components and many design systems (Salesforce Lightning, GitHub
Catalyst, Dyson's site) hide their internals inside shadow roots.
`document.querySelector` does not pierce shadow roots — you'll get
`null` for elements that visibly exist on the page.

## Two modes

```javascript
element.attachShadow({mode: 'open'})   // accessible via element.shadowRoot
element.attachShadow({mode: 'closed'}) // shadowRoot is null even to JS
```

CDP can pierce **both** open and closed shadow roots — it works at a
layer below the JS visibility check.

## Brisk's `dom` helper auto-pierces

```text
dom {selector: ".inside-shadow"}
→ pierce: true by default; CDP traverses shadow roots
```

Use `dom` (not `js`) when you suspect a shadow root. The returned
`tree` includes a `shadowRoots: [...]` field on each shadow host.

## Manual JS traversal (when you need to compose with other JS)

```javascript
function querySelectorDeep(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    if (host.shadowRoot) {
      const found = querySelectorDeep(host.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

querySelectorDeep(document, 'input[name=password]');
```

Brisk doesn't ship a built-in traversal — encode the helper inline so
the LLM sees what it's doing.

## Coordinate clicks pierce for free

`click_at_xy` dispatches at the compositor; hit-testing sees the
visible tree, which already includes flattened shadow content. So if
all you need is to click a button inside a shadow root, **just click
the pixel coordinate**. No traversal required.

## CSS in shadow roots

Selectors in shadow roots are scoped: `::part(name)` and `::slotted()`
are the cross-boundary hooks. For coverage screenshots / visual
verification, none of this matters — the rendered pixels are flat.
For functional automation (focus, dispatch, attribute mutate), you
have to be inside the root.

## Form elements inside shadow DOM

A `<input>` inside a shadow root **is** submitted with the host form
only if the web component participates in form-associated custom
elements (FACE). Otherwise the host form sees no value. When typing
into a shadow-DOM input doesn't seem to "stick", the host form is
probably reading from somewhere else (e.g. a controlled React state
shadowing the input).

Diagnose with `dom {selector: "host-element", pierce: true}` to find
the input, then check whether its value matches the controlled state
visible in the parent's React fiber.

## Detection one-liner

To check if a page uses shadow DOM:

```javascript
js {expression: "Array.from(document.querySelectorAll('*')).some(el => el.shadowRoot)"}
```

Returns `true` if any open shadow root exists. (Closed shadow roots
return `null` from `.shadowRoot`, so this misses them — `dom` still
sees them via CDP.)

## Iframes vs shadow roots

Iframes are heavier — separate documents, separate origins potentially,
own URL. Shadow roots are still the same document; cookies / location /
history are shared with the host. If you see `iframe` in the markup,
treat it like an iframe (see `iframes.md`). Anything else is shadow DOM.
