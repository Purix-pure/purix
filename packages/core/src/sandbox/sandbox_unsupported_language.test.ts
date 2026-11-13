// A10a-1 (blocker 4, D25 first step): a file in a language Purix has no provider for must never reach the TypeScript toolchain,
// never read as clean, and never reach the repair loop.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";
import { infrastructureStopOf } from "../recovery/infrastructure_stop.js";
import { verificationOutcome, notCheckedMessage } from "../verify/outcome.js";

let cwd0: string, dir: string;
beforeEach(() => {
  cwd0 = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-unsup-"));
  process.chdir(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true, noLib: true } }));
});
afterEach(() => { closeDb(); process.chdir(cwd0); safeRmSync(dir); });

describe("verifyInSandbox with a file in an unsupported language", () => {
  it("a Go-only change is reported as not checked, as an infrastructure result, not as TypeScript", () => {
    const r = verifyInSandbox("c1", [{ path: "main.go", new_content: "package main\nfunc main() {}\n" }], dir);
    expect(r.status).toBe("fail");
    if (r.status !== "fail") return;
    expect(r.infrastructure).toBe("unsupported_language");
    expect(r.reason).toMatch(/unsupported language, not checked/i);
    expect(r.reason).toContain("main.go");
    expect(r.reason).toContain("Go");
    expect(r.reason).not.toMatch(/typescript|tsc/i);
  });

  it("is never repair-eligible: the repair loop stops on it", () => {
    const r = verifyInSandbox("c1", [{ path: "Main.java", new_content: "class Main {}" }], dir);
    expect(infrastructureStopOf(r)?.kind).toBe("unsupported_language");
    expect(verificationOutcome(r)).toBe("error");
  });

  it("names every unchecked file", () => {
    const r = verifyInSandbox("c1", [{ path: "a.go", new_content: "package a" }, { path: "b.rs", new_content: "fn main() {}" }], dir);
    expect(r.status === "fail" && r.reason).toContain("a.go");
    expect(r.status === "fail" && r.reason).toContain("b.rs");
  });

  it("a Python file next to a Go file is not refused for the Go file's sake: the Python file is checked, the Go file is listed as not checked, and the result is not 'pass' without it", () => {
    const r = verifyInSandbox("c1", [{ path: "ok.py", new_content: "x = 1\n" }, { path: "main.go", new_content: "package main" }], dir);
    // Whatever the Python toolchain says here (installed or not), the Go file must not have been handed to it or to tsc,
    // and a pass must carry the not-checked list.
    if (r.status === "pass") {
      expect(r.notChecked).toEqual(["main.go"]);
      expect(verificationOutcome(r)).toBe("skipped");
    } else {
      expect(r.status === "fail" ? r.reason : r.reason).not.toContain("main.go: error TS");
    }
  });

  it("documents and data are not source code in an unsupported language: they are not called unsupported", () => {
    const r = verifyInSandbox("c1", [{ path: "notes.md", new_content: "# hi\n" }], dir);
    expect(r.status === "fail" && r.infrastructure).not.toBe("unsupported_language");
  });
});

describe("notCheckedMessage", () => {
  it("says not checked, never clean or compiled", () => {
    const m = notCheckedMessage(["main.go"]) ?? "";
    expect(m).toMatch(/not checked/i);
    expect(m).not.toMatch(/\bit compiled\b|\bclean\b|\bpassed\b|\bverified\b/i);
  });
  it("is undefined for nothing", () => { expect(notCheckedMessage([])).toBeUndefined(); expect(notCheckedMessage(undefined)).toBeUndefined(); });
});
