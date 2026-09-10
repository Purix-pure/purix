// src/sandbox/sandbox_env.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { sandboxEnv } from "./sandbox_env";

describe("Sandbox Env", () => {
  it("strips NODE_TEST_CONTEXT", () => {
    const env = sandboxEnv();
    expect(env.NODE_TEST_CONTEXT).toBeUndefined();
  });
});
