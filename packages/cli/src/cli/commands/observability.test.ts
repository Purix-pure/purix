// packages/cli/src/cli/commands/observability.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerObservabilityCommands } from "./observability";

describe("CLI Observability Command", () => {
  it("exists as a function", () => {
    expect(typeof registerObservabilityCommands).toBe("function");
  });
});
