#!/usr/bin/env node
// packages/cli/src/cli.ts>COM
// Must be the first import: loads .env from process.cwd() (the user's
// project, where they'd put a real .env per .env.example) into
// process.env before anything else runs. Several modules read
// process.env.* at module-evaluation time (e.g. cli/output.ts's `quiet`
// flag), so anything imported after this line sees the loaded values —
// anything imported before it would not.
import "dotenv/config";
import { Command } from "commander";
import { reconcilePendingOperations } from "@purix/core/state/reconcile";
import { acquireRepoLock, releaseRepoLock } from "@purix/core/state/repo_lock";
import { startScheduler } from "@purix/core/state/scheduler";
import { setQuiet } from "./cli/output.js";
import { registerLifecycleCommands } from "./cli/commands/lifecycle.js";
import { registerMigrationsCommands } from "./cli/commands/migrations.js";
import { registerObservabilityCommands } from "./cli/commands/observability.js";
import { registerSecurityCommands } from "./cli/commands/security.js";
import { registerProviderCommands } from "./cli/commands/provider.js";
import { registerTierCommands } from "./cli/commands/tier.js";

// registerMcpCommands intentionally not wired in for v1.0 launch — see
// ADR-057 ("MCP Client Commands Governance Deferral"). The gateway/registry
// code is intact and untouched; re-enable this import + the
// registerMcpCommands(program) call below once the governance hardening
// (identity-backed provenance, DLP scrub, escalation budget caps) ships.
// import { registerMcpCommands } from "./cli/commands/mcp";
import { registerBackupCommands } from "./cli/commands/backup.js";
import { registerMemoryCommands } from "./cli/commands/memory.js";
import { registerToolsCommands } from "./cli/commands/tools.js";
import { registerConfigCommands } from "./cli/commands/config.js";
import { registerAuthCommands } from "./cli/commands/auth.js";
import { registerLangCommands } from "./cli/commands/lang.js";
// registerDevCommands intentionally not wired in for beta — `purix dev
// scaffold-language` is an internal codegen tool for Purix's own
// contributors (generates provider/pack/fixture stubs for a new
// language), not an end-user-facing command. It was previously
// unconditionally registered with no gate, unlike every other
// internal-only surface in this file (see registerMcpCommands above and
// PURIX_INTERNAL_LANGUAGES in language/registry.ts for the established
// pattern). Re-enable via an explicit internal/dev-mode flag if
// contributor tooling needs it exposed through the published binary;
// until then this is dead weight in the public `purix --help` output.
// import { registerDevCommands } from "./cli/commands/dev";
import { registerIndexCommands } from "./cli/commands/index.js";
import { registerMcpServeCommand } from "./cli/commands/mcp_serve.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { logError } from "./telemetry/log.js";
import { registerConnectCommand } from "./cli/commands/connect.js";


process.on("uncaughtException", (err) => {
  logError(err, "uncaughtException");
  console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
  releaseRepoLock();
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logError(err, "unhandledRejection");
  console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
  releaseRepoLock();
  process.exit(1);
});

/**
 * Builds the configured Commander program without running it. Split out
 * from the parseAsync call below so this file is importable in a test —
 * `program.parseAsync(process.argv)` as a bare top-level side effect
 * would otherwise run (and try to interpret the test runner's own argv)
 * the moment anything imported this module.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("purix")
    .description("Verification & Governance Layer for AI-Generated Code (Purix v0.1.0)")
    .version("0.1.0");

  // Part 2: global quiet flag, alongside the existing preAction hook.
  program.option("-q, --quiet", "suppress non-essential output");

  // §7.3: startup reconciliation runs before ANY command touches the
  // manifest — a crash-interrupted operation from a prior run must be
  // resolved before new work starts, or state drifts further. Reading
  // --quiet here too, once, rather than in every individual command.
  program.hook("preAction", async (thisCommand) => {
    setQuiet(Boolean(thisCommand.opts().quiet));
    await reconcilePendingOperations();
    acquireRepoLock();
    startScheduler();
  });

  program.hook("postAction", async () => {
    releaseRepoLock();
  });

  process.on("SIGINT", () => {
    releaseRepoLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseRepoLock();
    process.exit(143);
  });

  registerLifecycleCommands(program);
  registerMigrationsCommands(program);
  registerObservabilityCommands(program);
  registerSecurityCommands(program);
  registerProviderCommands(program);
  registerTierCommands(program);
  // registerMcpCommands(program); — gated off for v1.0, see note above import
  registerBackupCommands(program);
  registerMemoryCommands(program);
  registerToolsCommands(program);
  registerConfigCommands(program);
  registerAuthCommands(program);
  registerLangCommands(program);
  // registerDevCommands(program); — gated off for beta, see note above import
  registerIndexCommands(program);
  registerMcpServeCommand(program);
  registerConnectCommand(program);
  return program;
}

// Real bug, found while verifying the published-package install path (not
// hypothetical): `process.argv[1] === fileURLToPath(import.meta.url)` looks
// like the standard "am I the directly-executed entry point, or just
// imported for buildProgram() in tests" guard, but Node does NOT resolve
// symlinks for argv[1] while it DOES resolve them for import.meta.url when
// loading the module. Every real invocation of this CLI goes through a
// symlink: `npm install -g purix` creates one in the global bin dir, `npx
// purix` creates one in its cache, and even local `node_modules/.bin/purix`
// is one. Under all three, argv[1] stays the symlink path while
// import.meta.url resolves to the real target — they never match, the
// guard silently evaluates false, and the CLI exits 0 with zero output no
// matter what was asked for. realpath-ing argv[1] first makes the
// comparison symlink-agnostic on both sides; buildProgram() itself is
// untouched, so cli.test.ts / cli.integration.test.ts importing it directly
// still don't trigger this block (there's no argv[1] file to realpath to
// a match in that context).
function isDirectlyExecuted(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectlyExecuted()) {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.help();
  } else {
    program.parseAsync(process.argv).catch((err) => {
      console.error(`\n🛑 Unhandled error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    });
  }
}