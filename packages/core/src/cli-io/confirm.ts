// packages/core/src/cli-io/confirm.ts (moved from src/cli/confirm.ts — security/auth.ts and recovery/escalate.ts import this directly, so it must live in core, not in the cli package, or the core→cli boundary check would fail)
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Section 20 human checkpoint: blocks until the developer answers.
 * Defaults to "no" on anything ambiguous (empty enter, garbage input) —
 * a confirmation gate that fails closed, not open.
 */
export async function confirm(message: string): Promise<boolean> {
  if (process.env.AUTO_CONFIRM === "1") return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}