// src/llm/call_failure.ts
//
// A10c-1 (research 15 findings 7 and 8): how a failed model call is classified and how long to wait before the next try.
//
//   - A timeout is its own class. Before, the error Node 22 gives for a hung request ("The operation was aborted due to
//     timeout") matched none of the transient patterns, so a hung call was neither retried nor counted by the circuit breaker.
//   - A timeout is retried fewer times than other transient errors, because each attempt costs a whole deadline.
//   - The wait between tries has random added, so many clients on one provider key do not retry in step.

/** Retries after a timeout (3 attempts in all). PROVISIONAL: my choice; each attempt can cost a whole deadline (3 minutes). */
export const TIMEOUT_MAX_RETRIES = 2;
/** Retries after any other transient error (5 attempts in all). Unchanged from before A10c-1. */
export const TRANSIENT_MAX_RETRIES = 4;

const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** True when the request ran past its deadline: our own AbortSignal.timeout, or the network layer's own timeouts. A user abort is not one. */
export function isTimeoutError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (e.name === "TimeoutError") return true;
  if (typeof e.code === "string" && TIMEOUT_CODES.has(e.code)) return true;
  return isTimeoutError(e.cause, depth + 1);
}

export class ModelCallTimeoutError extends Error {
  constructor(
    public readonly provider: string,
    public readonly attempts: number,
    public readonly deadlineMs: number
  ) {
    super(
      `The call to ${provider} timed out: no answer within ${deadlineMs >= 10_000 ? `${Math.round(deadlineMs / 1000)} seconds` : `${deadlineMs / 1000} s`}, ${attempts} time${attempts === 1 ? "" : "s"} in a row. ` +
        `This is a provider or network problem, not a problem with your request. Try again later, or raise the limit with ` +
        `PURIX_LLM_TIMEOUT_MS (milliseconds) if your model is slow.`
    );
    this.name = "ModelCallTimeoutError";
  }
}

/**
 * Wait before retry number `attempt` (1 for the first retry): 1, 2, 4, 8 seconds, plus up to half as much again at random.
 * Only ever adds to the old fixed wait, so nothing retries sooner than it used to. Additive jitter is my choice for being the
 * smallest change; research 15 cites full jitter, which spreads clients more widely. Not measured against a real provider.
 */
export function retryDelayMs(attempt: number, random: () => number = hooks.random): number {
  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.floor(random() * base * 0.5);
}

interface RetryHooks {
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}
const defaults: RetryHooks = { random: Math.random, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let hooks: RetryHooks = defaults;
/** Test seam: replace the random source and the sleep. Call with undefined to restore. */
export function setRetryHooksForTests(h: Partial<RetryHooks> | undefined): void {
  hooks = h ? { ...defaults, ...h } : defaults;
}
export function retrySleep(ms: number): Promise<void> {
  return hooks.sleep(ms);
}
