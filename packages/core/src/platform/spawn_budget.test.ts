// A1: tier budgets, deadline, output cap and the `stopped` classification of spawnSync.
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync, TIER_BUDGETS, DEFAULT_SPAWN_TIER, resolveSpawnBudget, stopFromErrorCode } from "./spawn_sync.js";

describe("tier budget table", () => {
  it("has five tiers with rising deadlines and a 1 MiB output cap", () => {
    const d = (["T0", "T1", "T2", "T3", "T4"] as const).map((t) => TIER_BUDGETS[t].deadlineMs);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    for (const t of Object.values(TIER_BUDGETS)) expect(t.maxOutputBytes).toBe(1024 * 1024);
    expect(Object.isFrozen(TIER_BUDGETS)).toBe(true);
  });
  it("defaults to T3 and lets a valid per-call override win", () => {
    expect(resolveSpawnBudget().tier).toBe(DEFAULT_SPAWN_TIER);
    expect(resolveSpawnBudget({ tier: "T1" }).deadlineMs).toBe(TIER_BUDGETS.T1.deadlineMs);
    expect(resolveSpawnBudget({ tier: "T1", deadlineMs: 50 }).deadlineMs).toBe(50);
    expect(resolveSpawnBudget({ tier: "T1", deadlineMs: -5 }).deadlineMs).toBe(TIER_BUDGETS.T1.deadlineMs);
    expect(resolveSpawnBudget({ deadlineMs: Number.NaN }).deadlineMs).toBe(TIER_BUDGETS[DEFAULT_SPAWN_TIER].deadlineMs);
  });
});

describe("spawnSync budgets", () => {
  it("stops a child that runs past its deadline and says timeout", () => {
    const r = spawnSync(["node", "-e", "setTimeout(()=>{}, 8000)"], { deadlineMs: 300 });
    expect(r.stopped).toBe("timeout");
    expect(r.exitCode).toBeNull();
    expect(r.durationMs!).toBeLessThan(4000);
  });
  it("reports output over the cap as output_limit, not as a missing binary", () => {
    const r = spawnSync(["node", "-e", "process.stdout.write('x'.repeat(2*1024*1024))"], { maxOutputBytes: 100_000 });
    expect(r.stopped).toBe("output_limit");
    expect(r.exitCode).toBeNull();
  });
  it("reports a missing binary as not_found", () => {
    expect(spawnSync(["purix-no-such-binary-a1"]).stopped).toBe("not_found");
  });
  it("leaves a normal non-zero exit alone: no `stopped`", () => {
    const r = spawnSync(["node", "-e", "process.stdout.write('hi'); process.exit(3)"]);
    expect(r.exitCode).toBe(3);
    expect(r.stopped).toBeUndefined();
    expect(r.stdout.toString()).toBe("hi");
  });
  it("output just under the cap is unaffected", () => {
    const r = spawnSync(["node", "-e", "process.stdout.write('y'.repeat(50000))"], { maxOutputBytes: 100_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().length).toBe(50000);
  });
  it("an empty command is a spawn_error", () => {
    expect(spawnSync([]).stopped).toBe("spawn_error");
  });
});

describe("stopFromErrorCode", () => {
  it("maps codes", () => {
    expect(stopFromErrorCode("ETIMEDOUT")).toBe("timeout");
    expect(stopFromErrorCode("ENOBUFS")).toBe("output_limit");
    expect(stopFromErrorCode("ENOENT")).toBe("not_found");
    for (const c of ["EMFILE", "ENFILE", "ENOMEM", "EAGAIN"]) expect(stopFromErrorCode(c)).toBe("resource_limit");
    expect(stopFromErrorCode("EACCES")).toBe("spawn_error");
    expect(stopFromErrorCode(undefined)).toBe("spawn_error");
  });
});
