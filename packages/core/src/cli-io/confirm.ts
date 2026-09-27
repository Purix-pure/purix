// packages/core/src/cli-io/confirm.ts (moved from src/cli/confirm.ts — security/auth.ts and recovery/escalate.ts import this directly, so it must live in core, not in the cli package, or the core→cli boundary check would fail)
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

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
  return process.env.NODE_ENV === "test" && process.env.AUTO_CONFIRM === "1";
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
  stdout.write(question);
  const line = await readInputLine();
  if (line === null) stdout.write("\n");
  return line;
}

/**
 * Section 20 human checkpoint: blocks until the developer answers.
 * Defaults to "no" on anything ambiguous (empty enter, garbage input) —
 * a confirmation gate that fails closed, not open. That includes stdin
 * being closed: no input means no approval.
 */
export async function confirm(message: string): Promise<boolean> {
  if (isAutoConfirmActive()) return true;
  const answer = await promptLine(`${message} [y/N] `);
  if (answer === null) {
    stdout.write("(no input available — treating as 'no')\n");
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}