/**
 * Input primitives — mouse / keyboard / form-fill.
 *
 * Nine helpers: clickAtXY, typeText, fillInput, pressKey, scroll,
 * dispatchKey, uploadFile, hoverAtXY, selectOption. Mirrors
 * browser-harness helpers.py:179-262, 450-466 + adds hoverAtXY +
 * selectOption (commonly needed by LLMs but missing from the Python
 * harness).
 *
 * Implementation notes from the BrowserOS / browser-harness retros:
 *   • `type_text` uses `Input.insertText` which bypasses framework
 *     input event listeners. Use `fillInput` for React / Vue / Ember.
 *   • `press_key` for single chars also emits a `char` event so
 *     listeners that check `e.keyCode` still fire.
 *   • Ctrl/Cmd+A "select all" MUST be dispatched as `rawKeyDown` (NOT
 *     `keyDown`) because `keyDown` always emits a `char` for single
 *     printable keys, and Chrome treats that char as a literal "a"
 *     instead of running the shortcut. See browser-harness
 *     helpers.py:228-234 for the full rant.
 */

import { briskError, err, ok } from '@brisk/types';

import { runCdp } from './_internal.js';
import { js } from './observation.js';
import type { HelperContext, HelperResult } from './types.js';

// ─── Common: modifier bitfield ───────────────────────────────────────

/** CDP `Input.dispatchKeyEvent` modifier bitfield. */
export const MODS = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
} as const;

const IS_DARWIN = process.platform === 'darwin';

// ─── clickAtXY ───────────────────────────────────────────────────────

export interface ClickAtXyArgs {
  readonly x: number;
  readonly y: number;
  readonly button?: 'left' | 'middle' | 'right' | 'back' | 'forward';
  /** 1 = single, 2 = double. Default 1. */
  readonly clicks?: number;
}

export interface ClickAtXyResult {
  readonly x: number;
  readonly y: number;
  readonly button: 'left' | 'middle' | 'right' | 'back' | 'forward';
  readonly clicks: number;
}

/**
 * Synthesize a click at CSS-pixel coordinates. Two CDP events
 * — mousePressed then mouseReleased — at the same point.
 * Mirrors browser-harness click_at_xy (helpers.py:181-201).
 */
export async function clickAtXY(
  ctx: HelperContext,
  args: ClickAtXyArgs,
): Promise<HelperResult<ClickAtXyResult>> {
  if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    return err(briskError('HELPER_INVALID_ARGS', 'clickAtXY: x and y must be finite numbers'));
  }
  const button = args.button ?? 'left';
  const clicks = args.clicks ?? 1;
  if (!Number.isInteger(clicks) || clicks < 1) {
    return err(briskError('HELPER_INVALID_ARGS', 'clickAtXY: clicks must be a positive integer'));
  }
  return runCdp(async () => {
    await ctx.daemon.callCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: args.x,
      y: args.y,
      button,
      clickCount: clicks,
    });
    await ctx.daemon.callCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: args.x,
      y: args.y,
      button,
      clickCount: clicks,
    });
    return { x: args.x, y: args.y, button, clicks };
  });
}

// ─── typeText ────────────────────────────────────────────────────────

export interface TypeTextArgs {
  readonly text: string;
}

export interface TypeTextResult {
  readonly length: number;
}

/**
 * Insert text via `Input.insertText`. Fastest path but bypasses
 * framework `onInput`/`onChange` listeners. Use `fillInput` for
 * React/Vue/Ember controlled inputs. Mirrors browser-harness
 * type_text (helpers.py:203-204).
 */
export async function typeText(
  ctx: HelperContext,
  args: TypeTextArgs,
): Promise<HelperResult<TypeTextResult>> {
  if (typeof args.text !== 'string') {
    return err(briskError('HELPER_INVALID_ARGS', 'typeText: text must be a string'));
  }
  return runCdp(async () => {
    await ctx.daemon.callCdp('Input.insertText', { text: args.text });
    return { length: args.text.length };
  });
}

// ─── pressKey ────────────────────────────────────────────────────────

/**
 * Lookup table for keys that need a windowsVirtualKeyCode for listeners
 * checking `e.keyCode`. Lifted verbatim from helpers.py:245-252.
 */
