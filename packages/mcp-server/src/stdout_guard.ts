// packages/mcp-server/src/stdout_guard.ts
//
// MCP stdio rule (spec 2026-07-28): the server MUST NOT write anything to stdout that is not a valid
// MCP message; it MAY write logs to stderr. Core code still prints with console.log in many places
// (single-point ratchet R1), so while a tool call runs, the console methods that write to stdout are
// pointed at stderr.
//
// The old version of this saved "the original" console.log in each call and put it back in each
// call's finally block. With two tool calls overlapping, the second call saved the FIRST call's
// patched function as its "original", and whichever finished first restored the real console.log
// while the other was still running (output then reached stdout), or the patched function was left
// in place for good. Here the real functions are saved once, by the first call to enter, and put
// back once, by the last call to leave.
//
// console.info and console.debug also write to stdout in Node and were not covered before.
// Writing to process.stdout directly is NOT covered; that needs the reporter port (PURIX-21 D11 a).

type ConsoleMethod = (...args: unknown[]) => void;
const DIVERTED = ["log", "info", "debug", "warn"] as const;

let depth = 0;
let saved: Record<(typeof DIVERTED)[number], ConsoleMethod> | null = null;

function enter(): void {
  if (depth++ > 0) return;
  saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
  };
  for (const m of DIVERTED) {
    console[m] = (...args: unknown[]) => console.error(...args);
  }
}

function leave(): void {
  if (--depth > 0) return;
  depth = 0;
  if (!saved) return;
  for (const m of DIVERTED) console[m] = saved[m];
  saved = null;
}

/** Runs `fn` with stdout-writing console methods diverted to stderr. Safe to nest and to overlap. */
export async function withStdoutDiverted<T>(fn: () => Promise<T>): Promise<T> {
  enter();
  try {
    return await fn();
  } finally {
    leave();
  }
}

/** For tests: how many diversions are active. */
export function stdoutDiversionDepth(): number {
  return depth;
}
