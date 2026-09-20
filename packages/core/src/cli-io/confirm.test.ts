// src/cli-io/confirm.test.ts
//
// Regression coverage for GAPS-REPORT-2 §1: AUTO_CONFIRM=1 used to bypass
// every human-approval checkpoint in the system regardless of where it was
// set — a shell profile, a base Docker image, or a CI pipeline's global
// environment could all plausibly set a variable this common for an
// unrelated reason. It's now restricted to NODE_ENV === "test", mirroring
// the same pattern tier.ts's PURIX_DEV_TIER override already uses.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { isAutoConfirmActive, confirm } from "./confirm";

let originalAutoConfirm: string | undefined;
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalAutoConfirm = process.env.AUTO_CONFIRM;
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalAutoConfirm === undefined) delete process.env.AUTO_CONFIRM;
  else process.env.AUTO_CONFIRM = originalAutoConfirm;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("isAutoConfirmActive", () => {
  it("is false when AUTO_CONFIRM=1 but NODE_ENV is not \"test\" (the real-world reachable case)", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTO_CONFIRM = "1";
    expect(isAutoConfirmActive()).toBe(false);
  });

  it("is false when NODE_ENV is unset entirely, even with AUTO_CONFIRM=1", () => {
    delete process.env.NODE_ENV;
    process.env.AUTO_CONFIRM = "1";
    expect(isAutoConfirmActive()).toBe(false);
  });

  it("is false when NODE_ENV === \"test\" but AUTO_CONFIRM is unset", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AUTO_CONFIRM;
    expect(isAutoConfirmActive()).toBe(false);
  });

  it("is true only when both NODE_ENV === \"test\" and AUTO_CONFIRM === \"1\" are set", () => {
    process.env.NODE_ENV = "test";
    process.env.AUTO_CONFIRM = "1";
    expect(isAutoConfirmActive()).toBe(true);
  });
});

describe("confirm() — auto-confirm path", () => {
  it("resolves true without touching stdin when the test-only bypass is active", async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTO_CONFIRM = "1";
    const result = await confirm("Proceed?");
    expect(result).toBe(true);
  });
});