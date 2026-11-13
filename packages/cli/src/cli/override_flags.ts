// packages/cli/src/cli/override_flags.ts
//
// F03-09. `--override <reason>` used to arm the budget guard, the security gate and (at an abort) the trust gate with one reason,
// so a person who only meant to get past a cost stop also switched off the security gate. Research 03 task 6.1, option B: one
// flag per gate, each naming the gate it skips. The old flag is refused with a message that says what to use instead; it is
// not mapped to "all three", because that is the behaviour being removed.
import { Option, type Command } from "commander";

export interface OverrideFlagOptions {
  /** The retired single flag. Only ever read to refuse it. */
  override?: string;
  overrideBudget?: string;
  overrideSecurity?: string;
  overrideTrust?: string;
}

export interface GateOverrides {
  budget?: string;
  security?: string;
  trust?: string;
}

export const LEGACY_OVERRIDE_MESSAGE =
  "--override no longer exists: one flag used to skip the budget guard, the security gate and the trust gate together. " +
  "Name the gate you mean: --override-budget <reason>, --override-security <reason> or --override-trust <reason>. " +
  "Nothing was run.";

/** Turns the parsed flags into one reason per gate. Throws (with a message fit to print) when the flags cannot be honoured. */
export function resolveGateOverrides(opts: OverrideFlagOptions): GateOverrides {
  if (opts.override !== undefined) throw new Error(LEGACY_OVERRIDE_MESSAGE);
  const out: GateOverrides = {};
  const pairs: [keyof GateOverrides, string, string | undefined][] = [
    ["budget", "--override-budget", opts.overrideBudget],
    ["security", "--override-security", opts.overrideSecurity],
    ["trust", "--override-trust", opts.overrideTrust],
  ];
  for (const [gate, flag, reason] of pairs) {
    if (reason === undefined) continue;
    if (reason.trim() === "") throw new Error(`${flag} needs a reason in words; an empty reason is not accepted. Nothing was run.`);
    out[gate] = reason;
  }
  return out;
}

/** Adds the three per-gate flags (and the hidden retired one, so it can be refused with an explanation) to a command. */
export function addOverrideOptions(cmd: Command): Command {
  return cmd
    .option("--override-budget <reason>", "Skip the cost guard once, with a reason (recorded in the audit chain)")
    .option("--override-security <reason>", "Skip the security gate once, with a reason (recorded in the audit chain)")
    .option("--override-trust <reason>", "Go on after a trust-gate stop, with a reason (still asks for approval; recorded)")
    .addOption(new Option("--override <reason>", "retired: use --override-budget, --override-security or --override-trust").hideHelp());
}
