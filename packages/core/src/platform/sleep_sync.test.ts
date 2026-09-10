// src/platform/sleep_sync.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { sleepSync } from "./sleep_sync";

describe("Sleep Sync", () => {
  it("sleeps synchronously for specified ms", () => {
    const start = Date.now();
    sleepSync(10);
    const duration = Date.now() - start;
    expect(duration).toBeGreaterThanOrEqual(5);
  });
});
