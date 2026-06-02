/**
 * Input tool wrappers — 9 tools.
 */

import {
  type ClickAtXyArgs,
  clickAtXY,
  type DispatchKeyArgs,
  dispatchKey,
  type FillInputArgs,
  fillInput,
  type HoverAtXyArgs,
  hoverAtXY,
  type PressKeyArgs,
  pressKey,
  type ScrollArgs,
  type SelectOptionArgs,
  scroll,
  selectOption,
  type TypeTextArgs,
  typeText,
  type UploadFileArgs,
  uploadFile,
} from '@brisk/core';
import { z } from 'zod';

import { defineTool } from '../framework.js';

const MOUSE_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;
const DOM_KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

export const clickAtXyTool = defineTool({
  name: 'click_at_xy',
  category: 'input',
  title: 'Click at (x, y)',
  description:
    'Synthesize a mouse click at CSS-pixel (x, y) on the attached tab. Two CDP events: ' +
    'mousePressed then mouseReleased. Use `clicks: 2` for a double-click.',
  inputSchema: {
    x: z.number(),
    y: z.number(),
    button: z.enum(MOUSE_BUTTONS).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
  },
  outputSchema: {
    x: z.number(),
    y: z.number(),
    button: z.enum(MOUSE_BUTTONS),
    clicks: z.number(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => clickAtXY(ctx, args as unknown as ClickAtXyArgs),
});

export const typeTextTool = defineTool({
  name: 'type_text',
  category: 'input',
  title: 'Type Text',
  description:
    'Insert text via Input.insertText (fastest). Bypasses framework input listeners — ' +
    'use `fill_input` for React / Vue / Ember controlled inputs.',
  inputSchema: {
    text: z.string(),
  },
  outputSchema: {
    length: z.number(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => typeText(ctx, args as unknown as TypeTextArgs),
});

export const pressKeyTool = defineTool({
  name: 'press_key',
  category: 'input',
  title: 'Press Key',
  description:
    'Press a single key. Special keys: Enter, Tab, Backspace, Escape, Delete, Space, ' +
    'Arrow* (Left/Up/Right/Down), Home, End, PageUp, PageDown. Modifier bitfield: ' +
    '1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.',
  inputSchema: {
    key: z.string().min(1),
    modifiers: z.number().int().min(0).optional(),
  },
  outputSchema: {
    key: z.string(),
    modifiers: z.number(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => pressKey(ctx, args as unknown as PressKeyArgs),
});

export const scrollTool = defineTool({
  name: 'scroll',
  category: 'input',
  title: 'Scroll',
  description:
    'Wheel-scroll at CSS-pixel (x, y). `dy` is the Y delta (negative = scroll down, ' +
    'CDP convention). Default `dy = -300`.',
  inputSchema: {
    x: z.number(),
    y: z.number(),
    dy: z.number().optional(),
    dx: z.number().optional(),
  },
  outputSchema: {
    x: z.number(),
    y: z.number(),
    dy: z.number(),
    dx: z.number(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/scrolling.md'],
  handler: (args, ctx) => scroll(ctx, args as unknown as ScrollArgs),
});

export const hoverAtXyTool = defineTool({
  name: 'hover_at_xy',
  category: 'input',
  title: 'Hover at (x, y)',
  description:
    'Move the mouse to (x, y) — triggers :hover CSS, tooltip listeners, mouseover handlers.',
  inputSchema: {
    x: z.number(),
    y: z.number(),
  },
  outputSchema: {
    x: z.number(),
    y: z.number(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: (args, ctx) => hoverAtXY(ctx, args as unknown as HoverAtXyArgs),
});

export const fillInputTool = defineTool({
  name: 'fill_input',
  category: 'input',
  title: 'Fill Input',
  description:
    'Fill a framework-managed input. Focuses the element, optionally clears it ' +
    '(Ctrl/Cmd+A then Backspace), types via real key events, then fires synthetic ' +
    'input + change events so React/Vue/Ember see the update.',
  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the input/textarea/contenteditable.'),
    text: z.string(),
    clearFirst: z.boolean().optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    selector: z.string(),
    length: z.number(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => fillInput(ctx, args as unknown as FillInputArgs),
});

export const dispatchKeyTool = defineTool({
  name: 'dispatch_key',
  category: 'input',
  title: 'Dispatch DOM KeyboardEvent',
  description:
    'Dispatch a synthetic DOM KeyboardEvent on a selector. Use when a site reacts to ' +
    'DOM events on a specific element rather than raw CDP input.',
  inputSchema: {
    selector: z.string().min(1),
    key: z.string().optional(),
    event: z.enum(DOM_KEY_EVENTS).optional(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    selector: z.string(),
    key: z.string(),
    event: z.string(),
  },
  annotations: { destructiveHint: true },
  handler: (args, ctx) => dispatchKey(ctx, args as unknown as DispatchKeyArgs),
});

export const uploadFileTool = defineTool({
  name: 'upload_file',
  category: 'input',
  title: 'Upload File',
  description:
    'Set files on an <input type=file> via DOM.setFileInputFiles — bypasses the OS ' +
    'file picker. Paths must be absolute and readable by the Chrome process.',
  inputSchema: {
    selector: z.string().min(1),
    path: z.union([z.string(), z.array(z.string())]),
  },
  outputSchema: {
    selector: z.string(),
    count: z.number(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/uploads.md'],
  handler: (args, ctx) => uploadFile(ctx, args as unknown as UploadFileArgs),
});

export const selectOptionTool = defineTool({
  name: 'select_option',
  category: 'input',
  title: 'Select Option',
  description:
    'Set `<select>.value = <value>` and dispatch input + change events. The option ' +
    'must already exist in the dropdown — this does not add new options.',
  inputSchema: {
    selector: z.string().min(1),
    value: z.string(),
    sessionId: z.string().optional(),
  },
  outputSchema: {
    selector: z.string(),
    value: z.string(),
  },
  annotations: { destructiveHint: true },
  seeAlso: ['interaction-skills/dropdowns.md'],
  handler: (args, ctx) => selectOption(ctx, args as unknown as SelectOptionArgs),
});

export const inputTools = [
  clickAtXyTool,
  typeTextTool,
  pressKeyTool,
  scrollTool,
  hoverAtXyTool,
  fillInputTool,
  dispatchKeyTool,
  uploadFileTool,
  selectOptionTool,
];
