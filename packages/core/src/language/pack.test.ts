// packages/core/src/language/pack.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { getLanguagePack } from "./registry";
import { pythonPack } from "./providers/python.pack";

describe("LanguagePack", () => {
  it("getLanguagePack returns undefined for an unknown language id", () => {
    expect(getLanguagePack("unknown-lang")).toBeUndefined();
  });

  it("pythonPack exposes its identity, tier and capabilities", () => {
    expect(pythonPack.languageId).toBe("python");
    expect(pythonPack.minSupportedVersion).toBe("3.10.0");
    expect(pythonPack.tier).toBe("free");
    expect(pythonPack.capabilities.testExecution).toBe(true);
  });

  it("a pack never owns tools: choosing, installing and locating them belongs to the tools broker (ADR-060)", () => {
    for (const member of ["tools", "install", "uninstall", "isFullyInstalled", "extraSetup"]) {
      expect(pythonPack).not.toHaveProperty(member);
    }
  });
});
