import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "./cli";
import { PURIX_VERSION } from "./version.js";
// COMMAND-SURFACE FIX (2026-09-24): restores the Windows-safe retrying
// cleanup (see fs_retry.ts's header) that this file's now-superseded
// root-level predecessor (packages/cli/cli.integration.test.ts, deleted
// this pass — its test glob never ran it) had, and that this src/ copy
// had reverted to plain rmSync when it was rewritten for the 2026-09-22
// CLI command regroup.
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

type CommandSpec = {
  name: string;
  syntax?: string;
  options?: string[];
  subcommands?: CommandSpec[];
};

const publicCommandTree: CommandSpec[] = [
  { name: "create", syntax: "create <name>", options: ["--dry-run"] },
  { name: "modify", syntax: "modify <componentId> <instruction>", options: ["--override", "--dry-run"] },
  { name: "change", syntax: "change <intent>", options: ["--component", "--override", "--dry-run"] },
  { name: "ingest", syntax: "ingest <componentId> <diffFile>", options: ["--agent"] },
  { name: "delete", syntax: "delete <componentId>", options: ["--force", "--files"] },
  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): these
  // entries were flat, hyphenated top-level commands (accept-drift,
  // migration-activate, migration-rollback, migrations, secret-set,
  // secret-rotate, secret-remove, secrets-status, provider-set,
  // provider-status, provider-list, audit-trail, audit-verify, restore) —
  // now grouped into noun-then-verb subcommand trees. See security.ts's
  // comment for the standard this follows.
  {
    name: "migration",
    subcommands: [
      { name: "accept-drift", syntax: "accept-drift <componentId>", options: ["--agent"] },
      { name: "activate", syntax: "activate <id>" },
      { name: "rollback", syntax: "rollback <id>" },
      { name: "list", syntax: "list [componentId]" },
    ],
  },
  { name: "status" },
  { name: "library" },
  { name: "stats" },
  { name: "audit" },
  {
    name: "audit-log",
    subcommands: [
      { name: "trail", options: ["--component", "--since", "--format", "--out"] },
      { name: "verify" },
    ],
  },
  { name: "diagnostics" },
  {
    name: "secret",
    subcommands: [
      { name: "set", syntax: "set <name> <value>" },
      { name: "rotate", syntax: "rotate <name> <newValue>" },
      { name: "remove", syntax: "remove <name>" },
      { name: "status" },
    ],
  },
  {
    name: "provider",
    subcommands: [
      { name: "set", syntax: "set <id>", options: ["--base-url", "--key-env", "--model-low", "--model-high", "--label"] },
      { name: "status" },
      { name: "list" },
    ],
  },
  { name: "tier-status" },
  {
    name: "backup",
    subcommands: [
      { name: "create", syntax: "create <outFile>" },
      { name: "restore", syntax: "restore <inFile>" },
    ],
  },
  { name: "reconcile" },
  { name: "remember", syntax: "remember [options] <note>", options: ["--component"] },
  { name: "tools", syntax: "tools <purpose>" },
  {
    name: "config",
    subcommands: [
      { name: "set", syntax: "set <key> <value>" },
      { name: "get", syntax: "get <key>" },
      { name: "delete", syntax: "delete <key>" },
    ],
  },
  { name: "login" },
  { name: "logout" },
  {
    name: "lang",
    subcommands: [
      { name: "list" },
      { name: "status", syntax: "status <id>" },
      { name: "verify", syntax: "verify <id>" },
      { name: "install", syntax: "install <id>" },
      { name: "uninstall", syntax: "uninstall <id>" },
    ],
  },
  { name: "index", syntax: "index [path]", options: ["--full", "--incremental", "--languages"] },
  { name: "mcp-serve" },
  { name: "connect", syntax: "connect [agent]", options: ["--agent-id"] },
];

function findCommand(program: Awaited<ReturnType<typeof buildProgram>>, path: string[]): any {
  let command: any = program;
  for (const name of path) {
    command = command.commands.find((candidate: any) => candidate.name() === name);
  }
  return command;
}

async function assertCommandTree(specs: CommandSpec[], parentPath: string[] = []): Promise<void> {
  const program = await buildProgram();
  for (const spec of specs) {
    const path = [...parentPath, spec.name];
    const command = findCommand(program, path);
    expect(command).toBeDefined();
    const help = command.helpInformation();
    expect(help).toContain("Usage:");
    if (spec.syntax) {
      const normalizedHelp = help.replace("[options] ", "");
      expect(normalizedHelp).toContain(spec.syntax.replace("[options] ", ""));
    }
    for (const option of spec.options ?? []) {
      expect(help).toContain(option);
    }
    if (spec.subcommands) {
      assertCommandTree(spec.subcommands, path);
      expect(command.commands.map((child: any) => child.name())).toEqual(
        expect.arrayContaining(spec.subcommands.map((child) => child.name)),
      );
    }
  }
}

