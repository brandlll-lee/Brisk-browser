/**
 * MCP tool boundary types — shared between brisk-mcp (tool registration)
 * and brisk-core (helper layer that tools wrap).
 *
 * NOTE: We deliberately don't import @modelcontextprotocol/sdk here.
 * brisk-types stays SDK-free so the same types can be reused outside
 * the MCP path (e.g. a future direct-call API, or eval harness).
 */

import type { z } from 'zod';

// ─── Tool definition ────────────────────────────────────────────────

export type ToolName =
  // Navigation (8)
  | 'new_tab'
  | 'goto_url'
  | 'switch_tab'
  | 'close_tab'
  | 'list_tabs'
  | 'current_tab'
  | 'ensure_real_tab'
  | 'iframe_target'
  // Observation (6)
  | 'capture_screenshot'
  | 'page_info'
  | 'js'
  | 'dom'
  | 'drain_events'
  | 'get_console_logs'
  // Input (9)
  | 'click_at_xy'
  | 'type_text'
  | 'press_key'
  | 'scroll'
  | 'fill_input'
  | 'dispatch_key'
  | 'upload_file'
  | 'hover_at_xy'
  | 'select_option'
  // Waits (4)
  | 'wait'
  | 'wait_for_load'
  | 'wait_for_element'
  | 'wait_for_network_idle'
  // Network (2)
  | 'http_get'
  | 'cdp'
  // Admin (3)
  | 'connection_status'
  | 'restart_daemon'
  | 'pending_dialog'
  // Skills (5)
  | 'list_skills'
  | 'read_skill'
  | 'write_skill'
  | 'record_failure'
  | 'attach_helper';

export type ToolCategory =
  | 'navigation'
  | 'observation'
  | 'input'
  | 'waits'
  | 'network'
  | 'admin'
  | 'skills';

// ─── Tool result (mirrors MCP CallToolResult shape) ─────────────────

export type ToolContentPart = TextContent | ImageContent | ResourceContent;

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageContent {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export interface ResourceContent {
  readonly type: 'resource';
  readonly resource: {
    readonly uri: string;
    readonly mimeType?: string;
    readonly text?: string;
  };
}

export interface ToolResult {
  readonly content: readonly ToolContentPart[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  /**
   * MCP `_meta` field — Brisk uses it to inject skill hints alongside the
   * tool response (e.g. `_meta.domain_skills` after a `goto_url`). See
   * `docs/v0.1.0-plan.md` §7.2.3.
   */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

// ─── Tool execution context ────────────────────────────────────────

/**
 * Context passed to every tool handler. Kept minimal — adding fields
 * here is a contract change.
 *
 * NOTE: We intentionally type browser/skills as `unknown` here. The
 * real types live in brisk-core and brisk-skills; brisk-types stays
 * dependency-free and the actual implementations cast at the seam.
 */
export interface ToolHandlerCtx {
  /** Brisk daemon, runtime-cast to Daemon in brisk-mcp */
  readonly daemon: unknown;
  /** Skills store, runtime-cast to SkillsStore in brisk-mcp */
  readonly skills: unknown;
  /** Abort signal — MCP request cancellation propagates here */
  readonly signal: AbortSignal;
  /** Per-request log scope */
  readonly logger: ToolLogger;
}

export interface ToolLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ─── Schema-related ────────────────────────────────────────────────

/**
 * Generic tool definition shape. Concrete tools live in
 * brisk-mcp/src/tools/* and use this type to ensure schema/handler
 * alignment.
 */
export interface ToolDef<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: ToolName;
  readonly category: ToolCategory;
  readonly description: string;
  readonly input: TInput;
  readonly output?: TOutput;
  /** Hand-written `.md` reference under `interaction-skills/`. */
  readonly seeAlso?: readonly string[];
}

// ─── Skill types (exposed for tool input/output schemas) ──────────

export interface SkillSummary {
  readonly domain: string;
  readonly name: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly uri: string;
  readonly updatedAt: number;
}

export interface SkillRecord extends SkillSummary {
  readonly content: string;
  readonly createdAt: number;
  readonly basedOnFailure?: string;
}

export interface FailureRecord {
  readonly id: string;
  readonly domain: string;
  readonly action: string;
  readonly expected: string;
  readonly observed: string;
  readonly rootCause?: string;
  readonly workaround?: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly resolvedBySkill?: string;
}
