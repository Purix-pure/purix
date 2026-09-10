// src/sandbox/sandbox_exec.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { runIsolated, isBwrapSetupFailure, SandboxUnavailableError } from "./sandbox_exec";

describe("Sandbox Exec", () => {
  it("runs command (unisolated or isolated)", () => {
    const res = runIsolated(["node", "-e", "console.log('hello')"], { cwd: process.cwd(), writableDir: process.cwd() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello");
  });

  it("handles non-zero exit code gracefully", () => {
    const res = runIsolated(["node", "-e", "process.exit(1)"], { cwd: process.cwd(), writableDir: process.cwd() });
    expect(res.exitCode).toBe(1);
  });
});

// Docker/sandbox isolation fix: bwrap can be present on PATH but unable to
// actually create a sandbox (e.g. inside a non-privileged Docker
// container). isBwrapSetupFailure() is the pure detection logic that lets
// runIsolated distinguish "bwrap itself failed to start" from "the
// sandboxed command legitimately exited non-zero," without needing to
// actually break user namespaces in this test environment to exercise it.
describe("isBwrapSetupFailure", () => {
  it("returns false for a successful run (exit 0)", () => {
    expect(isBwrapSetupFailure(0, "hello\n", "")).toBe(false);
  });

  it("returns false when the wrapped command itself exits non-zero but produced output", () => {
    expect(isBwrapSetupFailure(1, "some output before failing\n", "app error: bad input")).toBe(false);
  });

  it("returns false when the wrapped command exits non-zero with no output and unrelated stderr", () => {
    // no stdout AND non-zero exit is ambiguous on its own — only a
    // recognized bwrap-self-failure signature in stderr should trip this
    expect(isBwrapSetupFailure(1, "", "some unrelated tool error")).toBe(false);
  });

  it("returns true for bwrap's real 'Creating new namespace failed' signature (the Docker case)", () => {
    const stderr = "bwrap: Creating new namespace failed: Operation not permitted\n";
    expect(isBwrapSetupFailure(1, "", stderr)).toBe(true);
  });

  it("returns true for bwrap's uid map setup failure signature", () => {
    const stderr = "bwrap: setting up uid map: Permission denied\n";
    expect(isBwrapSetupFailure(1, "", stderr)).toBe(true);
  });

  it("returns true for the generic 'user namespaces are not permitted' kernel message", () => {
    const stderr = "user namespaces are not permitted\n";
    expect(isBwrapSetupFailure(1, "", stderr)).toBe(true);
  });
});

describe("SandboxUnavailableError", () => {
  it("carries the raw bwrap stderr and actionable fix guidance", () => {
    const err = new SandboxUnavailableError("bwrap: Creating new namespace failed: Operation not permitted\n");
    expect(err.name).toBe("SandboxUnavailableError");
    expect(err.message).toContain("--cap-add SYS_ADMIN");
    expect(err.message).toContain("Creating new namespace failed");
  });
});