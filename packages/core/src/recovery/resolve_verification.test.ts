// packages/core/src/recovery/resolve_verification.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveVerification } from "./resolve_verification.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-resolve-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), '{"name":"t","type":"module"}');
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prevCwd);
  safeRmSync(dir);
});

describe("resolveVerification: policy blocks", () => {
  it("returns the secret-scan reason directly and never enters healing or escalation", async () => {
    const original = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
    const candidate = [{ path: "src/a.ts", new_content: 'export const a = "AKIAIOSFODNN7EXAMPLE";\n' }];
    // No LLM provider is configured in this test. If the code tried healing or
    // escalation it would fail with a provider error, not with the scan reason.
    const result = await resolveVerification("a", "update_prompt_text", original, candidate, "direct_patch", "x", dir);
    expect("finalFiles" in result).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/^Secrets\/entropy scan blocked this patch/);
    expect(reason).not.toMatch(/escalation could not/i);
  });
});

describe("resolveVerification: repair's tried states reach escalation (E3c)", () => {
  it("escalation is handed the states the repair loop tried", async () => {
    const original = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
    const candidate = [{ path: "src/a.ts", new_content: "export const a = 2;\n" }];
    const triedStates = [[{ path: "src/a.ts", content: "export const a = 2;\n" }]];
    let got: unknown;
    const logSaved = console.log;
    console.log = () => {};
    try {
      const r = await resolveVerification("a", "update_prompt_text", original, candidate, "direct_patch", "x", dir, {
        verify: () => ({ status: "fail", reason: "boom", idiomFindings: [] }),
        runSelfHealingLoop: (async () => ({ ok: false, attempts: [{ attempt: 0, result: "fail", reason: "boom" }], triedStates })) as never,
        runEscalation: (async (...args: unknown[]) => { got = args[7]; return { ok: false, fromLibrary: false, reason: "no" }; }),
      });
      expect(r).toMatchObject({ ok: false });
    } finally {
      console.log = logSaved;
    }
    expect(got).toEqual({ alreadyTried: triedStates });
  });
});
