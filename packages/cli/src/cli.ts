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
import { setQuiet } from "./cli/output.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { logError } from "./telemetry/log.js";

const MODE = process.env.PURIX_DEBUG_TIMING === "1";
const timingState = {
  startupToFirstLineMs: performance.now(),
  cumulativeImportMs: 0,
  parseMs: 0,
  actionMs: 0,
};
let commandActionStartMs = 0;

// Each entry's `importer` is a literal `import("...")` call (not built
// from a variable) specifically so bundlers can statically trace it:
// esbuild's code-splitting needs a literal specifier at the import()
// call site to know what chunk to produce and split off. A path stored
// as a plain string and passed to `import(path)` from a variable is
// invisible to that analysis — esbuild has no way to know which module
// a runtime string might resolve to, so it can't include it in the
// bundle at all. (This is not hypothetical: an earlier version of this
// table stored `path` strings and called `import(path)`, and the
// bundled build shipped with the command modules missing entirely,
// caught only by running a real command against dist-bundled/, not by
// --help.) Every entry below must keep its import() call inline like
// this, even though it means repeating the literal path in two places
// (this table and the module itself) — that repetition is the price of
// staying bundler-safe.
const COMMAND_REGISTRY_SPECS = [
  { name: "registerLifecycleCommands", importer: () => import("./cli/commands/lifecycle.js"), exportName: "registerLifecycleCommands" },
  { name: "registerMigrationsCommands", importer: () => import("./cli/commands/migrations.js"), exportName: "registerMigrationsCommands" },
  { name: "registerObservabilityCommands", importer: () => import("./cli/commands/observability.js"), exportName: "registerObservabilityCommands" },
  { name: "registerSecurityCommands", importer: () => import("./cli/commands/security.js"), exportName: "registerSecurityCommands" },
  { name: "registerProviderCommands", importer: () => import("./cli/commands/provider.js"), exportName: "registerProviderCommands" },
  { name: "registerTierCommands", importer: () => import("./cli/commands/tier.js"), exportName: "registerTierCommands" },
  // registerMcpCommands intentionally not wired in for v1.0 launch — see
  // ADR-057 ("MCP Client Commands Governance Deferral"). The gateway/registry
  // code is intact and untouched; re-enable this export + the
  // registerMcpCommands(program) call below once the governance hardening
  // (identity-backed provenance, DLP scrub, escalation budget caps) ships.
  // { name: "registerMcpCommands", importer: () => import("./cli/commands/mcp.js"), exportName: "registerMcpCommands" },
  { name: "registerBackupCommands", importer: () => import("./cli/commands/backup.js"), exportName: "registerBackupCommands" },
  { name: "registerMemoryCommands", importer: () => import("./cli/commands/memory.js"), exportName: "registerMemoryCommands" },
  { name: "registerToolsCommands", importer: () => import("./cli/commands/tools.js"), exportName: "registerToolsCommands" },
  { name: "registerConfigCommands", importer: () => import("./cli/commands/config.js"), exportName: "registerConfigCommands" },
  { name: "registerAuthCommands", importer: () => import("./cli/commands/auth.js"), exportName: "registerAuthCommands" },
  { name: "registerLangCommands", importer: () => import("./cli/commands/lang.js"), exportName: "registerLangCommands" },
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
  // { name: "registerDevCommands", importer: () => import("./cli/commands/dev.js"), exportName: "registerDevCommands" },
  { name: "registerIndexCommands", importer: () => import("./cli/commands/index.js"), exportName: "registerIndexCommands" },
  { name: "registerMcpServeCommand", importer: () => import("./cli/commands/mcp_serve.js"), exportName: "registerMcpServeCommand" },
  { name: "registerConnectCommand", importer: () => import("./cli/commands/connect.js"), exportName: "registerConnectCommand" },
] as const;

// Maps each top-level command name a user can type to the spec (by `name`,
// matching COMMAND_REGISTRY_SPECS above) that registers it. Used only to
// fast-path a single command's module import — see resolveSingleCommandSpec
// below. This is a targeting optimization, not the source of truth for
// what's registered: buildProgram() always registers every spec regardless
// of this map, so an entry missing or wrong here only costs performance
// (falls back to full registration), never correctness.
const COMMAND_NAME_TO_SPEC: Record<string, (typeof COMMAND_REGISTRY_SPECS)[number]["name"]> = {
  create: "registerLifecycleCommands",
  modify: "registerLifecycleCommands",
  ingest: "registerLifecycleCommands",
  delete: "registerLifecycleCommands",
  "accept-drift": "registerMigrationsCommands",
  "migration-activate": "registerMigrationsCommands",
  "migration-rollback": "registerMigrationsCommands",
  migrations: "registerMigrationsCommands",
  status: "registerObservabilityCommands",
  library: "registerObservabilityCommands",
  stats: "registerObservabilityCommands",
  audit: "registerObservabilityCommands",
  "audit-trail": "registerObservabilityCommands",
  "audit-verify": "registerObservabilityCommands",
  diagnostics: "registerObservabilityCommands",
  "secret-set": "registerSecurityCommands",
  "secret-rotate": "registerSecurityCommands",
  "secret-remove": "registerSecurityCommands",
  "secrets-status": "registerSecurityCommands",
  "provider-set": "registerProviderCommands",
  "provider-status": "registerProviderCommands",
  "provider-list": "registerProviderCommands",
  "tier-status": "registerTierCommands",
  backup: "registerBackupCommands",
  restore: "registerBackupCommands",
  reconcile: "registerBackupCommands",
  remember: "registerMemoryCommands",
  tools: "registerToolsCommands",
  config: "registerConfigCommands",
  login: "registerAuthCommands",
  logout: "registerAuthCommands",
  lang: "registerLangCommands",
  index: "registerIndexCommands",
  "mcp-serve": "registerMcpServeCommand",
  connect: "registerConnectCommand",
};

