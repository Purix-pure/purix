// src/platform/spawn_sync.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "./spawn_sync";

describe("Spawn Sync", () => {
  it("spawns command and returns output", () => {
    const res = spawnSync(["node", "-e", "console.log('spawn')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("spawn");
  });
});
