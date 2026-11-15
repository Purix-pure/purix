// packages/cli/src/cli.exit_codes.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { exitCodeForFailure, exitCodeForCommanderExit } from "./cli";
import { exitCodeForError } from "@purix/core/cli-io/exit_codes";

describe("cli exit-code mirror", () => {
  test("cli.ts and core exit_codes agree for every named error", () => {
    for (const name of ["LoginRequiredError", "ClientTooOldError", "IntegrityError", "Other"]) {
      const err = Object.assign(new Error("x"), { name });
      expect(exitCodeForFailure(err)).toBe(exitCodeForError(err));
    }
  });

  test("a command line Commander cannot use exits 2, and exit 0 is never changed", () => {
    for (const code of ["commander.unknownCommand", "commander.unknownOption", "commander.missingArgument", "commander.excessArguments", "commander.help"]) {
      expect(exitCodeForCommanderExit({ code, exitCode: 1 })).toBe(2);
    }
    expect(exitCodeForCommanderExit({ code: "commander.help", exitCode: 0 })).toBe(0);
    expect(exitCodeForCommanderExit({ code: "commander.version", exitCode: 0 })).toBe(0);
    // an exit a command chose itself (program.error with its own code) keeps that code
    expect(exitCodeForCommanderExit({ code: "commander.error", exitCode: 3 })).toBe(3);
  });
});