/**
 * If argv unambiguously targets exactly one command group, returns that
 * spec's name so main() can register only that module instead of all
 * COMMAND_REGISTRY_SPECS. Returns null for anything not confidently
 * resolvable (no args, unknown command, `--help` with no command, etc.)
 * so the caller falls back to full registration — never guesses.
 */
function resolveSingleCommandSpec(argv: string[]): (typeof COMMAND_REGISTRY_SPECS)[number]["name"] | null {
  const firstPositional = argv.find((arg) => !arg.startsWith("-"));
  if (!firstPositional) return null;
  return COMMAND_NAME_TO_SPEC[firstPositional] ?? null;
}

function emitTimingSummary(): void {
  if (!MODE) return;
  process.stderr.write(
    `[timing-summary] startupToFirstLineMs=${timingState.startupToFirstLineMs.toFixed(1)} cumulativeImportMs=${timingState.cumulativeImportMs.toFixed(1)} parseMs=${timingState.parseMs.toFixed(1)} actionMs=${timingState.actionMs.toFixed(1)}\n`,
  );
}

process.on("exit", () => {
  emitTimingSummary();
});

async function registerCommandModules(
  program: Command,
  specs: readonly (typeof COMMAND_REGISTRY_SPECS)[number][] = COMMAND_REGISTRY_SPECS,
): Promise<void> {
  const registrations = await Promise.all(
    specs.map(async ({ name, importer, exportName }) => {
      const before = performance.now();
      const module = await importer();
      const importMs = performance.now() - before;
      timingState.cumulativeImportMs += importMs;

      if (MODE) {
        process.stderr.write(`[module-load] ${name}: ${Math.round(importMs)}ms\n`);
      }

      const registrar = (module as Record<string, unknown>)[exportName] as (program: Command) => void;
      return registrar;
    }),
  );

  for (const registrar of registrations) {
    registrar(program);
  }
}


process.on("uncaughtException", async (err) => {
  logError(err, "uncaughtException");
  console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
  const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
  releaseRepoLock();
  process.exit(1);
});

process.on("unhandledRejection", async (err) => {
  logError(err, "unhandledRejection");
  console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
  const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
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
/**
 * Shared program wiring (name/version, --quiet, preAction/postAction
 * hooks, signal handlers) used by both the full buildProgram() below and
 * the single-command fast path in main(). Does NOT register any command
 * modules — callers do that separately, so this stays identical between
 * "register everything" and "register just the one matched module".
 */
// Commands that only ever read state — never touch the manifest, never
// write files, never need a prior run's crash-interrupted operation
// reconciled first. Full dotted path (parent command name + subcommand
// name, space-separated) so "config get" doesn't also match "config set"
// or "config delete". Kept as an explicit allowlist rather than a
// pattern match on the name, so a new command defaults to the safe
// (reconciled) path unless someone deliberately adds it here.
const READ_ONLY_COMMANDS = new Set([
  "status",
  "stats",
  "audit",
  "diagnostics",
  "secrets-status",
  "provider-status",
  "provider-list",
  "tier-status",
  "config get",
  "lang list",
  "lang status",
]);

function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = cmd; current && current.parent; current = current.parent) {
    parts.unshift(current.name());
  }
  return parts.join(" ");
}

function isReadOnlyCommand(actionCommand: Command): boolean {
  return READ_ONLY_COMMANDS.has(commandPath(actionCommand));
}

