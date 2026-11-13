// src/tools/c2_planted_eslint.test.ts
//
// C2 (plan v4, N4 / V1): replay of a planted-tool attack. A project ships its own `node_modules/.bin/eslint`; that program is code the
// project chose, and Purix uses a project's own ESLint first by design (locateTool). What these tests pin is what was MEASURED on
// 2026-11-08 on Linux with no sandbox tool installed (bwrap absent): the planted program runs when no strict isolation is asked for,
// it does not see the parent's secrets (the environment is an allow-list and HOME is a scratch folder), and it does not run at all
// under PURIX_STRICT_ISOLATION=1. They do NOT claim the program is contained when no sandbox tool exists: it can still write files
// and reach the network as the person (shown by hand in the C2 handoff; not asserted here because a machine with bwrap contains it).
import { describe, it } from "node:test";
import { expect } from "expect";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkIdioms } from "../verify/idiom.js";

function plant(): { proj: string; marker: string; cleanup: () => void } {
  const proj = mkdtempSync(join(tmpdir(), "c2-planted-"));
  const marker = join(proj, "..", `c2-marker-${process.pid}-${Date.now()}.txt`);
  mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
  const bin = join(proj, "node_modules", ".bin", "eslint");
  writeFileSync(bin, `#!/bin/sh\n{ echo "RAN"; env; } > ${marker} 2>/dev/null\necho '[]'\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(proj, "eslint.config.js"), "export default [];\n");
  writeFileSync(join(proj, "a.ts"), "export const a = 1;\n");
  return { proj, marker, cleanup: () => { rmSync(proj, { recursive: true, force: true }); rmSync(marker, { force: true }); } };
}

function withEnv<T>(set: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(set)) { before[k] = process.env[k]; if (set[k] === undefined) delete process.env[k]; else process.env[k] = set[k]; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

describe("C2 V1: a project's own planted eslint", () => {
  it("never sees the parent's secrets, whether or not a sandbox tool exists", () => {
    const p = plant();
    try {
      withEnv({ PURIX_STRICT_ISOLATION: undefined, PURIX_TEST_SECRET: "SECRET-IN-PARENT-ENV-12345", ANTHROPIC_API_KEY: "sk-ant-fake-parent-key" }, () => {
        checkIdioms([join(p.proj, "a.ts")], p.proj);
      });
      if (existsSync(p.marker)) {
        const seen = readFileSync(p.marker, "utf-8");
        expect(seen).not.toContain("SECRET-IN-PARENT-ENV-12345");
        expect(seen).not.toContain("sk-ant-fake-parent-key");
        expect(seen).not.toMatch(/^HOME=\/(root|home)\//m);
      }
    } finally { p.cleanup(); }
  });

  it("under PURIX_STRICT_ISOLATION=1 with no sandbox tool, the planted program does not run and the check says it did not run", () => {
    const p = plant();
    try {
      const sandboxPresent = (() => { try { return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"); } catch { return false; } })();
      if (sandboxPresent) return; // with a sandbox tool the program runs, contained; this case is about its absence
      const r = withEnv({ PURIX_STRICT_ISOLATION: "1" }, () => checkIdioms([join(p.proj, "a.ts")], p.proj));
      expect(r).toEqual({ findings: [], ran: false });
      expect(existsSync(p.marker)).toBe(false);
    } finally { p.cleanup(); }
  });
});
