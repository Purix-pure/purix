// packages/cli/src/cli/commands/backup.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerBackupCommands } from "./backup";

describe("CLI Backup Command", () => {
  it("exists as a function", () => {
    expect(typeof registerBackupCommands).toBe("function");
  });
});