function createBaseProgram(): Command {
  const program = new Command();
  program
    .name("purix")
    .description("Verification & Governance Layer for AI-Generated Code (Purix v0.2.0-beta.0)")
    .version("0.2.0-beta.0");

  // Part 2: global quiet flag, alongside the existing preAction hook.
  program.option("-q, --quiet", "suppress non-essential output");

  // §7.3: startup reconciliation runs before ANY *mutating* command
  // touches the manifest — a crash-interrupted operation from a prior
  // run must be resolved before new work starts, or state drifts
  // further. Read-only commands (READ_ONLY_COMMANDS) never touch the
  // manifest and can't drift it, so they skip reconcile/lock/scheduler
  // entirely — that chain cold-loads several other modules
  // (verify/impact/path_guard/schema_migrations/language-registry for
  // reconcile; config/manifest-library/audit-tamper-evidence for the
  // scheduler) purely to end up doing nothing, which was costing every
  // command ~150ms regardless of whether it ever needed reconciliation.
  // Reading --quiet here too, once, rather than in every individual
  // command.
  program.hook("preAction", async (thisCommand, actionCommand) => {
    setQuiet(Boolean(thisCommand.opts().quiet));
    if (isReadOnlyCommand(actionCommand)) {
      commandActionStartMs = performance.now();
      return;
    }
    // Lazy — these three are only needed once a real mutating command is
    // actually about to run. Importing them at module top-level (the
    // previous shape) meant Node evaluated
    // reconcile.js/repo_lock.js/scheduler.js's own module bodies
    // unconditionally on every invocation, including
    // `--version`/`--help`, even though canSkipCommandRegistration means
    // this hook never fires for those. Same bug class as the ts-morph
    // fix, just at the top of this file instead of inside a command
    // module.
    const [{ reconcilePendingOperations }, { acquireRepoLock }, { startScheduler }] = await Promise.all([
      import("@purix/core/state/reconcile"),
      import("@purix/core/state/repo_lock"),
      import("@purix/core/state/scheduler"),
    ]);
    await reconcilePendingOperations();
    acquireRepoLock();
    startScheduler();
    commandActionStartMs = performance.now();
  });

  program.hook("postAction", async (_thisCommand, actionCommand) => {
    timingState.actionMs = Math.max(0, performance.now() - commandActionStartMs);
    if (isReadOnlyCommand(actionCommand)) return;
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
  });

  process.on("SIGINT", async () => {
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
    process.exit(143);
  });

  return program;
}

export async function buildProgram(): Promise<Command> {
  const program = createBaseProgram();
  await registerCommandModules(program);
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
  const main = async () => {
    const argv = process.argv.slice(2);
    // Real bug, found while smoke-testing the built binary directly (not
    // hypothetical): this used to also skip registration for `--help`/`-h`
    // and for a bare invocation with no args at all (`argv.every` is
    // vacuously true on an empty array). That left both `purix --help` and
    // plain `purix` — the two things a brand-new user is most likely to run
    // first — printing a command with zero subcommands listed, since
    // minimalProgram below never registers any command module. Only
    // `--version`/`-v` actually has nothing useful to gain from the full
    // command list, so only that (optionally with `--quiet`) takes the fast
    // path now; `--help`/`-h` and bare argv fall through to full
    // registration below, where they belong.
    const versionRequested = argv.some((arg) => arg === "--version" || arg === "-v");
    const canSkipCommandRegistration =
      versionRequested &&
      argv.every((arg) => arg === "--version" || arg === "-v" || arg === "--quiet" || arg === "-q");

    if (canSkipCommandRegistration) {
      const minimalProgram = new Command();
      minimalProgram
        .name("purix")
        .description("Verification & Governance Layer for AI-Generated Code (Purix v0.2.0-beta.0)")
        .version("0.2.0-beta.0")
        .option("-q, --quiet", "suppress non-essential output");

      try {
        await minimalProgram.parseAsync(process.argv);
      } catch (err) {
        console.error(`\n🛑 Unhandled error: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
      return;
    }

    // Fast path: most invocations (`purix tier-status`, `purix tier-status
    // --help`, `purix config set foo bar`, etc.) target exactly one command
    // group. Registering all ~15 command modules via buildProgram() to run
    // just one pays import cost for the other ~14 on every single
    // invocation — that's the actual "every command is slow" cost, not any
    // one module being individually heavy. When argv unambiguously
    // resolves to one spec, register only that module. Anything not
    // confidently resolvable (unknown command, no command, malformed argv)
    // falls through to the full buildProgram() below unchanged, so
    // correctness never depends on this table being complete or right —
    // only speed does.
    const singleSpecName = resolveSingleCommandSpec(argv);
    const parseStartMs = performance.now();
    try {
      if (singleSpecName) {
        const spec = COMMAND_REGISTRY_SPECS.find((s) => s.name === singleSpecName);
        if (spec) {
          const program = createBaseProgram();
          await registerCommandModules(program, [spec]);
          const matched = argv.find((arg) => !arg.startsWith("-"));
          // Defense in depth: COMMAND_NAME_TO_SPEC is hand-maintained and
          // could in principle drift from what a module actually
          // registers. If the single module we loaded doesn't actually
          // expose the command the user typed, don't let Commander error
          // out with "unknown command" — fall through to full
          // registration instead, so a stale map entry only costs speed,
          // never correctness.
          if (matched && program.commands.some((c) => c.name() === matched)) {
            await program.parseAsync(process.argv);
            timingState.parseMs = Math.max(0, performance.now() - parseStartMs - timingState.actionMs);
            return;
          }
        }
      }

      const program = await buildProgram();
      await program.parseAsync(process.argv);
    } catch (err) {
      console.error(`\n🛑 Unhandled error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    } finally {
      timingState.parseMs = Math.max(0, performance.now() - parseStartMs - timingState.actionMs);
    }
  };

  await main();
}