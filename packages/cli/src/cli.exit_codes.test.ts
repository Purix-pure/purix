// packages/cli/src/cli.exit_codes.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { exitCodeForFailure } from "./cli";
import { exitCodeForError } from "@purix/core/cli-io/exit_codes";

describe("cli exit-code mirror", () => {
  test("cli.ts and core exit_codes agree for every named error", () => {
    for (const name of ["LoginRequiredError", "ClientTooOldError", "IntegrityError", "Other"]) {
      const err = Object.assign(new Error("x"), { name });
      expect(exitCodeForFailure(err)).toBe(exitCodeForError(err));
    }
  });
});
