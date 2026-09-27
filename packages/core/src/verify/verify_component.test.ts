// verifyComponent(): every outcome, including the TS5112 --ignoreConfig retry (TEST-REPORT F11), using a fake tsc
// so no real TypeScript install is needed. The fake is a plain JS file run via `node`, so this works on Windows too.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyComponent, rollbackFiles } from "./verify";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-verify-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeTsc(script: string) {
  mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), script);
}
const TS5112 = "error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.";

describe("verifyComponent", () => {
  it("fails fast when there is nothing to verify", () => {
    expect(verifyComponent([], dir)).toEqual({ status: "fail", reason: "No files to verify" });
  });
  it("reports not_installed with the install hint matching the project's package manager", () => {
    const cases: [string | null, string][] = [
      ["pnpm-lock.yaml", "pnpm add -D typescript"],
      ["yarn.lock", "yarn add -D typescript"],
      ["bun.lockb", "bun add -D typescript"],
      ["bun.lock", "bun add -D typescript"],
      [null, "npm install -D typescript"],
    ];
    for (const [lock, hint] of cases) {
      const d = mkdtempSync(join(tmpdir(), "purix-hint-"));
      try {
        if (lock) writeFileSync(join(d, lock), "");
        const r = verifyComponent(["a.ts"], d);
        expect(r.status).toBe("not_installed");
        if (r.status === "not_installed") expect(r.actionHint).toContain(hint);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
  it("passes when tsc exits 0", () => {
    fakeTsc("process.exit(0);");
    expect(verifyComponent(["a.ts"], dir)).toEqual({ status: "pass", isolation: "none" });
  });
  it("fails with tsc's stderr, then stdout, then a generic message", () => {
    fakeTsc('console.error("boom on stderr"); process.exit(2);');
    expect(verifyComponent(["a.ts"], dir)).toEqual({ status: "fail", reason: "boom on stderr" });
    fakeTsc('console.log("only stdout"); process.exit(2);');
    expect(verifyComponent(["a.ts"], dir)).toEqual({ status: "fail", reason: "only stdout" });
    fakeTsc("process.exit(2);");
    expect(verifyComponent(["a.ts"], dir)).toEqual({ status: "fail", reason: "tsc failed with no output" });
  });
  it("retries once with --ignoreConfig when tsc reports TS5112 for the file-list form (no local tsconfig)", () => {
    fakeTsc(`if (process.argv.includes("--ignoreConfig")) process.exit(0); console.error(${JSON.stringify(TS5112)}); process.exit(1);`);
    expect(verifyComponent(["a.ts"], dir)).toEqual({ status: "pass", isolation: "none" });
  });
  it("does not retry when a local tsconfig.json exists (it uses -p instead)", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    fakeTsc(`if (process.argv.includes("--ignoreConfig")) process.exit(0); console.error(${JSON.stringify(TS5112)}); process.exit(1);`);
    const r = verifyComponent(["a.ts"], dir);
    expect(r.status).toBe("fail");
  });
  it("does not retry for other failures", () => {
    fakeTsc(`if (process.argv.includes("--ignoreConfig")) process.exit(0); console.error("error TS2307: nope"); process.exit(1);`);
    expect(verifyComponent(["a.ts"], dir).status).toBe("fail");
  });
});

describe("rollbackFiles", () => {
  it("removes files that exist and ignores ones that do not", () => {
    const present = join(dir, "present.txt");
    writeFileSync(present, "x");
    rollbackFiles([present, join(dir, "absent.txt")]);
    expect(existsSync(present)).toBe(false);
  });
});
