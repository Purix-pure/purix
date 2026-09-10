// packages/cli/src/cli/output.ts
//
// Part 2: "read it once in that same [preAction] hook and store it
// somewhere the output layer can check (a module-level flag or a small
// context object), rather than checking program.opts() inside every
// individual command." This is that module-level flag.
//
// Two ways quiet can be turned on, checked in this priority order:
//   1. PURIX_QUIET=1 in the environment — checked first so it's never
//      silently overridden by option-parsing order.
//   2. -q/--quiet on the command line, read once in cli.ts's preAction
//      hook via setQuiet().
let quiet = process.env.PURIX_QUIET === "1";

/** Called once from cli.ts's preAction hook after Commander parses argv. */
export function setQuiet(value: boolean): void {
  quiet = quiet || value;
}

/** Checked by lifecycle.ts and any other command's narrative console.log calls. */
export function isQuiet(): boolean {
  return quiet;
}
