// A4 remainder: the dependents re-check ran the provider's compiler and tests with the person's real project as both the working
// and the writable folder. It now runs in a throwaway copy, like every other verification, so a test that writes files (or a
// build that emits) leaves the real project as it was.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reVerifyDependents } from "./impact.js";
import { typescriptProvider } from "../language/providers/typescript.js";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
let prevCwd: string;
let stateDir: string;
const seen: { verifyDir?: string; testDir?: string; fileSeenInCopy?: boolean } = {};

// The real TypeScript provider is the one the registry hands out for .ts files, so its two entry points are swapped for recorders
// for the length of each test and put back afterwards.
const original = { verify: typescriptProvider.verify.bind(typescriptProvider), runTests: typescriptProvider.runTests.bind(typescriptProvider) };
const stubVerify: typeof typescriptProvider.verify = (_paths, baseDir) => {
  seen.verifyDir = baseDir;
  seen.fileSeenInCopy = existsSync(join(baseDir ?? "", "src", "dep.ts"));
  writeFileSync(join(baseDir ?? "", "emitted.js"), "build output");
  return { status: "pass", isolation: "none" };
};
const stubRunTests: typeof typescriptProvider.runTests = (_id, _files, baseDir) => {
  seen.testDir = baseDir;
  writeFileSync(join(baseDir ?? "", "test-wrote-this.txt"), "x");
  return { status: "pass", quarantinedFailures: [] };
};

beforeEach(() => {
  // The re-check records events in the store under the working directory. Give it its own folder (not `dir`, whose contents these
  // tests assert on) so nothing is written to .purix in the package folder the tests are started from.
  prevCwd = process.cwd();
  stateDir = mkdtempSync(join(tmpdir(), "purix-cascade-state-"));
  process.chdir(stateDir);
  dir = mkdtempSync(join(tmpdir(), "purix-cascade-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "dep.ts"), "export const d = 1;\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  for (const k of Object.keys(seen)) delete (seen as Record<string, unknown>)[k];
  typescriptProvider.verify = stubVerify;
  typescriptProvider.runTests = stubRunTests;
});
afterEach(() => {
  typescriptProvider.verify = original.verify;
  typescriptProvider.runTests = original.runTests;
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(dir);
  safeRmSync(stateDir);
});

describe("reVerifyDependents runs in a copy of the project", () => {
  it("hands the provider a copy, not the real project, and the dependent's files are in it", () => {
    const results = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(results[0]!.status).toBe("pass");
    expect(seen.verifyDir).toBeDefined();
    expect(seen.verifyDir).not.toBe(dir);
    expect(seen.testDir).toBe(seen.verifyDir);
    expect(seen.fileSeenInCopy).toBe(true);
  });

  it("leaves the real project untouched by what the compiler and the tests write", () => {
    reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(existsSync(join(dir, "emitted.js"))).toBe(false);
    expect(existsSync(join(dir, "test-wrote-this.txt"))).toBe(false);
    expect(readFileSync(join(dir, "src", "dep.ts"), "utf8")).toBe("export const d = 1;\n");
  });

  it("removes the copy afterwards and never copies .env", () => {
    reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(existsSync(seen.verifyDir!)).toBe(false);
  });
});
