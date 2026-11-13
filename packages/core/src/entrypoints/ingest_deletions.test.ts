// Plan 0.4: which diffs may delete files, and what a deletion costs in trust.
import { describe, it } from "node:test";
import { expect } from "expect";
import { planDeletions, holdDeletionForHuman } from "./ingest_deletions";
import type { IngestedFileChange } from "./ingest";

const del = (path: string): IngestedFileChange => ({ path, new_content: "", status: "deleted" });
const mod = (path: string): IngestedFileChange => ({ path, new_content: "x\n", status: "modified" });
const add = (path: string): IngestedFileChange => ({ path, new_content: "x\n", status: "added" });
const isTest = (p: string) => /\.test\./.test(p);
const base = { tracked: ["src/a.ts", "src/b.ts"], originalFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }], isTestFile: isTest };

describe("planDeletions", () => {
  it("a diff with no deletion has nothing to plan", () => {
    expect(planDeletions({ ...base, ingested: [mod("src/a.ts")] })).toEqual({ ok: true, deletedPaths: [] });
  });
  it("accepts a tracked file when others remain", () => {
    expect(planDeletions({ ...base, ingested: [mod("src/a.ts"), del("src/b.ts")] })).toEqual({ ok: true, deletedPaths: ["src/b.ts"] });
  });
  it("refuses a file the component does not track, and says Purix does not guess its owner", () => {
    const r = planDeletions({ ...base, ingested: [del("src/other.ts")] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/does not track: src\/other\.ts/);
  });
  it("refuses a tracked file that is no longer on disk", () => {
    const r = planDeletions({ ...base, originalFiles: [{ path: "src/a.ts" }], ingested: [del("src/b.ts")] });
    expect(r.ok).toBe(false);
  });
  it("refuses to delete a test file, because that is a way to make a failing check pass", () => {
    const r = planDeletions({ ...base, tracked: ["src/a.ts", "src/a.test.ts"], originalFiles: [{ path: "src/a.ts" }, { path: "src/a.test.ts" }], ingested: [del("src/a.test.ts")] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/test file/);
  });
  it("refuses a diff that would leave the component empty, and points at purix delete", () => {
    const r = planDeletions({ ...base, ingested: [del("src/a.ts"), del("src/b.ts")] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/purix delete/);
  });
  it("replacing every file counts as leaving files when the diff adds one", () => {
    expect(planDeletions({ ...base, ingested: [del("src/a.ts"), del("src/b.ts"), add("src/c.ts")] }).ok).toBe(true);
  });
  it("lists a path once even if the diff names it twice", () => {
    const r = planDeletions({ ...base, ingested: [del("src/b.ts"), del("src/b.ts")] });
    expect(r).toEqual({ ok: true, deletedPaths: ["src/b.ts"] });
  });
});

describe("holdDeletionForHuman", () => {
  it("turns an auto-commit into a confirmation when files are deleted, and names them", () => {
    const d = holdDeletionForHuman({ action: "auto_commit", reason: "high confidence" }, ["src/b.ts"]);
    expect(d.action).toBe("human_confirm");
    expect(d.reason).toMatch(/src\/b\.ts/);
  });
  it("leaves an abort, a confirmation and a change with no deletion alone", () => {
    const abort = { action: "abort" as const, reason: "no" };
    const confirm = { action: "human_confirm" as const, reason: "low" };
    const auto = { action: "auto_commit" as const, reason: "ok" };
    expect(holdDeletionForHuman(abort, ["a"])).toBe(abort);
    expect(holdDeletionForHuman(confirm, ["a"])).toBe(confirm);
    expect(holdDeletionForHuman(auto, [])).toBe(auto);
  });
});