const KEY_TABLE: Record<string, { vk: number; code: string; text: string }> = {
  Enter: { vk: 13, code: 'Enter', text: '\r' },
  Tab: { vk: 9, code: 'Tab', text: '\t' },
  Backspace: { vk: 8, code: 'Backspace', text: '' },
  Escape: { vk: 27, code: 'Escape', text: '' },
  Delete: { vk: 46, code: 'Delete', text: '' },
  ' ': { vk: 32, code: 'Space', text: ' ' },
  ArrowLeft: { vk: 37, code: 'ArrowLeft', text: '' },
  ArrowUp: { vk: 38, code: 'ArrowUp', text: '' },
  ArrowRight: { vk: 39, code: 'ArrowRight', text: '' },
  ArrowDown: { vk: 40, code: 'ArrowDown', text: '' },
  Home: { vk: 36, code: 'Home', text: '' },
  End: { vk: 35, code: 'End', text: '' },
  PageUp: { vk: 33, code: 'PageUp', text: '' },
  PageDown: { vk: 34, code: 'PageDown', text: '' },
};

export interface PressKeyArgs {
  readonly key: string;
  /** Modifier bitfield (use `MODS`). 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. */
  readonly modifiers?: number;
}

export interface PressKeyResult {
  readonly key: string;
  readonly modifiers: number;
}

/**
 * Press a key. For single printable chars also emits a `char` event
 * so `keypress` listeners (and `e.keyCode` checks) fire.
 *
 * Mirrors browser-harness press_key (helpers.py:253-262).
 */
export async function pressKey(
  ctx: HelperContext,
  args: PressKeyArgs,
): Promise<HelperResult<PressKeyResult>> {
  if (typeof args.key !== 'string' || args.key.length === 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'pressKey: key must be non-empty'));
  }
  const modifiers = args.modifiers ?? 0;
  const lookup = KEY_TABLE[args.key];
  let vk: number;
  let code: string;
  let text: string;
  if (lookup) {
    vk = lookup.vk;
    code = lookup.code;
    text = lookup.text;
  } else if (args.key.length === 1) {
    vk = args.key.charCodeAt(0);
    code = args.key;
    text = args.key;
  } else {
    vk = 0;
    code = args.key;
    text = '';
  }
  const base: Record<string, unknown> = {
    key: args.key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  return runCdp(async () => {
    await ctx.daemon.callCdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      ...(text ? { text } : {}),
    });
    if (text && text.length === 1) {
      await ctx.daemon.callCdp('Input.dispatchKeyEvent', {
        type: 'char',
        text,
        ...base,
      });
    }
    await ctx.daemon.callCdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...base,
    });
    return { key: args.key, modifiers };
  });
}

// ─── scroll ──────────────────────────────────────────────────────────

export interface ScrollArgs {
  readonly x: number;
  readonly y: number;
  /** Scroll delta in Y. Negative = scroll down (CDP convention). Default -300. */
  readonly dy?: number;
  /** Scroll delta in X. Default 0. */
  readonly dx?: number;
}

export interface ScrollResult {
  readonly x: number;
  readonly y: number;
  readonly dy: number;
  readonly dx: number;
}

/**
 * Wheel scroll at a point. Mirrors browser-harness scroll
 * (helpers.py:264-265).
 */
export async function scroll(
  ctx: HelperContext,
  args: ScrollArgs,
): Promise<HelperResult<ScrollResult>> {
  if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    return err(briskError('HELPER_INVALID_ARGS', 'scroll: x and y must be finite numbers'));
  }
  const dy = args.dy ?? -300;
  const dx = args.dx ?? 0;
  return runCdp(async () => {
    await ctx.daemon.callCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: args.x,
      y: args.y,
      deltaX: dx,
      deltaY: dy,
    });
    return { x: args.x, y: args.y, dy, dx };
  });
}

// ─── hoverAtXY ───────────────────────────────────────────────────────

export interface HoverAtXyArgs {
  readonly x: number;
  readonly y: number;
}

export interface HoverAtXyResult {
  readonly x: number;
  readonly y: number;
}

