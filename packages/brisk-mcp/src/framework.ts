/**
 * Tool framework — uniform shape for the 32+ Brisk MCP tools.
 *
 * One BriskTool wraps:
 *   • zod inputSchema (raw shape — matches McpServer.registerTool signature)
 *   • optional outputSchema (also raw shape)
 *   • a typed async handler returning `Result<T>`
 *
 * The framework converts the `Result<T>` to MCP's `CallToolResult`
 * shape (content[] + optional structuredContent). Errors are mapped
 * to `{ isError: true, content: [{type:'text', text: code: message}] }`
 * so the calling LLM can read them as plain text.
 *
 * Lineage: BrowserOS framework.ts (apps/server/src/framework.ts) and
 * browser-harness's implicit "JSON dict + error string" convention.
 */

import type { HelperContext } from '@brisk/core';
import type { SkillsManager } from '@brisk/skills';
import {
  asBriskError,
  type BriskError,
  type Result,
  type ToolCategory,
  type ToolName,
} from '@brisk/types';
import type { z } from 'zod';

/**
 * Context handed to every tool handler. Adds `skills` (optional —
 * skill tools require it; the rest don't touch it) on top of the
 * helpers' `HelperContext`.
 */
export interface BriskToolContext extends HelperContext {
  /** Skills store. `null` if the agent disabled skills. */
  readonly skills: SkillsManager | null;
  /** Optional cancellation signal forwarded by the SDK. */
  readonly signal?: AbortSignal;
}

// ─── BriskTool ───────────────────────────────────────────────────────

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * MCP-bound Brisk tool definition.
 *
 * `handler` returns `Result<TStructured>`:
 *   • ok    → framework emits `{ content: [text(JSON)], structuredContent }`
 *   • err   → framework emits `{ isError: true, content: [text("CODE: msg")] }`
 *
 * The `inputSchema` MUST be a raw zod shape (e.g. `{ url: z.string() }`)
 * NOT a wrapped object — that's the MCP SDK convention. `registerTool`
 * takes the same shape directly.
 */
export interface BriskTool {
  readonly name: ToolName;
  readonly category: ToolCategory;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly outputSchema?: z.ZodRawShape;
  readonly annotations?: ToolAnnotations;
  /** Relative path under `interaction-skills/`. Surfaces in MCP resources. */
  readonly seeAlso?: readonly string[];
  /**
   * Handler — args are SDK-validated against `inputSchema` before this runs,
   * so a plain `Record<string, unknown>` is safe to cast inside.
   */
  handler(args: Record<string, unknown>, ctx: BriskToolContext): Promise<Result<unknown>>;
}

// ─── Builders ────────────────────────────────────────────────────────

/**
 * Identity helper that nails down the discriminant types (category,
 * name) so TypeScript doesn't widen them at the call site.
 */
export function defineTool<T extends BriskTool>(tool: T): T {
  return tool;
}

// ─── Execution → CallToolResult ──────────────────────────────────────

/**
 * Minimal subset of `@modelcontextprotocol/sdk/types`'s `CallToolResult`
 * that we actually produce. Re-declared here so brisk-mcp's public API
 * doesn't force consumers to import the SDK types just to inspect a
 * tool result (e.g. for tests).
 */
export interface CallToolResultLike {
  readonly content: readonly { type: 'text'; text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

/**
 * Drive a tool to completion + format the `Result` for MCP.
 *
 * `ctx` is passed straight through — the framework doesn't inject
 * anything beyond what the caller already prepared. Errors thrown
 * from the handler are coerced to a `BriskError` with code
 * `CDP_PROTOCOL_ERROR` and surface as `isError: true`.
 */
export async function executeTool(
  tool: BriskTool,
  args: Record<string, unknown>,
  ctx: BriskToolContext,
): Promise<CallToolResultLike> {
  try {
    const result = await tool.handler(args, ctx);
    return formatResult(result);
  } catch (cause) {
    return formatError(asBriskError(cause));
  }
}

/** Convert a Result to CallToolResultLike. */
export function formatResult(result: Result<unknown>): CallToolResultLike {
  if (!result.ok) return formatError(result.error);
  const value = result.value;
  if (value === undefined) {
    return { content: [{ type: 'text', text: '"(no output)"' }] };
  }
  // Always stringify so the LLM sees JSON it can reason about
  // (MCP's structuredContent only surfaces if the tool registered
  // an outputSchema, but `content` always reaches the LLM).
  const text = safeJsonStringify(value);
  if (isStructuredCompatible(value)) {
    return {
      content: [{ type: 'text', text }],
      structuredContent: value as Record<string, unknown>,
    };
  }
  return { content: [{ type: 'text', text }] };
}

/** Convert a BriskError to CallToolResultLike with isError=true. */
export function formatError(error: BriskError): CallToolResultLike {
  // The text is "CODE: message" so the LLM can grep on the code
  // when deciding whether to retry / write a skill.
  return {
    content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
    isError: true,
    structuredContent: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replacer, 2);
  } catch (cause) {
    return JSON.stringify({
      __serializationError__: (cause as Error).message,
      __valueType__: typeof value,
    });
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type__: 'bytes',
      length: value.byteLength,
      base64: Buffer.from(value).toString('base64'),
    };
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return value;
}

function isStructuredCompatible(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
