// src/state/governed_lock_newer.test.ts
//
// H4: purix.lock.json written by a newer Purix (schema 2 or more) is reported as that, with the way out, not as "unknown shape".
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLock, LOCK_FILENAME } from "./governed_lock";
import { safeRmSync } from "../platform/fs_retry.js";

function lockWith(content: unknown): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "purix-lock-newer-"));
  writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify(content));
  return { dir, done: () => safeRmSync(dir) };
}

describe("readLock and a newer schema", () => {
  it("names a newer schema and says to upgrade", () => {
    const { dir, done } = lockWith({ schema: 2, components: [] });
    try {
      const r = readLock(dir);
      expect(r.state).toBe("damaged");
      if (r.state === "damaged") {
        expect(r.detail).toMatch(/written by a newer Purix/);
        expect(r.detail).toMatch(/schema 2/);
        expect(r.detail).toMatch(/upgrade/i);
      }
    } finally {
      done();
    }
  });

  it("keeps the old wording for a shape that is simply wrong", () => {
    const { dir, done } = lockWith({ schema: "x", components: 3 });
    try {
      const r = readLock(dir);
      expect(r.state === "damaged" && r.detail).toBe("unknown shape or schema version");
    } finally {
      done();
    }
  });

  it("still reads a schema 1 lock", () => {
    const { dir, done } = lockWith({ schema: 1, components: [] });
    try {
      expect(readLock(dir).state).toBe("ok");
    } finally {
      done();
    }
  });
});