/**
 * Move the mouse to (x, y) — triggers hover effects (CSS `:hover`,
 * tooltip listeners, mouseover handlers). NEW in Brisk (helpers.py
 * has no equivalent — browser-harness LLMs were instructed to use
 * a noop click, but that fires button events the page didn't expect).
 */
export async function hoverAtXY(
  ctx: HelperContext,
  args: HoverAtXyArgs,
): Promise<HelperResult<HoverAtXyResult>> {
  if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    return err(briskError('HELPER_INVALID_ARGS', 'hoverAtXY: x and y must be finite numbers'));
  }
  return runCdp(async () => {
    await ctx.daemon.callCdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: args.x,
      y: args.y,
      button: 'none',
    });
    return { x: args.x, y: args.y };
  });
}

// ─── fillInput ───────────────────────────────────────────────────────

export interface FillInputArgs {
  /** CSS selector. */
  readonly selector: string;
  readonly text: string;
  /** Clear the field before typing. Default true. */
  readonly clearFirst?: boolean;
  /** SessionId override (useful for iframes). */
  readonly sessionId?: string;
}

export interface FillInputResult {
  readonly selector: string;
  readonly length: number;
}

/**
 * Fill a framework-managed input. Focuses → optionally selects-all +
 * backspace → types via real key events → fires synthetic input +
 * change. Mirrors browser-harness fill_input (helpers.py:206-243).
 */
export async function fillInput(
  ctx: HelperContext,
  args: FillInputArgs,
): Promise<HelperResult<FillInputResult>> {
  if (!args.selector) {
    return err(briskError('HELPER_INVALID_SELECTOR', 'fillInput: selector is required'));
  }
  if (typeof args.text !== 'string') {
    return err(briskError('HELPER_INVALID_ARGS', 'fillInput: text must be a string'));
  }
  const clearFirst = args.clearFirst ?? true;

  // 1. Focus the element via JS — runs in the page so it sees the real DOM.
  const focusExpr = `(()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(!e)return false;e.focus();return true;})()`;
  const focusedRes = await js(ctx, {
    expression: focusExpr,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  });
  if (!focusedRes.ok) return err(focusedRes.error);
  if (focusedRes.value.value !== true) {
    return err(
      briskError(
        'HELPER_INVALID_SELECTOR',
        `fillInput: element not found for selector ${args.selector}`,
      ),
    );
  }

  // 2. Clear (Ctrl/Cmd+A then Backspace) using rawKeyDown for the modifier
  //    combo so Chrome doesn't emit `char a` and type the literal "a".
  if (clearFirst) {
    const mods = IS_DARWIN ? MODS.Meta : MODS.Ctrl;
    const sa = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
    try {
      await ctx.daemon.callCdp('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        modifiers: mods,
        ...sa,
      });
      await ctx.daemon.callCdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: mods,
        ...sa,
      });
    } catch (cause) {
      return err(
        briskError(
          'CDP_PROTOCOL_ERROR',
          `fillInput: select-all failed: ${(cause as Error).message}`,
          { cause: cause as Error },
        ),
      );
    }
    const bs = await pressKey(ctx, { key: 'Backspace' });
    if (!bs.ok) return err(bs.error);
  }

  // 3. Type the new text one char at a time so framework key listeners fire.
  for (const ch of args.text) {
    const r = await pressKey(ctx, { key: ch });
    if (!r.ok) return err(r.error);
  }

  // 4. Fire input + change events so frameworks see the update.
  const fireExpr = `(()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`;
  const fired = await js(ctx, {
    expression: fireExpr,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  });
  if (!fired.ok) return err(fired.error);

  return ok({ selector: args.selector, length: args.text.length });
}

// ─── dispatchKey ─────────────────────────────────────────────────────

export interface DispatchKeyArgs {
  readonly selector: string;
  readonly key?: string;
  /** Default 'keypress'; some sites listen on 'keydown' / 'keyup'. */
  readonly event?: 'keydown' | 'keypress' | 'keyup';
  readonly sessionId?: string;
}

export interface DispatchKeyResult {
  readonly selector: string;
  readonly key: string;
  readonly event: string;
}

const KC_FALLBACK: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

/**
 * Dispatch a synthetic DOM `KeyboardEvent` on a selector — useful
 * when a site reacts to in-DOM key events rather than raw CDP input.
 * Mirrors browser-harness dispatch_key (helpers.py:450-459).
 */
