// packages/core/src/language/pack.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLanguagePack } from "./registry";
import { pythonPack } from "./providers/python.pack";

describe("LanguagePack & ToolSpec", () => {
  it("getLanguagePack returns undefined for an unknown language id", () => {
    const pack = getLanguagePack("unknown-lang");
    expect(pack).toBeUndefined();
  });

  it("pythonPack exposes correct languageId and minSupportedVersion", () => {
    expect(pythonPack.languageId).toBe("python");
    expect(pythonPack.minSupportedVersion).toBe("3.10.0");
    expect(pythonPack.tools.length).toBe(4);
  });

  it("isFullyInstalled returns false when tools are missing in a scratch dir", () => {
    const scratch = mkdtempSync(join(tmpdir(), "purix-pack-test-"));
    try {
      const fully = pythonPack.isFullyInstalled(scratch);
      expect(fully).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
