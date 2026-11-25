// packages/core/src/cli-io/confirm.ts (moved from src/cli/confirm.ts — security/auth.ts and recovery/escalate.ts import this directly, so it must live in core, not in the cli package, or the core→cli boundary check would fail)
import { ambientEnv } from "../platform/env.js";
import * as readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";

/**
 * SECURITY (GAPS-REPORT-2 §1): AUTO_CONFIRM used to be honored whenever
 * it was set to "1", with no restriction on where — a shell profile, a
 * base Docker image, or a CI pipeline's global environment could all
 * plausibly set a variable this common for an unrelated reason, and
 * every human-approval checkpoint in the system (TrustGate escalations,
 * drift-acceptance checkpoints, security-override justification
 * prompts) would then silently and permanently resolve to "yes."
 *
 * This mirrors the exact restriction tier.ts's PURIX_DEV_TIER override
 * already uses (see the security note on getEntitlements() there):
 * gating on NODE_ENV === "test" means a real, published `purix`
 * invocation can never trigger this path, since nothing in a real
 * user's environment sets NODE_ENV to "test" — only this repo's own
 * test files do, deliberately, around the specific test that needs it
 * (see auth.test.ts). Do NOT relax this check to "if set" again.
 *
 * Exported separately (not inlined into confirm() below) so
 * gated-confirm.ts can tag every recorded checkpoint with whether it
 * was a real human answer or this bypass — before this fix, the two
 * were permanently indistinguishable in the audit trail.
 */
export function isAutoConfirmActive(): boolean {
  return ambientEnv("NODE_ENV") === "test" && ambientEnv("AUTO_CONFIRM") === "1";
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompt lock.
//
// A process whose stdin and stdout carry a protocol must never prompt. The MCP stdio server is one: its stdin is the agent's
// JSON-RPC requests and its stdout is the replies. A prompt there does two kinds of damage at once:
//   1. the question is written to stdout, in the middle of the reply stream, so the client cannot parse the next line;
//   2. the line reader attaches to the same stdin the protocol reads, so the agent's NEXT request is consumed as the "answer".
// Seen in the field: the first `purix_create` on a fresh project reached the "register you as the sole approver?" prompt, the
// agent's call timed out (-32001), and every later call (`purix_index`, then `purix_status`) timed out too.
//
// The lock is set once, by the host, before it starts talking. From then on no function in this file reads stdin or writes to
// stdout; a prompt is refused (confirm() answers "no", promptLine() answers null) and says so on stderr, where a host may log.
// Refusing is the safe answer: every caller already treats "no input" as "no". It is never treated as an approval.
// ---------------------------------------------------------------------------------------------------------------------
let promptLockReason: string | null = null;

/** Called once by a host that owns stdin/stdout (the MCP server). Idempotent; the first reason given is kept. */
export function lockPrompts(reason: string): void {
  if (promptLockReason === null) promptLockReason = reason;
}

/** True once lockPrompts() has run in this process. Callers that can skip an optional question use this to skip it quietly. */
export function promptsLocked(): boolean {
  return promptLockReason !== null;
}

/** Why prompts are locked, or null. For messages that tell the person what to do instead. */
export function promptLockedBecause(): string | null {
  return promptLockReason;
}

/** For tests only: put the process back to "may prompt". */
export function unlockPromptsForTests(): void {
  promptLockReason = null;
}

function refuseToPrompt(question: string): void {
  // stderr, never stdout: stdout may be a protocol stream.
  stderr.write(`[purix] Not asking "${question.trim().slice(0, 200)}": ${promptLockReason}. Treated as "no".\n`);
}

// One process-wide line reader shared by every prompt (confirm() and the
// login prompts). Two failure modes drove this (TEST-REPORT F6/F7):
//   F6 — readline/promises' question() never settles when stdin reaches EOF
//        (CI, `</dev/null`, closed pipe), so the awaited promise hung, Node
//        drained the event loop and exited 13 ("unsettled top-level await")
//        with the repo lock still on disk.
//   F7 — a new readline interface per prompt lets the first interface
//        swallow all buffered piped input, so the second prompt saw EOF.
// Lines that arrive before anyone asks are queued; EOF resolves pending and
// future prompts with `null` so callers can fail closed.
let reader: readline.Interface | null = null;
let inputEnded = false;
const lineQueue: string[] = [];
const waiters: Array<(line: string | null) => void> = [];

function ensureReader(): readline.Interface {
  if (reader) return reader;
  const rl = readline.createInterface({ input: stdin, terminal: false });
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
    // Nobody is waiting: pause so an idle reader never keeps the process alive.
    if (waiters.length === 0) rl.pause();
  });
  rl.on("close", () => {
    inputEnded = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  reader = rl;
  return rl;
}

/**
 * Reads one line from stdin. Resolves `null` when stdin has ended and no
 * queued line remains — never hangs on EOF.
 */
export function readInputLine(): Promise<string | null> {
  // Locked: stdin belongs to a protocol. Never attach a reader to it.
  if (promptLockReason !== null) return Promise.resolve(null);
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (inputEnded || stdin.readableEnded) return Promise.resolve(null);
  const rl = ensureReader();
  return new Promise<string | null>((resolve) => {
    waiters.push(resolve);
    rl.resume();
  });
}

/** Writes `question` and reads one answer; `null` means no input was available. */
export async function promptLine(question: string): Promise<string | null> {
  if (promptLockReason !== null) {
    refuseToPrompt(question);
    return null;
  }
  stdout.write(question);
  const line = await readInputLine();
  if (line === null) stdout.write("\n");
  return line;
}

/**
 * Runs `fn`, which reads stdin by itself (a hidden key prompt in raw mode), without what it reads leaking into the shared line reader.
 * The reader stays attached to stdin for the life of the process, so it hears every byte `fn` reads too and would queue the pasted key as
 * the answer to the NEXT question. Whatever the reader queued while `fn` ran is discarded when it finishes.
 */
export async function withExclusiveStdin<T>(fn: () => Promise<T>): Promise<T> {
  const queuedBefore = lineQueue.length;
  try {
    return await fn();
  } finally {
    if (lineQueue.length > queuedBefore) lineQueue.length = queuedBefore;
  }
}

let lastConfirmHadNoInput = false;
/** True when the most recent confirm() answered "no" because nobody could answer (no terminal, closed input, or a locked prompt), not because a person said no. */
export function lastConfirmHadNoInputAvailable(): boolean {
  return lastConfirmHadNoInput;
}

/**
 * Section 20 human checkpoint: blocks until the developer answers.
 * Defaults to "no" on anything ambiguous (empty enter, garbage input) —
 * a confirmation gate that fails closed, not open. That includes stdin
 * being closed: no input means no approval.
 */
export async function confirm(message: string): Promise<boolean> {
  lastConfirmHadNoInput = false;
  if (isAutoConfirmActive()) return true;
  if (promptLockReason !== null) {
    lastConfirmHadNoInput = true;
    refuseToPrompt(message);
    return false;
  }
  const answer = await promptLine(`${message} [y/N] `);
  if (answer === null) {
    lastConfirmHadNoInput = true;
    // Said with the next step, because "treating as 'no'" alone read as the tool refusing, when nobody had been able to answer.
    stdout.write(
      "(no input available — treating as 'no'. This question needs a person at an interactive terminal, so nothing was changed. " +
        "Run the command in your own terminal. Through an agent, use the purix_create / purix_modify MCP tools and approve the pending request with `purix approve`.)\n"
    );
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}