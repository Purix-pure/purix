// isBwrapSetupFailure() and SandboxUnavailableError — the "bwrap itself is broken" detection that keeps a broken sandbox
// from being reported as real isolation.
import { describe, it } from "node:test";
import { expect } from "expect";
import { isBwrapSetupFailure, SandboxUnavailableError } from "./sandbox_exec";

describe("isBwrapSetupFailure", () => {
  const setupErrors = [
    "bwrap: Creating new namespace failed: Operation not permitted",
    "bwrap: setting up uid map: Permission denied",
    "bwrap: loopback: Failed RTM_NEWADDR",
    "bwrap: some namespace thing: permission denied",
    "bwrap: clone: operation not permitted",
    "User namespaces are not permitted in this container",
    "clone(CLONE_NEWUSER) failed",
  ];
  for (const stderr of setupErrors) {
    it(`recognises: ${stderr.slice(0, 44)}`, () => {
      expect(isBwrapSetupFailure(1, "", stderr)).toBe(true);
    });
  }
  it("is false on success, when the wrapped command produced output, or for unrelated errors", () => {
    expect(isBwrapSetupFailure(0, "", setupErrors[0]!)).toBe(false);
    expect(isBwrapSetupFailure(1, "some output", setupErrors[0]!)).toBe(false);
    expect(isBwrapSetupFailure(2, "", "tests failed: 3 assertions")).toBe(false);
    expect(isBwrapSetupFailure(null, "", "")).toBe(false);
  });
});

describe("SandboxUnavailableError", () => {
  it("is a real Error that explains the broken-bwrap situation", () => {
    const err = new SandboxUnavailableError("bwrap: Creating new namespace failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("bwrap is installed but failed to create an isolated sandbox");
  });
});
