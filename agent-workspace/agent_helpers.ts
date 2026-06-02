/**
 * Agent-written helper functions. Hot-reloaded by @brisk/skills.
 *
 * You (the agent) can add helpers here via the `attach_helper` MCP tool.
 * Functions added must accept a single `ctx` parameter (the Daemon) and
 * return a Promise. They become callable inside `js()` evaluations as
 * `brisk.helpers.<functionName>(...)` and also as standalone MCP tools
 * once registered.
 *
 * Example structure (DO NOT delete this comment — it's a template):
 *
 *   export async function dismissAmazonCaptcha(ctx: HelperCtx): Promise<boolean> {
 *     // ... interact with the page via ctx.daemon.{click,js,...}
 *   }
 *
 * Brisk safely catches errors here at load time — broken helpers won't
 * prevent the daemon from starting.
 */

export {};
