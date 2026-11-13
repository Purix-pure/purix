// packages/cli/src/cli.front_door.test.ts
//
// One help page (PURIX-23 section 2.1): every listed command on it, the most used first, no second "--all" level,
// operator-facing hook commands unlisted but still runnable.
import { describe, test } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_GROUPS, UNLISTED_COMMANDS } from "./cli";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, PURIX_USER_DIR: mkdtempSync(join(tmpdir(), "purix-fd-")), ...env },
  });
}

function help(args: string[]) {
  const r = run(args);
  const listing = r.stdout.split("\nFirst steps:")[0]!;
  const names = [...listing.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!);
  const headings = [...listing.matchAll(/^([A-Z][A-Za-z ]+):$/gm)].map((m) => m[1]!);
  return { out: r.stdout, names, headings, status: r.status };
}

describe("one help page", () => {
  test("--help lists every command once, hides hook and hooks, and has no second level", () => {
    const r = help(["--help"]);
    expect(new Set(r.names).size).toBe(r.names.length);
    for (const g of HELP_GROUPS) for (const c of g.commands) expect(r.names).toContain(c);
    for (const hidden of UNLISTED_COMMANDS) expect(r.names).not.toContain(hidden);
    expect(r.out).not.toContain("--all");
    expect(r.out).not.toContain("More commands");
  });

  test("most used first: the groups appear in order and the first command is `connect`", () => {
    const r = help(["--help"]);
    const order = HELP_GROUPS.map((g) => g.heading);
    const seen = r.headings.filter((h) => order.includes(h));
    expect(seen).toEqual(order);
    expect(r.names[0]).toBe("connect");
    // Within the page: change comes before modify, check before audit, login before ingest.
    const at = (n: string) => r.names.indexOf(n);
    expect(at("change")).toBeLessThan(at("modify"));
    expect(at("check")).toBeLessThan(at("audit"));
    expect(at("login")).toBeLessThan(at("ingest"));
    expect(at("mcp-serve")).toBeLessThan(at("delete"));
  });

  test("`purix help`, `purix --help` and a bare `purix` print the same page", () => {
    const a = help(["--help"]);
    const b = help(["help"]);
    const c = help([]);
    expect(b.names).toEqual(a.names);
    expect(c.names).toEqual(a.names);
    expect(c.status).toBe(0);
  });

  test("`--all` is gone: help no longer documents it", () => {
    expect(run(["--help", "--all"]).stdout).not.toContain("list every command");
  });

  test("hidden commands still run", () => {
    expect(run(["hooks", "--help"]).status).toBe(0);
    const r = run(["telemetry", "status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Telemetry:");
  });
});