export async function dispatchKey(
  ctx: HelperContext,
  args: DispatchKeyArgs,
): Promise<HelperResult<DispatchKeyResult>> {
  if (!args.selector) {
    return err(briskError('HELPER_INVALID_SELECTOR', 'dispatchKey: selector is required'));
  }
  const key = args.key ?? 'Enter';
  const event = args.event ?? 'keypress';
  const kc = KC_FALLBACK[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0);
  const expr = `(()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${JSON.stringify(event)},{key:${JSON.stringify(key)},code:${JSON.stringify(key)},keyCode:${kc},which:${kc},bubbles:true}));}})()`;
  const r = await js(ctx, {
    expression: expr,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  });
  if (!r.ok) return err(r.error);
  return ok({ selector: args.selector, key, event });
}

// ─── uploadFile ──────────────────────────────────────────────────────

export interface UploadFileArgs {
  readonly selector: string;
  /** Absolute file path, or an array for multi-file inputs. */
  readonly path: string | readonly string[];
}

export interface UploadFileResult {
  readonly selector: string;
  readonly count: number;
}

/**
 * Set files on a `<input type=file>` via DOM.setFileInputFiles.
 * Bypasses the OS file picker — files must be absolute paths
 * readable by the Chrome process.
 *
 * Mirrors browser-harness upload_file (helpers.py:461-466).
 */
export async function uploadFile(
  ctx: HelperContext,
  args: UploadFileArgs,
): Promise<HelperResult<UploadFileResult>> {
  if (!args.selector) {
    return err(briskError('HELPER_INVALID_SELECTOR', 'uploadFile: selector is required'));
  }
  const files = typeof args.path === 'string' ? [args.path] : [...args.path];
  if (files.length === 0) {
    return err(briskError('HELPER_INVALID_ARGS', 'uploadFile: at least one path required'));
  }
  return runCdp(async () => {
    const doc = await ctx.daemon.callCdp<{ root: { nodeId: number } }>('DOM.getDocument', {
      depth: -1,
    });
    const found = await ctx.daemon.callCdp<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: args.selector,
    });
    if (!found.nodeId) {
      throw briskError(
        'HELPER_INVALID_SELECTOR',
        `uploadFile: no element for selector ${args.selector}`,
      );
    }
    await ctx.daemon.callCdp('DOM.setFileInputFiles', {
      files,
      nodeId: found.nodeId,
    });
    return { selector: args.selector, count: files.length };
  });
}

// ─── selectOption ────────────────────────────────────────────────────

export interface SelectOptionArgs {
  readonly selector: string;
  /** Value to assign to the <select>. The option must already exist. */
  readonly value: string;
  readonly sessionId?: string;
}

export interface SelectOptionResult {
  readonly selector: string;
  readonly value: string;
}

/**
 * Set `<select>.value` then dispatch a `change` event. NEW in
 * Brisk — browser-harness LLMs were instructed to use `click_at_xy`
 * to open a native dropdown, but native dropdowns are notoriously
 * flaky over CDP (Chrome 139+ kills the popup on focus loss).
 */
export async function selectOption(
  ctx: HelperContext,
  args: SelectOptionArgs,
): Promise<HelperResult<SelectOptionResult>> {
  if (!args.selector) {
    return err(briskError('HELPER_INVALID_SELECTOR', 'selectOption: selector is required'));
  }
  const expr = `(()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(!e)return 'missing';if(!('value' in e))return 'not-select';e.value=${JSON.stringify(args.value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()`;
  const r = await js(ctx, {
    expression: expr,
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
  });
  if (!r.ok) return err(r.error);
  const v = r.value.value;
  if (v === 'missing') {
    return err(
      briskError(
        'HELPER_INVALID_SELECTOR',
        `selectOption: element not found for selector ${args.selector}`,
      ),
    );
  }
  if (v === 'not-select') {
    return err(
      briskError(
        'HELPER_INVALID_ARGS',
        `selectOption: element matched by ${args.selector} has no .value setter`,
      ),
    );
  }
  return ok({ selector: args.selector, value: args.value });
}

export { err, ok };
