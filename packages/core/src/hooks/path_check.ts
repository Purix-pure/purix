// packages/core/src/hooks/path_check.ts
//
// Every installed hook runs the bare command `purix`. When Purix is run from a checkout (`node packages/cli/dist/cli.js`) and is not
// on PATH, the hook cannot start and fails closed: the agent is blocked on EVERY edit, with a message that only makes sense to
// someone who already knows why (found in the first live OpenCode run, 2026-11-03). Say so at install time instead.
import { spawnSync } from "../platform/spawn_sync.js";

/** How long `command --version` may take before it counts as not starting. A cold `node` start of a global CLI can take seconds. */
const RESOLVE_DEADLINE_MS = 15_000;

/**
 * True when `command --version` starts and exits 0 within the deadline. A command that cannot be found or started, that is stopped
 * (deadline, output cap, signal) or that exits non-zero is false. A5 (problem catalogue 2026-11-07): this used to call node's
 * spawnSync directly, outside the shared spawn rail; it now runs through platform/spawn_sync.ts like every other child process.
 * cross-spawn there finds `purix.cmd` on Windows, which the old call needed `shell: true` for.
 */
export function commandResolves(command: string = "purix", deadlineMs: number = RESOLVE_DEADLINE_MS): boolean {
  const r = spawnSync([command, "--version"], { tier: "T0", deadlineMs, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 && r.stopped === undefined;
}

export const PURIX_NOT_ON_PATH_WARNING =
  "The hook runs the command `purix`, and this terminal cannot find it. Until it can, the agent will be blocked on every edit, because the hook " +
  "fails closed. Put Purix on PATH (for a checkout: `npm link` in packages/cli), open a new terminal, and check with `purix --version`.";
