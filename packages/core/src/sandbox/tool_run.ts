// src/sandbox/tool_run.ts
//
// T1 (security review V1, "Purix Security After the Plan"): the TypeScript compiler and ESLint used to run through a bare
// spawnSync, with no sandbox at all. A project's own `node_modules/.bin/tsc` or `eslint` is code the project chose, so a cloned
// repository could run anything it liked as the person. These two steps now go through runIsolated like the test runners do:
// network off, project folder read-only, one scratch folder writable, allow-listed environment, scratch HOME.
//
// What this does NOT do: it does not make a project's own binary trustworthy. Where no sandbox tool exists (Windows, a
// container that blocks user namespaces without strict mode) the run is unisolated and the result says isolation: "none".
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { runIsolated, IsolationRequiredError, SandboxUnavailableError, type IsolationLevel } from "./sandbox_exec.js";
import { withScratchHome } from "./sandbox_env.js";
import { failureOfStoppedRun, type InfrastructureKind } from "../verify/outcome.js";

/**
 * Read-only paths a tool needs inside the sandbox: the real node_modules a verification copy links to, the pnpm store that
 * holds the packages those links point at, and a Purix-installed tool's own folder. Same walk the test runner does.
 */
export function toolReadOnlyBinds(baseDir: string, toolHome?: string): string[] {
  const binds: string[] = [];
  const modules = join(baseDir, "node_modules");
  if (existsSync(modules)) {
    try {
      const real = realpathSync(modules);
      if (real !== modules) binds.push(real);
      let dir = dirname(real);
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "node_modules", ".pnpm"))) {
          binds.push(join(dir, "node_modules"));
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // unreadable: nothing extra to bind
    }
  }
  if (toolHome) binds.push(toolHome);
  return binds;
}

export type ToolRun =
  | { kind: "ran"; exitCode: number | null; stdout: string; stderr: string; isolation: IsolationLevel }
  | { kind: "infrastructure"; infrastructure: InfrastructureKind; reason: string }
  /** F02-03: the run hit its time limit, or a signal ended it. Not labelled infrastructure on purpose (new code can hang or end its own process), see failureOfStoppedRun. */
  | { kind: "timed_out"; reason: string };

/** Runs a project or installed tool in the sandbox with `baseDir` read-only and a scratch folder for writes and HOME. */
export function runToolIsolated(command: string[], baseDir: string, opts: { toolHome?: string; what: string }): ToolRun {
  try {
    return withScratchHome((scratch) => {
      const r = runIsolated(command, { cwd: baseDir, writableDir: scratch, extraReadOnlyBinds: toolReadOnlyBinds(baseDir, opts.toolHome) });
      // F02-03: a run that was stopped has no exit code worth reading. Say what stopped it instead of letting it pass for a failing exit.
      const stoppedRun = failureOfStoppedRun(r, opts.what);
      if (stoppedRun) {
        return stoppedRun.infrastructure
          ? { kind: "infrastructure" as const, infrastructure: stoppedRun.infrastructure, reason: stoppedRun.reason }
          : { kind: "timed_out" as const, reason: stoppedRun.reason };
      }
      // bwrap itself started, but the program inside it was not found (Node under a version manager's home folder is not bound).
      if (r.isolation !== "none" && r.exitCode !== 0 && r.stdout.trim() === "" && /execvp .*: No such file or directory/.test(r.stderr)) {
        return {
          kind: "infrastructure" as const,
          infrastructure: "not_installed" as const,
          reason: `${opts.what} could not be started inside the sandbox: ${r.stderr.trim().split("\n")[0]}. This is not a failure of your code.`,
        };
      }
      return { kind: "ran" as const, ...r };
    });
  } catch (err) {
    if (err instanceof IsolationRequiredError) {
      return { kind: "infrastructure", infrastructure: "sandbox_unavailable", reason: `${opts.what} did not run: ${err.message}` };
    }
    if (err instanceof SandboxUnavailableError) {
      return { kind: "infrastructure", infrastructure: "sandbox_unavailable", reason: `${opts.what} did not run: ${err.message}` };
    }
    throw err;
  }
}
