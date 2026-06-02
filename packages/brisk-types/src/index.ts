/**
 * @brisk/types — shared TypeScript types for the Brisk monorepo.
 *
 * This package is the only leaf node in the dependency graph — every other
 * package depends on it, it depends on nothing (except zod).
 *
 * The split-export layout (./ipc, ./tools, ./cdp) is deliberate: keeps
 * incremental compilation surface small and makes "import @brisk/types"
 * surface only the most-used symbols.
 */

export * from './cdp.js';
export * from './ipc.js';
export * from './result.js';
export * from './tools.js';
