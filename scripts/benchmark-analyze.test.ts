import { describe, it } from "node:test";
import { expect } from "expect";
import { analyze, signTestP, median, bootstrapMedianCI, parseRunsFile, formatReport, MIN_PAIRS, type Pair } from "./benchmark-analyze.ts";

const pairs = (n: number, f: (i: number) => Pick<Pair, "plain" | "purix">): Pair[] => Array.from({ length: n }, (_, i) => ({ task: `t${i}`, ...f(i) }));

describe("benchmark analysis", () => {
  it("sign test: known values", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(5, 5)).toBe(1);
    expect(signTestP(0, 10)).toBeCloseTo(2 / 1024, 6);
    expect(signTestP(2, 8)).toBeCloseTo(0.109375, 6);
  });
  it("median and a repeatable interval", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const d = [-5, -4, -6, -3, -5, -4, -6, -5, -4, -5];
    expect(bootstrapMedianCI(d)).toEqual(bootstrapMedianCI(d));
    const [lo, hi] = bootstrapMedianCI(d); expect(lo).toBeLessThanOrEqual(-4); expect(hi).toBeLessThan(0);
  });
  it("too few pairs gives no figure", () => {
    const r = analyze({ schema: 1, pairs: pairs(MIN_PAIRS - 1, () => ({ plain: { seconds: 10 }, purix: { seconds: 5 } })) });
    expect(r.find((x) => x.measure === "seconds")).toMatchObject({ kind: "not-enough-pairs", pairs: MIN_PAIRS - 1 });
  });
  it("a missing value is not zero: that pair is left out of that measure only", () => {
    const ps = pairs(14, (i) => ({ plain: { seconds: 10, costUsd: 1 }, purix: i < 3 ? { costUsd: 0.5 } : { seconds: 8, costUsd: 0.5 } }));
    const r = analyze({ schema: 1, pairs: ps });
    expect(r.find((x) => x.measure === "seconds")).toMatchObject({ kind: "numeric", pairs: 11, medianDiff: -2 });
    expect(r.find((x) => x.measure === "costUsd")).toMatchObject({ pairs: 14, medianDiff: -0.5 });
    expect(r.find((x) => x.measure === "interruptions")).toMatchObject({ kind: "not-enough-pairs", pairs: 0 });
  });
  it("binary measure counts discordant pairs", () => {
    const ps = pairs(12, (i) => ({ plain: { accepted: i < 6 }, purix: { accepted: i < 4 || i >= 10 } }));
    const b = analyze({ schema: 1, pairs: ps }).find((x) => x.measure === "accepted")!;
    expect(b).toMatchObject({ kind: "binary", bothPass: 4, onlyPlain: 2, onlyPurix: 2, bothFail: 4 });
  });
  it("ignores negative or non-numeric values, and the report never prints a single score", () => {
    const ps = pairs(10, () => ({ plain: { seconds: -1 }, purix: { seconds: Number.NaN } }));
    expect(analyze({ schema: 1, pairs: ps }).find((x) => x.measure === "seconds")).toMatchObject({ kind: "not-enough-pairs", pairs: 0 });
    const text = formatReport(analyze({ schema: 1, pairs: ps }), 10);
    expect(text).toMatch(/No overall score/);
    expect(text).not.toMatch(/winner|rank|leaderboard/i);
  });
  it("rejects a file that is not a runs file", () => { expect(() => parseRunsFile("{}")).toThrow(/not a runs file/); });
});
