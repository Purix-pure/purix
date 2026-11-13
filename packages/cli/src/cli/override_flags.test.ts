// packages/cli/src/cli/override_flags.test.ts
//
// F03-09: the per-gate override flags. In-process and fast; the end-to-end behaviour is in commands/lifecycle.test.ts.
import { describe, it } from "node:test";
import { expect } from "expect";
import { Command } from "commander";
import { addOverrideOptions, LEGACY_OVERRIDE_MESSAGE, resolveGateOverrides } from "./override_flags.js";

describe("resolveGateOverrides", () => {
  it("no flags: no overrides", () => {
    expect(resolveGateOverrides({})).toEqual({});
  });

  it("each flag arms only its own gate", () => {
    expect(resolveGateOverrides({ overrideBudget: "b" })).toEqual({ budget: "b" });
    expect(resolveGateOverrides({ overrideSecurity: "s" })).toEqual({ security: "s" });
    expect(resolveGateOverrides({ overrideTrust: "t" })).toEqual({ trust: "t" });
  });

  it("several flags in one run keep their own reasons", () => {
    expect(resolveGateOverrides({ overrideBudget: "b", overrideSecurity: "s" })).toEqual({ budget: "b", security: "s" });
  });

  it("the retired --override is refused, never mapped to all three gates", () => {
    expect(() => resolveGateOverrides({ override: "r" })).toThrow(LEGACY_OVERRIDE_MESSAGE);
    expect(() => resolveGateOverrides({ override: "r", overrideBudget: "b" })).toThrow(/--override no longer exists/);
  });

  it("an empty or blank reason is refused and the message names the flag", () => {
    expect(() => resolveGateOverrides({ overrideBudget: "" })).toThrow(/--override-budget needs a reason/);
    expect(() => resolveGateOverrides({ overrideSecurity: "   " })).toThrow(/--override-security needs a reason/);
    expect(() => resolveGateOverrides({ overrideTrust: "\t" })).toThrow(/--override-trust needs a reason/);
  });
});

describe("addOverrideOptions", () => {
  const parse = (args: string[]) => {
    const cmd = addOverrideOptions(new Command("x").exitOverride());
    cmd.parse(["node", "x", ...args], { from: "node" });
    return cmd.opts();
  };

  it("parses the three flags into camelCase option names", () => {
    expect(parse(["--override-budget", "a", "--override-security", "b", "--override-trust", "c"])).toEqual({ overrideBudget: "a", overrideSecurity: "b", overrideTrust: "c" });
  });

  it("still parses the retired flag, so it can be refused with an explanation instead of 'unknown option'", () => {
    expect(parse(["--override", "r"])).toEqual({ override: "r" });
  });

  it("does not show the retired flag in help", () => {
    const help = addOverrideOptions(new Command("x")).helpInformation();
    expect(help).toMatch(/--override-budget/);
    expect(help).not.toMatch(/--override <reason>/);
  });
});
