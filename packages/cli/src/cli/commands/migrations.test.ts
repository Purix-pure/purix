// packages/cli/src/cli/commands/migrations.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerMigrationsCommands } from "./migrations";

describe("CLI Migrations Command", () => {
  it("exists as a function", () => {
    expect(typeof registerMigrationsCommands).toBe("function");
  });
});
