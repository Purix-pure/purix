// What the verification copy may contain. Secrets, the manifest and locks live in .purix and must
// never be copied; .purix/tmp (toolchains) is the one allowed exception (see sandbox.ts).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox.js";
import { closeDb } from "../manifest/store.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, dir: string;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-copyscope-")); process.chdir(dir); });
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

describe("verification copy scope", () => {
  it("copies .purix/tmp but not secrets, config or the manifest; never .env or .git", () => {
    mkdirSync(join(dir, ".purix", "tmp", "python"), { recursive: true });
    writeFileSync(join(dir, ".purix", "tmp", "python", "marker"), "x");
    writeFileSync(join(dir, ".purix", "secrets.master.key"), "k");
    writeFileSync(join(dir, ".purix", "config.json"), "{}");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    writeFileSync(join(dir, ".env"), "A=1");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");

    let seen: Record<string, boolean> = {};
    const p: LanguageProvider = {
      id: "copyscope", minSupportedVersion: "1.0.0", detect: () => false,
      verify: (_paths, baseDir) => {
        const base = baseDir ?? "";
        seen = {
          tmp: existsSync(join(base, ".purix", "tmp", "python", "marker")),
          key: existsSync(join(base, ".purix", "secrets.master.key")),
          cfg: existsSync(join(base, ".purix", "config.json")),
          git: existsSync(join(base, ".git")),
          env: existsSync(join(base, ".env")),
          src: existsSync(join(base, "app.ts")),
        };
        return { status: "pass", isolation: "none" };
      },
      runTests: () => ({ status: "pass", quarantinedFailures: [] }),
      checkIdiom: () => ({ ran: true, findings: [] }),
      auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
      getFingerprint: async () => ({}),
    };
    registerLanguageProvider(p);
    verifyInSandbox("c", [{ path: "component.copyscope", new_content: "x" }], dir, "copyscope");
    expect(seen).toEqual({ tmp: true, key: false, cfg: false, git: false, env: false, src: true });
  });
});
