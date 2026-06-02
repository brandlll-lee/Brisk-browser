---
title: Dropdowns
tags: [dropdown, select, combobox, aria]
---

# Dropdowns

Four flavours, four strategies. Identify which kind you're facing
before picking a tactic.

| Flavour | Looks like | Best strategy |
|---|---|---|
| **Native select** | `<select><option>…</option></select>` | `select_option` helper |
| **Custom overlay** | Click triggers a `<div>` portal with list items | Coordinate click on the option |
| **ARIA combobox** | `<input role=combobox>` + popup `<ul role=listbox>` | Type, then click suggestion |
| **Virtualised list** | Scroll to find option (only some visible) | Loop scroll + screenshot until target |

## Native select

```text
select_option {selector: "select#country", value: "JP"}
select_option {selector: "select#country", label: "Japan"}
select_option {selector: "select#country", index: 87}
```

CDP path: `DOM.querySelector` → `Runtime.callFunctionOn` to set the
`value` and fire `change`. Brisk auto-fires both `input` and `change`
events; some React selects only listen for `change`, some for `input` —
firing both is cheap and avoids guessing.

## Custom overlay

These look like Material-UI's `<Select>`, Headless UI's `<Listbox>`,
Radix UI's `<Select>`. The control is one component, the option list
is a sibling portal (often appended to `<body>`).

```text
1. click_at_xy on the trigger button (gets the popup open)
2. capture_screenshot
3. click_at_xy on the option (read coords from screenshot)
4. capture_screenshot to verify
```

**Pitfall:** the option list often animates in. If you click before
it's fully open, the click lands on whatever's underneath. Either
`wait {durationMs: 200}` or look at `getComputedStyle().opacity`.

**Pitfall:** the popup is in a portal — `dom {selector: '.menu .option'}`
might fail if the menu CSS isn't a descendant of the control's parent.
Pierce with `pierce: true` or just use coordinate clicks.

## ARIA combobox (autocomplete)

```text
1. click_at_xy on the input
2. type_text {text: "japa"}
3. wait_for_element {selector: "[role=option][aria-selected=true]"}
4. press_key {key: "Enter"}
```

`Enter` selects the focused option. Avoid `click_at_xy` on the dropdown
list — keyboard is more reliable because the highlighted option is
deterministic from `aria-activedescendant`. Coordinate clicks can race
with hover-on-focus.

If `Enter` doesn't fire selection, the combobox is probably listening
for `mousedown` on items instead — fall back to coordinate clicks.

## Virtualised list

`react-window` / `tanstack-virtual` render only the visible 10-20
options. Scrolling the list keeps the option count constant but the
content changes.

```text
1. Open the dropdown
2. capture_screenshot — find the scroll container; note its x/y center
3. Loop:
   a. Check screenshot for target text
   b. If absent: scroll {x, y, deltaY: 200}; wait {durationMs: 100}
   c. If found: click_at_xy on it
   d. If scrollTop hasn't changed for 2 iterations: bail (we're at the bottom)
```

For very long lists (1000+ items), if the dropdown has a search input,
type instead of scroll.

## Identifying which flavour

Read the trigger's DOM:

```text
dom {selector: "the trigger"}
```

- `localName: "select"` → native
- `localName: "input"` + `role="combobox"` → combobox
- `localName: "button"` or `div` with `role="combobox"` → overlay or
  custom; click and inspect the popup.

When in doubt, take a screenshot before and after a click. Native
selects open a system menu (which CDP doesn't see); custom overlays
render in the DOM (which screenshots capture).
