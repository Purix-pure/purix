// src/state/hash.test.ts
//
// computeSyncHash underpins both drift detection (state/drift.ts) and the
// oscillation guard (recovery/oscillation_guard.ts) — anything that hashes
// wrong here silently breaks "did the files actually change" everywhere
// downstream. Pure function, no fixtures needed.
import { describe, it } from "node:test";
import { expect } from "expect";
import { computeSyncHash } from "./hash";

describe("computeSyncHash", () => {
  it("is deterministic: the same input produces the same hash across calls", () => {
    const files = [{ path: "a.ts", content: "hello" }];
    expect(computeSyncHash(files)).toBe(computeSyncHash(files));
  });

  it("is order-independent: shuffled file order produces the same hash", () => {
    const a = [
      { path: "a.ts", content: "aaa" },
      { path: "b.ts", content: "bbb" },
      { path: "c.ts", content: "ccc" },
    ];
    const shuffled = [a[2]!, a[0]!, a[1]!];
    expect(computeSyncHash(shuffled)).toBe(computeSyncHash(a));
  });

  it("changes when any file's content changes", () => {
    const before = [{ path: "a.ts", content: "hello" }];
    const after = [{ path: "a.ts", content: "hello!" }];
    expect(computeSyncHash(before)).not.toBe(computeSyncHash(after));
  });

  it("changes when a file's path changes, even if content is identical", () => {
    const a = [{ path: "a.ts", content: "same" }];
    const b = [{ path: "b.ts", content: "same" }];
    expect(computeSyncHash(a)).not.toBe(computeSyncHash(b));
  });

  it("does not let content silently shift across a path/content boundary", () => {
    // Without a separator between path and content, {path:"ab", content:"c"}
    // and {path:"a", content:"bc"} would hash identically. The \0 separator
    // in computeSyncHash exists specifically to prevent this.
    const a = [{ path: "ab", content: "c" }];
    const b = [{ path: "a", content: "bc" }];
    expect(computeSyncHash(a)).not.toBe(computeSyncHash(b));
  });

  it("distinguishes an empty file list from a list with an empty file", () => {
    const empty = computeSyncHash([]);
    const emptyFile = computeSyncHash([{ path: "a.ts", content: "" }]);
    expect(empty).not.toBe(emptyFile);
  });

  it("does not mutate the input array's order", () => {
    const files = [
      { path: "b.ts", content: "2" },
      { path: "a.ts", content: "1" },
    ];
    const originalOrder = files.map((f) => f.path);
    computeSyncHash(files);
    expect(files.map((f) => f.path)).toEqual(originalOrder);
  });

  it("produces a 64-character lowercase hex sha256 digest", () => {
    const hash = computeSyncHash([{ path: "a.ts", content: "x" }]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});