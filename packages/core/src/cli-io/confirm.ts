// packages/core/src/cli-io/confirm.ts (moved from src/cli/confirm.ts — security/auth.ts and recovery/escalate.ts import this directly, so it must live in core, not in the cli package, or the core→cli boundary check would fail)
import * as readline from "node:readline/promises";
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

/**
 * Section 20 human checkpoint: blocks until the developer answers.
 * Defaults to "no" on anything ambiguous (empty enter, garbage input) —
 * a confirmation gate that fails closed, not open.
 */
export async function confirm(message: string): Promise<boolean> {
  if (isAutoConfirmActive()) return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}