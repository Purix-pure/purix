// src/tools/consent.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHumanGate, createPending, deletePending, describeInstall, formatInstallSummary, isAffirmative, isValidRequestId, listPending, readPending, sanitizeReason } from "./consent.js";
import { pendingDir } from "./state.js";
import { pipEntry, tempProject } from "./test_helpers.js";

describe("isAffirmative / human gate", () => {
  it("only an explicit yes counts", () => {
    for (const a of ["y", "Y", "yes", " YES "]) expect(isAffirmative(a)).toBe(true);
    for (const a of [null, "", "n", "no", "yep", "ok", "sure", "1"]) expect(isAffirmative(a)).toBe(false);
  });
  it("closed stdin (null) is a no", async () => {
    expect(await createHumanGate(async () => null).confirmInstall(describeInstall(pipEntry(), "/p", "cli"))).toBe(false);
  });
  it("is NOT bypassed by the test-only AUTO_CONFIRM switch other gates honour", async () => {
    const prev = { n: process.env.NODE_ENV, a: process.env.AUTO_CONFIRM };
    process.env.NODE_ENV = "test";
    process.env.AUTO_CONFIRM = "1";
    try {
      expect(await createHumanGate(async () => null).confirmInstall(describeInstall(pipEntry(), "/p", "cli"))).toBe(false);
    } finally {
      if (prev.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev.n;
      if (prev.a === undefined) delete process.env.AUTO_CONFIRM; else process.env.AUTO_CONFIRM = prev.a;
    }
  });
  it("the summary shows what will run, where, and that it was an agent's request", () => {
    const text = formatInstallSummary(describeInstall(pipEntry(), "/proj", "agent", "need a linter"));
    expect(text).toMatch(/--require-hashes/);
    expect(text).toMatch(/install scripts do not run/);
    expect(text).toMatch(/requested by an AI agent/);
    expect(text).toMatch(/untrusted/);
  });
});

describe("pending requests", () => {
  it("sanitizes untrusted reason text", () => {
    expect(sanitizeReason("a\u0000b\nc\u001b[31m" + "x".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(sanitizeReason("a\u0000b\nc")).toBe("a b c");
    expect(sanitizeReason(undefined)).toBe("");
  });
  it("creates, reads, lists and deletes", () => {
    const p = tempProject();
    try {
      const r = createPending(p.dir, "ruff", "agent", "lint it", new Date("2026-10-03T00:00:00Z"));
      expect(isValidRequestId(r.id)).toBe(true);
      expect(readPending(p.dir, r.id)?.toolId).toBe("ruff");
      expect(listPending(p.dir).map((x) => x.id)).toEqual([r.id]);
      deletePending(p.dir, r.id);
      expect(readPending(p.dir, r.id)).toBeNull();
      expect(existsSync(join(pendingDir(p.dir), `${r.id}.json`))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("never builds a path from an invalid id (traversal)", () => {
    const p = tempProject();
    try {
      for (const bad of ["../lock", "req-zzzzzzzzzzzz", "req-0123456789abc", "", "/etc/passwd"]) {
        expect(isValidRequestId(bad)).toBe(false);
        expect(readPending(p.dir, bad)).toBeNull();
      }
    } finally { p.cleanup(); }
  });
});
