// packages/cli/src/cli.test.ts
//
// Smoke test only: cli.ts's own body is almost entirely wiring (register
// every command group, hook up --quiet and the reconciliation preAction).
// The individual commands already have their own coverage in whichever
// command module defines them; what's worth a real assertion here is
// that buildProgram() actually returns a program with every expected
// top-level command registered, and that quiet-flag parsing round-trips
// through Commander correctly.
import { describe, test } from "node:test";
import { expect } from "expect";
import { buildProgram } from "./cli";

describe("buildProgram", () => {
  test("registers every expected top-level command group", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());

    // One representative command per registered group — this is a
    // wiring check, not a re-test of each command's own behavior.
    expect(names).toContain("create");
    expect(names).toContain("migrations");
    expect(names).toContain("status");
    expect(names).toContain("secret-set");
    expect(names).toContain("provider-set");
    expect(names).toContain("tier-status");
    expect(names).toContain("backup");
    expect(names).toContain("remember");
    expect(names).toContain("tools");
    expect(names).toContain("index");
    expect(names).toContain("config");
    expect(names).toContain("login");
    expect(names).toContain("logout");
  });

  test("exposes a top-level --quiet flag", () => {
    const program = buildProgram();
    const quietOption = program.options.find((o) => o.long === "--quiet");
    expect(quietOption).toBeDefined();
    expect(quietOption?.short).toBe("-q");
  });

  test("mcp command stays unregistered for v1.0 (see the gating note in cli.ts)", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).not.toContain("mcp");
  });
});
