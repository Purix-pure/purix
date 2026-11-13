// packages/core/src/cli-io/exit_codes.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { EXIT, EXIT_WORDS, exitCodeForError } from "./exit_codes";

describe("exit codes", () => {
  test("the map matches the documented numbers", () => {
    expect(EXIT).toEqual({ OK: 0, CHECK_FAILED: 1, USAGE: 2, LOGIN_REQUIRED: 3, CLIENT_TOO_OLD: 4, INTEGRITY: 5 });
    expect(Object.keys(EXIT_WORDS)).toHaveLength(6);
  });

  test("errors map by name; anything else is a plain failure", () => {
    const named = (n: string) => Object.assign(new Error("x"), { name: n });
    expect(exitCodeForError(named("LoginRequiredError"))).toBe(3);
    expect(exitCodeForError(named("ClientTooOldError"))).toBe(4);
    expect(exitCodeForError(named("IntegrityError"))).toBe(5);
    expect(exitCodeForError(new Error("boom"))).toBe(1);
    expect(exitCodeForError("string")).toBe(1);
  });
});
