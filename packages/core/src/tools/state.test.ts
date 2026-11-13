// src/tools/state.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeFileAtomic } from "../platform/atomic_write.js";
import { lockPath, readLock, toolsDir, writeLock } from "./state.js";
import { tempProject } from "./test_helpers.js";

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temp file behind", () => {
    const p = tempProject();
    try {
      writeFileAtomic(join(p.dir, "a", "f.json"), "hello");
      expect(readFileSync(join(p.dir, "a", "f.json"), "utf-8")).toBe("hello");
      expect(readdirSync(join(p.dir, "a"))).toEqual(["f.json"]);
    } finally { p.cleanup(); }
  });
  it("retries a transient Windows-style EPERM and then succeeds", () => {
    const p = tempProject();
    try {
      let n = 0;
      const sleeps: number[] = [];
      writeFileAtomic(join(p.dir, "f"), "x", {
        rename: (from, to) => { if (n++ < 2) { const e = new Error("locked") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; } writeFileSync(to, readFileSync(from)); },
        sleep: (ms) => sleeps.push(ms),
      });
      expect(n).toBe(3);
      expect(sleeps.length).toBe(2);
      expect(readFileSync(join(p.dir, "f"), "utf-8")).toBe("x");
    } finally { p.cleanup(); }
  });
  it("does not retry a non-transient error, and cleans its temp file", () => {
    const p = tempProject();
    try {
      let n = 0;
      expect(() => writeFileAtomic(join(p.dir, "f"), "x", { rename: () => { n++; const e = new Error("nope") as NodeJS.ErrnoException; e.code = "ENOSPC"; throw e; } })).toThrow("nope");
      expect(n).toBe(1);
      expect(readdirSync(p.dir)).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("gives up after the retry budget", () => {
    const p = tempProject();
    try {
      let n = 0;
      expect(() => writeFileAtomic(join(p.dir, "f"), "x", { retries: 3, sleep: () => {}, rename: () => { n++; const e = new Error("busy") as NodeJS.ErrnoException; e.code = "EBUSY"; throw e; } })).toThrow("busy");
      expect(n).toBe(4);
    } finally { p.cleanup(); }
  });
});

describe("readJsonFile / readLock", () => {
  it("missing, empty and corrupt are distinguished", () => {
    const p = tempProject();
    try {
      expect(readJsonFile(join(p.dir, "none.json")).kind).toBe("missing");
      writeFileSync(join(p.dir, "e.json"), "  ");
      expect(readJsonFile(join(p.dir, "e.json"))).toEqual({ kind: "corrupt", error: "file is empty" });
      writeFileSync(join(p.dir, "c.json"), "{nope");
      expect(readJsonFile(join(p.dir, "c.json")).kind).toBe("corrupt");
    } finally { p.cleanup(); }
  });
  it("a missing lock is an empty lock; a wrongly-shaped lock is corrupt", () => {
    const p = tempProject();
    try {
      expect(readLock(p.dir)).toEqual({ kind: "ok", lock: { version: 1, records: [] } });
      mkdirSync(toolsDir(p.dir), { recursive: true });
      writeFileSync(lockPath(p.dir), JSON.stringify({ version: 2, records: [] }));
      expect(readLock(p.dir).kind).toBe("corrupt");
    } finally { p.cleanup(); }
  });
  it("writeLock sorts records and round-trips", () => {
    const p = tempProject();
    try {
      const rec = (id: string) => ({ id, package: id, version: "1.0.0", method: "pip-venv" as const, lockSha256: "x", installedAt: "t", binRelPath: "b" });
      writeLock(p.dir, { version: 1, records: [rec("z"), rec("a")] });
      const r = readLock(p.dir);
      expect(r.kind === "ok" && r.lock.records.map((x) => x.id)).toEqual(["a", "z"]);
      expect(existsSync(lockPath(p.dir))).toBe(true);
    } finally { p.cleanup(); }
  });
});
