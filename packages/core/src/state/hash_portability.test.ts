// The same project must hash the same on every OS (Windows test D13: a CRLF rewrite read as an outside edit).
import { describe, it } from "node:test";
import { expect } from "expect";
import { computeSyncHash } from "./hash";

const f = (path: string, content: string) => ({ path, content });

describe("computeSyncHash is portable", () => {
  it("ignores CRLF versus LF", () => {
    expect(computeSyncHash([f("a.ts", "x\r\ny\r\n")])).toBe(computeSyncHash([f("a.ts", "x\ny\n")]));
  });
  it("ignores backslash versus slash in paths", () => {
    expect(computeSyncHash([f("src\\a.ts", "x")])).toBe(computeSyncHash([f("src/a.ts", "x")]));
  });
  it("is still order-independent", () => {
    expect(computeSyncHash([f("b.ts", "1"), f("a.ts", "2")])).toBe(computeSyncHash([f("a.ts", "2"), f("b.ts", "1")]));
  });
  it("still changes for every real difference", () => {
    const base = computeSyncHash([f("a.ts", "x\ny\n")]);
    expect(computeSyncHash([f("a.ts", "x\nz\n")])).not.toBe(base); // content
    expect(computeSyncHash([f("b.ts", "x\ny\n")])).not.toBe(base); // path
    expect(computeSyncHash([f("a.ts", "x\ry\n")])).not.toBe(base); // a lone CR is a real byte
    expect(computeSyncHash([f("a.ts", "\uFEFFx\ny\n")])).not.toBe(base); // a byte-order mark is a real byte
    expect(computeSyncHash([f("a.ts", "x\ny\n"), f("c.ts", "")])).not.toBe(base); // an added file
  });
});
