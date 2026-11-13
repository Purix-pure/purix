#!/usr/bin/env node
// packages/cli/src/cli.ts
//
// Must run before ANY import: several core modules (manifest/store,
// platform/sqlite_compat, llm/sqlite_retry, licensing/tier) use the
// built-in node:sqlite module, which still prints an experimental warning
// on some supported versions (engines requires ^22.13.0 || >=24.0.0; the
// warning was observed on v22.x and v24.0.0 but not on a later 24.x, so the
// filter below stays until the minimum moves past every version that prints
// it). Node prints
// "ExperimentalWarning: SQLite is an experimental feature and might
// change at any time" the first time that module loads, on every single
// command that touches the manifest DB — which is nearly all of them.
// That's alarming/confusing for users with no bearing on Purix's own
// stability, and setting process.env.NODE_NO_WARNINGS from inside the
// process does NOT suppress it (verified: Node's warning emission is
// wired up before user code runs, so an env var set here is too late).
// Filtering process.emitWarning by message, before any sqlite-touching
// module gets a chance to import, is the mechanism that actually works —
// and unlike `--no-warnings` (which can't be injected into how a
// globally-installed or `npx`-invoked binary gets launched) or a blanket
// `process.removeAllListeners("warning")` (which would also hide a real
// future deprecation warning), this only filters this one specific,
// known, expected message and lets everything else through unchanged.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.includes("SQLite is an experimental feature")) return;
  // @ts-expect-error — forwarding the exact overload Node was called with
  return originalEmitWarning(warning, ...args);
});

// Must be the first *import*: loads .env from process.cwd() (the user's
// project, where they'd put a real .env per .env.example) into
// process.env before anything else runs. Several modules read
// process.env.* at module-evaluation time (e.g. cli/output.ts's `quiet`
// flag), so anything imported after this line sees the loaded values —
// anything imported before it would not.
// Names that steer Purix or the platform (NODE_ENV, AUTO_CONFIRM, PURIX_*, proxies, ...) are NOT taken from a
// project .env: see load_env.ts. A repository you cloned must not be able to switch off your approvals.
import "./load_env_boot.js";
import { Command, Help } from "commander";
import { setQuiet } from "./cli/output.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { PURIX_VERSION } from "./version.js";
import { logError } from "./telemetry/log.js";
import { failureMessage } from "./cli/failure_text.js";

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
  { name: "registerChangeCommands", importer: () => import("./cli/commands/change.js"), exportName: "registerChangeCommands" },
  { name: "registerMigrationsCommands", importer: () => import("./cli/commands/migrations.js"), exportName: "registerMigrationsCommands" },
  { name: "registerObservabilityCommands", importer: () => import("./cli/commands/observability.js"), exportName: "registerObservabilityCommands" },
  { name: "registerSecurityCommands", importer: () => import("./cli/commands/security.js"), exportName: "registerSecurityCommands" },
  { name: "registerProviderCommands", importer: () => import("./cli/commands/provider.js"), exportName: "registerProviderCommands" },
  { name: "registerTierCommands", importer: () => import("./cli/commands/tier.js"), exportName: "registerTierCommands" },
  { name: "registerBackupCommands", importer: () => import("./cli/commands/backup.js"), exportName: "registerBackupCommands" },
  { name: "registerMemoryCommands", importer: () => import("./cli/commands/memory.js"), exportName: "registerMemoryCommands" },
  { name: "registerCheckCommand", importer: () => import("./cli/commands/check.js"), exportName: "registerCheckCommand" },
  { name: "registerEvidenceCommands", importer: () => import("./cli/commands/evidence.js"), exportName: "registerEvidenceCommands" },
  { name: "registerLockCommand", importer: () => import("./cli/commands/lock.js"), exportName: "registerLockCommand" },
  { name: "registerToolsCommands", importer: () => import("./cli/commands/tools.js"), exportName: "registerToolsCommands" },
  { name: "registerConfigCommands", importer: () => import("./cli/commands/config.js"), exportName: "registerConfigCommands" },
  { name: "registerAuthCommands", importer: () => import("./cli/commands/auth.js"), exportName: "registerAuthCommands" },
  { name: "registerLangCommands", importer: () => import("./cli/commands/lang.js"), exportName: "registerLangCommands" },
  { name: "registerAdoptCommand", importer: () => import("./cli/commands/adopt.js"), exportName: "registerAdoptCommand" },
  { name: "registerIndexCommands", importer: () => import("./cli/commands/index.js"), exportName: "registerIndexCommands" },
  { name: "registerMcpServeCommand", importer: () => import("./cli/commands/mcp_serve.js"), exportName: "registerMcpServeCommand" },
  { name: "registerConnectCommand", importer: () => import("./cli/commands/connect.js"), exportName: "registerConnectCommand" },
  { name: "registerHookCommand", importer: () => import("./cli/commands/hook.js"), exportName: "registerHookCommand" },
  { name: "registerHooksCommands", importer: () => import("./cli/commands/hooks.js"), exportName: "registerHooksCommands" },
  { name: "registerTelemetryCommands", importer: () => import("./cli/commands/telemetry.js"), exportName: "registerTelemetryCommands" },
  { name: "registerApproveCommands", importer: () => import("./cli/commands/approve.js"), exportName: "registerApproveCommands" },
  { name: "registerBudgetCommands", importer: () => import("./cli/commands/budget.js"), exportName: "registerBudgetCommands" },
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
  change: "registerChangeCommands",
  ingest: "registerLifecycleCommands",
  delete: "registerLifecycleCommands",
  migration: "registerMigrationsCommands",
  status: "registerObservabilityCommands",
  library: "registerObservabilityCommands",
  stats: "registerObservabilityCommands",
  audit: "registerObservabilityCommands",
  "audit-log": "registerObservabilityCommands",
  diagnostics: "registerObservabilityCommands",
  secret: "registerSecurityCommands",
  provider: "registerProviderCommands",
  "tier-status": "registerTierCommands",
  backup: "registerBackupCommands",
  reconcile: "registerBackupCommands",
  remember: "registerMemoryCommands",
  check: "registerCheckCommand",
  evidence: "registerEvidenceCommands",
  lock: "registerLockCommand",
  tools: "registerToolsCommands",
  config: "registerConfigCommands",
  budget: "registerBudgetCommands",
  login: "registerAuthCommands",
  logout: "registerAuthCommands",
  lang: "registerLangCommands",
  index: "registerIndexCommands",
  adopt: "registerAdoptCommand",
  "mcp-serve": "registerMcpServeCommand",
  connect: "registerConnectCommand",
  hook: "registerHookCommand",
  hooks: "registerHooksCommands",
  telemetry: "registerTelemetryCommands",
  approve: "registerApproveCommands",
  deny: "registerApproveCommands",
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


