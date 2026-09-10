import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "./cli";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

type CommandSpec = {
  name: string;
  syntax?: string;
  options?: string[];
  subcommands?: CommandSpec[];
};

const publicCommandTree: CommandSpec[] = [
  { name: "create", syntax: "create <n>" },
  { name: "modify", syntax: "modify <componentId> <instruction>", options: ["--override"] },
  { name: "ingest", syntax: "ingest <componentId> <diffFile>", options: ["--agent"] },
  { name: "delete", syntax: "delete <componentId>", options: ["--force", "--files"] },
  { name: "accept-drift", syntax: "accept-drift <componentId>", options: ["--agent"] },
  { name: "migration-activate", syntax: "migration-activate <id>" },
  { name: "migration-rollback", syntax: "migration-rollback <id>" },
  { name: "migrations", syntax: "migrations [componentId]" },
  { name: "status" },
  { name: "library" },
  { name: "stats" },
  { name: "audit" },
  { name: "audit-trail", options: ["--component", "--since", "--format", "--out"] },
  { name: "audit-verify" },
  { name: "diagnostics" },
  { name: "secret-set", syntax: "secret-set <n> <value>" },
  { name: "secret-rotate", syntax: "secret-rotate <n> <newValue>" },
  { name: "secret-remove", syntax: "secret-remove <n>" },
  { name: "secrets-status" },
  { name: "provider-set", syntax: "provider-set <id>", options: ["--base-url", "--key-env", "--model-low", "--model-high", "--label"] },
  { name: "provider-status" },
  { name: "provider-list" },
  { name: "tier-status" },
  { name: "backup", syntax: "backup <outFile>" },
  { name: "restore", syntax: "restore <inFile>" },
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

function findCommand(program: ReturnType<typeof buildProgram>, path: string[]): ReturnType<typeof buildProgram> extends infer T
  ? T extends { commands: infer _ } ? any : never
  : never {
  let command: any = program;
  for (const name of path) {
    command = command.commands.find((candidate: any) => candidate.name() === name);
  }
  return command;
}

function assertCommandTree(specs: CommandSpec[], parentPath: string[] = []): void {
  const program = buildProgram();
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
  it("exposes every public command, subcommand, and declared option", () => {
    assertCommandTree(publicCommandTree);
  });

  it("does not expose deferred MCP client or internal developer commands", () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names).not.toEqual(expect.arrayContaining(["mcp-add", "mcp-remove", "mcp-list", "mcp-tools", "mcp-call", "dev"]));
  });

  it("executes all safe local commands in an isolated project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-integration-"));
    try {
      const commands = [
        ["status"], ["library"], ["stats"], ["audit-verify"], ["diagnostics"],
        ["secrets-status"], ["provider-list"], ["provider-status"], ["tier-status"],
        ["migrations"], ["config", "set", "integration.number", "42"],
        ["config", "get", "integration.number"], ["config", "delete", "integration.number"],
        ["remember", "integration convention"], ["lang", "list"],
        ["provider-set", "unknown-provider"], ["provider-set", "custom"],
      ];
      for (const args of commands) {
        const result = runCli(args, cwd);
        if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.output}`);
        expect(result.status).toBe(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for lifecycle operations against missing state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-cli-lifecycle-"));
    try {
      for (const args of [
        ["modify", "missing", "change it"],
        ["ingest", "missing", "missing.diff"],
        ["delete", "missing"],
        ["accept-drift", "missing"],
      ]) {
        const result = runCli(args, cwd);
        if (result.status !== 1) throw new Error(`${args.join(" ")} unexpectedly returned ${result.status}:\n${result.output}`);
        expect(result.status).toBe(1);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});