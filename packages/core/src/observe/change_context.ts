// packages/core/src/observe/change_context.ts
//
// One id per change. A request, its verification, its model calls, its approval wait and its landed record all carry the same
// `change_id`, so a receipt can be built by a join instead of by guessing from timestamps.
//
// How: the entry points (an MCP tool call, a CLI command) run their work inside `withChange`. Everything below them, however deep
// and however many awaits, reads the id with `currentChangeId()`. recordEvent and recordLlmCall do that themselves, so no call site
// has to remember to pass it. Outside a `withChange` the id is null and nothing changes: an event is written exactly as before.
//
// The id is a label for grouping. It is not a secret and not an authorisation: nothing decides anything from it.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const store = new AsyncLocalStorage<{ id: string; startedAt: number }>();

/** A fresh id: `chg-` and 12 hex characters. */
export function newChangeId(): string {
  return `chg-${randomBytes(6).toString("hex")}`;
}

/** Runs `fn` with `id` as the current change. Returns whatever `fn` returns, including a promise. */
export function withChange<T>(fn: () => T, id: string = newChangeId()): T {
  return store.run({ id, startedAt: Date.now() }, fn);
}

/** For a one-command process (the CLI): the whole run is one change. A `withChange` inside it still wins. */
let processChange: { id: string; startedAt: number } | null = null;

/** Marks the rest of this process as one change and returns its id. Call once, at the start of a one-shot command. */
export function beginProcessChange(id: string = newChangeId()): string {
  processChange = { id, startedAt: Date.now() };
  return id;
}

/** The id of the change this code is running for, or null when it is not running inside one. */
export function currentChangeId(): string | null {
  return store.getStore()?.id ?? processChange?.id ?? null;
}

/** Milliseconds since the current change began, or null outside one. */
export function currentChangeElapsedMs(): number | null {
  const s = store.getStore() ?? processChange;
  return s ? Date.now() - s.startedAt : null;
}