function runCli(args: string[], cwd: string): { status: number | null; output: string } {
  const home = join(cwd, "home");
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), ...args],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("Purix CLI integration contract", () => {
  it("exposes every public command, subcommand, and declared option", async () => {
    await assertCommandTree(publicCommandTree);
  });

  it("does not expose deferred MCP client or internal developer commands", async () => {
    const names = (await buildProgram()).commands.map((command) => command.name());
    expect(names).not.toEqual(expect.arrayContaining(["mcp-add", "mcp-remove", "mcp-list", "mcp-tools", "mcp-call", "dev"]));
  });

  it("executes all safe local commands in an isolated project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-integration-"));
    try {
      const commands = [
        ["status"], ["library"], ["stats"], ["audit-log", "verify"], ["diagnostics"],
        ["secret", "status"], ["provider", "list"], ["provider", "status"], ["tier-status"],
        ["migration", "list"], ["config", "set", "integration.number", "42"],
        ["config", "get", "integration.number"], ["config", "delete", "integration.number"],
        ["remember", "integration convention"], ["lang", "list"],
      ];
      for (const args of commands) {
        const result = runCli(args, cwd);
        if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.output}`);
        expect(result.status).toBe(0);
      }
    } finally {
      safeRmSync(cwd);
    }
  });

  // TEST-REPORT F12: these used to print an error and exit 0 (the previous
  // version of the test above even listed two of them as "must succeed").
  it("exits non-zero on invalid input instead of printing an error and reporting success", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-invalid-"));
    try {
      const cases: string[][] = [
        ["provider", "set", "unknown-provider"],
        ["provider", "set", "custom"],
        ["secret", "rotate", "NEVER_STORED", "value"],
        ["remember", ""],
        ["remember", "-c", "no-such-component", "a note"],
        ["index", join(cwd, "does-not-exist")],
        ["index", "--languages", "notalanguage"],
      ];
      for (const args of cases) {
        const result = runCli(args, cwd);
        if (result.status !== 1) throw new Error(`${args.join(" ")} should exit 1 but returned ${result.status}:\n${result.output}`);
      }
    } finally {
      safeRmSync(cwd);
    }
  });

  // TEST-REPORT F6: with stdin closed (CI, pipes) a prompt used to hang and
  // Node exited 13 ("unsettled top-level await") with the lock left behind.
  // runCli passes no input, so the child sees EOF immediately.
  it("treats a closed stdin at a confirmation prompt as 'no' instead of hanging (exit 13)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-eof-"));
    try {
      const result = runCli(["index", "--full"], cwd);
      expect(result.status).toBe(0);
      expect(result.output).toContain("no input available");
      expect(result.output).toContain("Cancelled");
    } finally {
      safeRmSync(cwd);
    }
  });

  // Regression test for a real bug found by running the built binary
  // directly: buildProgram()-based tests above never touch the
  // isDirectlyExecuted() startup fast-path in cli.ts, since importing this
  // module for testing is exactly the case that guard is designed to skip.
  // `--help` and a bare invocation (no argv at all) used to be routed into
  // the same zero-commands "minimalProgram" as `--version`, so the two
  // things a brand-new user is most likely to run first showed no commands
  // at all. Spawning a real process is required to exercise this path.
  it("lists the full command set on --help and on a bare invocation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-help-"));
    try {
      for (const args of [["--help"], []]) {
        const result = runCli(args, cwd);
        expect(result.output).toContain("Commands:");
        expect(result.output).toContain("create [options] <name>");
        expect(result.output).toContain("change [options] <intent>");
        expect(result.output).toContain("mcp-serve");
      }
      // --version must still take the fast path: no "Commands:" section,
      // and no reconcile/lock/scheduler side effects from full registration.
      const versionResult = runCli(["--version"], cwd);
      expect(versionResult.output).not.toContain("Commands:");
      expect(versionResult.output.trim()).toBe(PURIX_VERSION);
    } finally {
      safeRmSync(cwd);
    }
  });

  it("change: --help carries examples, and an empty intent or unknown --component exits 1 with a clear message", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-change-"));
    try {
      const help = runCli(["change", "--help"], cwd);
      expect(help.output).toContain("Examples:");
      expect(help.output).toContain("--dry-run");
      const empty = runCli(["change", "  "], cwd);
      expect(empty.status).toBe(1);
      expect(empty.output).toContain("Describe the change");
      const unknown = runCli(["change", "tweak it", "--component", "nope"], cwd);
      expect(unknown.status).toBe(1);
      expect(unknown.output).toContain('No manifest entry for "nope"');
    } finally {
      safeRmSync(cwd);
    }
  });

  it("fails closed for lifecycle operations against missing state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-lifecycle-"));
    try {
      for (const args of [
        ["modify", "missing", "change it"],
        ["change", "anything", "--component", "missing"],
        ["ingest", "missing", "missing.diff"],
        ["delete", "missing"],
        ["migration", "accept-drift", "missing"],
      ]) {
        const result = runCli(args, cwd);
        if (result.status !== 1) throw new Error(`${args.join(" ")} unexpectedly returned ${result.status}:\n${result.output}`);
        expect(result.status).toBe(1);
      }
    } finally {
      safeRmSync(cwd);
    }
  });
});