process.on("uncaughtException", (err) => {
  void (async () => {
    logError(err, "uncaughtException");
    console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
    process.exit(1);
  })().catch((handlerErr: unknown) => {
    console.error("Failed while handling an uncaught exception:", handlerErr);
    process.exit(1);
  });
});

process.on("unhandledRejection", (err) => {
  void (async () => {
    logError(err, "unhandledRejection");
    console.error("\n🛑 Something went wrong. Details saved to ~/.purix/logs/. Run `purix diagnostics` to review or share them.");
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
    process.exit(1);
  })().catch((handlerErr: unknown) => {
    console.error("Failed while handling an unhandled rejection:", handlerErr);
    process.exit(1);
  });
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
  // The decision an agent's hook configuration asks for (`purix hook <agent> <event>`). It reads the store and the lock file and
  // writes nothing, so it takes no repository lock and runs no reconcile: before, a busy lock made it exit 1, which Claude Code
  // reads as "the hook failed, carry on", and 6 of 8 simultaneous calls were let through (research 11, D01).
  "hook",
  "status",
  "stats",
  "library",
  "audit-log verify",
  "audit-log trail",
  "audit",
  "diagnostics",
  "secret status",
  "provider status",
  "provider list",
  "tier-status",
  // Usage-data controls write only to the user directory (~/.purix), never the project store.
  "telemetry",
  "telemetry status",
  "telemetry enable",
  "telemetry disable",
  "telemetry show",
  "telemetry reset",
  "telemetry forget",
  // The one canonical check (PURIX-21 D9): read-only by contract, so it must never take the reconcile/lock path.
  "check",
  // Evidence outputs read the store and never write it (G10); `evidence trailer --message-file` writes only the commit message file.
  "evidence",
  "evidence export",
  "evidence report",
  "evidence trailer",
  // Reads the store (never writes it) and writes only purix.lock.json at the project root.
  "lock",
  // Write only the agent's own config (connect) or the user's session under ~/.purix (login, logout). None of them
  // opens the project's store, so none of them should leave a .purix/ folder behind in a folder that has no project.
  "connect",
  "login",
  "logout",
  // A person answering an agent's pending request (C-30). They read and write only .purix/approvals, and the audit event on a
  // decision opens the store itself; neither needs the reconcile/lock path, and listing in a folder with no project must create nothing.
  "approve",
  "deny",
  // Writes only provider-config.json, atomically. It must not open the manifest store as a side effect.
  "provider set",
  "provider trust", // writes only the user's own trust list, outside the project
  "config get",
  "config", // bare `purix config` and `config list`: read-only listing of optional flows
  "config list",
  "lang list",
  "lang status",
  // Moved to `purix tools`; these only print where to go, so they must not create state either.
  "lang install",
  "lang uninstall",
  // ADR-060: the read-only half of the tools broker. install / approve / remove are deliberately NOT here:
  // they write the audit chain, so they take the reconciled, repo-locked path.
  "tools",
  "tools list",
  "tools plan",
  "tools status",
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

/**
 * Prints a top-level command failure and sets the process exit code.
 *
 * Every intentional failure thrown anywhere in @purix/core is a plain
 * `throw new Error("...")` with a clear, actionable message (confirmed:
 * zero uses of TypeError/RangeError/etc. for expected conditions across
 * the whole core package) — things like "No LLM provider is configured.
 * Run ...", "Repository is already locked by active process PID ...",
 * "Refusing to scaffold — file(s) already exist: ...". Those are Purix
 * doing its job, not Purix breaking. A genuine unexpected failure (a
 * real bug, a non-Error throw, a native runtime error) surfaces as some
 * other error shape.
 *
 * Both call sites used to label every single failure "🛑 Unhandled
 * error" regardless of which kind it was, which made routine, expected
 * setup issues (an unconfigured provider, a missing manifest entry) read
 * like the tool itself was broken. This restores that distinction
 * instead of duplicating the same logic at both call sites.
 */
// Mirrors @purix/core/cli-io/exit_codes (kept inline so the CLI start-up path
// stays free of extra static imports; cli.exit_codes.test.ts pins the two together).
export function exitCodeForFailure(err: unknown): number {
  const name = err instanceof Error ? err.name : "";
  if (name === "LoginRequiredError") return 3;
  if (name === "ClientTooOldError") return 4;
  if (name === "IntegrityError") return 5;
  return 1;
}

// Records one `command_run` row in the local usage ledger (closed schema; never throws).
async function recordCommandRun(actionCommand: Command | null, exitCode: number): Promise<void> {
  try {
    const path = actionCommand ? commandPath(actionCommand).replace(/ /g, "_") : "unknown";
    const [{ recordUsage }, { durationBucket }] = await Promise.all([
      import("@purix/core/usage/ledger"),
      import("@purix/core/usage/schema"),
    ]);
    const words = ["ok", "check_failed", "usage", "login_required", "client_too_old", "integrity"];
    const elapsed = commandActionStartMs > 0 ? performance.now() - commandActionStartMs : 0;
    recordUsage({ event: "command_run", dimension: `${path}:${words[exitCode] ?? "check_failed"}:${durationBucket(elapsed)}` });
  } catch {
    // product data must never break a command
  }
}

// Commands that can record new savings. After one finishes, push unsent savings
// events, best effort, with a short cap so a slow network never holds up the CLI.
const SAVINGS_COMMANDS = new Set(["change", "modify", "create", "index"]);

async function syncSavingsAfter(actionCommand: Command): Promise<void> {
  try {
    if (!SAVINGS_COMMANDS.has(commandPath(actionCommand))) return;
    const { runSavingsSync } = await import("@purix/core/security/savings_sync_run");
    await Promise.race([runSavingsSync(), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  } catch {
    // never let a sync problem fail a command
  }
}

function reportCommandFailure(err: unknown): void {
  const isTypedApiFailure =
    err instanceof Error && (err.name === "LoginRequiredError" || err.name === "ClientTooOldError");
  const isExpectedFailure = isTypedApiFailure || (err instanceof Error && err.constructor === Error);
  let message = failureMessage(err);
  if (err instanceof Error && err.name === "LoginRequiredError" && !message.includes("purix login")) {
    message += " Run `purix login` and try again.";
  }
  console.error(isExpectedFailure ? `\n🛑 ${message}` : `\n🛑 Unhandled error: ${message}`);
  process.exitCode = exitCodeForFailure(err);
}

/**
 * One help page, every command on it, most used first (PURIX-23 section 2.1).
 *
 * Research behind this: the Command Line Interface Guidelines say to show the most common commands first, not
 * alphabetically, grouped by workflow stage (git does this), and the Nix CLI guideline ranks commands as main,
 * infrequent and utility. There is deliberately no second, longer help (`--all`): a person sees the whole command set in
 * one place, with the commands they reach for first at the top and operator commands at the bottom.
 *
 * The order is a judgment from the workflow (first run, daily path, inspection, setup, operator), not measured use.
 * Review it when real usage data exists. A command that is not listed here still appears, in the last group, so a new
 * command can never go missing from help.
 */
export const HELP_GROUPS: readonly { heading: string; commands: readonly string[] }[] = [
  { heading: "Start here", commands: ["connect", "create", "change", "check", "tools"] },
  { heading: "Everyday work", commands: ["modify", "adopt", "index", "status", "remember"] },
  { heading: "Evidence and trust", commands: ["evidence", "lock", "stats", "audit-log", "audit"] },
  { heading: "Account and setup", commands: ["login", "logout", "config", "budget", "provider", "secret", "lang", "tier-status"] },
  { heading: "Advanced and operator", commands: ["ingest", "migration", "library", "mcp-serve", "backup", "reconcile", "diagnostics", "delete", "telemetry"] },
];
const HELP_LAST_GROUP = "More";
/** Commands that run but are never listed: they are what other programs (an agent's hook config) call, or set up such a call. */
export const UNLISTED_COMMANDS: readonly string[] = ["hook", "hooks"];

function helpRank(name: string): { group: string; index: number } {
  if (name === "help") return { group: "Help", index: Number.MAX_SAFE_INTEGER };
  let offset = 0;
  for (const g of HELP_GROUPS) {
    const i = g.commands.indexOf(name);
    if (i >= 0) return { group: g.heading, index: offset + i };
    offset += g.commands.length;
  }
  return { group: HELP_LAST_GROUP, index: offset };
}

function createBaseProgram(): Command {
  const program = new Command();
  program
    .name("purix")
    .description(`Verification & Governance Layer for AI-Generated Code (Purix v${PURIX_VERSION})`)
    .version(PURIX_VERSION)
    .addHelpText("after", () =>
      [
        "",
        "First steps:",
        '  purix create "what you want to build"   plan it, review the files, approve before anything is written',
        "  purix connect                           let your coding agent (Claude Code, Cursor, Codex, OpenCode, ...) use Purix",
        "  purix check                             see whether governed files still match what Purix recorded",
      ].join("\n"),
    );

  // A new user types what they expect to exist. Say where to go instead of only "unknown command".
  program.configureOutput({
    outputError: (str, write) => {
      write(str);
      const unknown = /unknown command '([^']+)'/.exec(str)?.[1];
      if (unknown === undefined) return;
      const start = new Set(["init", "setup", "start", "new", "scaffold", "bootstrap", "install", "begin"]);
      if (start.has(unknown)) {
        write(`There is no "${unknown}" step: Purix sets itself up the first time you run a command.\n`);
        write('  Start a project:           purix create "what you want to build"\n');
        write("  Connect your coding agent: purix connect\n");
        write("  Install a tool it needs:   purix tools\n");
      } else {
        write('  Run "purix --help" to see every command.\n');
      }
    },
  });

  // One help page: every listed command, most used first, grouped (see HELP_GROUPS).
  program.configureHelp({
    visibleCommands: (cmd) => {
      const all = new Help().visibleCommands(cmd);
      if (cmd.parent) return all;
      const shown = all.filter((c) => !UNLISTED_COMMANDS.includes(c.name()));
      const ranked = shown.map((c) => ({ c, r: helpRank(c.name()) }));
      // Within the last ("More") group keep a stable alphabetical order.
      ranked.sort((x, y) => x.r.index - y.r.index || x.c.name().localeCompare(y.c.name()));
      for (const { c, r } of ranked) c.helpGroup(`${r.group}:`);
      // Commander lists groups in the order the commands were registered, so put the registered list in rank order too.
      // (It reads that list before it calls this function, but sorts nothing itself, so sorting in place here is seen.)
      const registered = cmd.commands as Command[];
      const rank = new Map(ranked.map((x, i) => [x.c, i]));
      registered.sort((x, y) => (rank.get(x) ?? Number.MAX_SAFE_INTEGER) - (rank.get(y) ?? Number.MAX_SAFE_INTEGER));
      return ranked.map((x) => x.c);
    },
  });

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
    // N-3: run from the project root, not from whatever subfolder the command was typed in. Everything
    // below (state, lock, manifest) resolves from the current directory, so this one step makes a run from
    // src/components use the project's state instead of creating a stray .purix there. `connect` is left
    // alone: it writes an agent's config into the folder the person chose.
    const cmdName = commandPath(actionCommand);
    if (cmdName !== "connect") {
      const { findProjectRoot } = await import("@purix/core/platform/project_root");
      const found = findProjectRoot(process.cwd());
      if (found && found.root !== process.cwd()) {
        process.chdir(found.root);
        // Silent for mcp-serve (stdio is the protocol) and for every `hook ...` command (an agent reads stderr as the reason for a block).
        const silentRoot = cmdName === "mcp-serve" || cmdName === "hook" || cmdName.startsWith("hook ");
        if (!silentRoot && !thisCommand.opts().quiet) console.error(`Using project root ${found.root}`);
      }
    }
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
    // Pending operations live in the project's manifest store. A folder with no store has none, and asking
    // for them used to create an empty store (and `.purix/`) as a side effect of any failing command.
    const { storeExists } = await import("@purix/core/manifest/store");
    // The lock first, then reconcile: reconciling rolls back or completes whatever the journal says is unfinished, which is
    // only safe once no other process can be the one finishing it (research 11). A busy lock refuses this command before it
    // has touched anything.
    acquireRepoLock();
    if (storeExists()) await reconcilePendingOperations();
    // Only announce the scheduler starting for the one genuinely long-lived
    // command (mcp-serve stays up and actually reaches later polls). Every
    // other command here is a one-shot process that starts the scheduler
    // as routine setup and exits almost immediately, well before the
    // first poll interval elapses — "Started, polling every 30000ms" was
    // printing on every single mutating invocation and describing polling
    // that was never going to happen.
    startScheduler(commandPath(actionCommand) === "mcp-serve");
    commandActionStartMs = performance.now();
  });

  program.hook("postAction", async (_thisCommand, actionCommand) => {
    timingState.actionMs = Math.max(0, performance.now() - commandActionStartMs);
    await recordCommandRun(actionCommand, 0);
    await syncSavingsAfter(actionCommand);
    if (isReadOnlyCommand(actionCommand)) return;
    const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
    releaseRepoLock();
  });

  process.on("SIGINT", () => {
    void (async () => {
      const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
      releaseRepoLock();
      process.exit(130);
    })().catch((handlerErr: unknown) => {
      console.error("Failed while handling SIGINT:", handlerErr);
      process.exit(130);
    });
  });
  process.on("SIGTERM", () => {
    void (async () => {
      const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
      releaseRepoLock();
      process.exit(143);
    })().catch((handlerErr: unknown) => {
      console.error("Failed while handling SIGTERM:", handlerErr);
      process.exit(143);
    });
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
        .description(`Verification & Governance Layer for AI-Generated Code (Purix v${PURIX_VERSION})`)
        .version(PURIX_VERSION)
        .option("-q, --quiet", "suppress non-essential output");

      try {
        await minimalProgram.parseAsync(process.argv);
      } catch (err) {
        reportCommandFailure(err);
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
      // A bare `purix` (no command, no flags) is a request for orientation,
      // not a usage error. Commander would print the same help but exit 1
      // (help({ error: true })), which makes `pnpm purix` report
      // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL after a successful build.
      // Unknown commands and bad flags still fall through to parseAsync
      // and keep their non-zero exit.
      if (argv.length === 0) {
        program.outputHelp();
        return;
      }
      await program.parseAsync(process.argv);
    } catch (err) {
      reportCommandFailure(err);
      await recordCommandRun(null, exitCodeForFailure(err));
      // TEST-REPORT F8: Commander skips the postAction hook when an action
      // throws, so a failed mutating command (missing provider key, model
      // returned non-JSON, ...) used to leave .purix/repo.lock behind for
      // the next run to clear as "stale". releaseRepoLock() only removes a
      // lock this process owns, and is loaded only on this failure path so
      // the success path keeps its startup cost.
      try {
        const { releaseRepoLock } = await import("@purix/core/state/repo_lock");
        releaseRepoLock();
      } catch {
        // Never let cleanup mask the original failure.
      }
    } finally {
      timingState.parseMs = Math.max(0, performance.now() - parseStartMs - timingState.actionMs);
    }
  };

  await main();
}