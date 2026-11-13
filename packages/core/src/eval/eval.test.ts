// AI-10: the L1 eval harness. Everything here runs on canned replies and fake models; no network, no key.
// Tested on Linux against simulated payloads.
import { describe, it } from "node:test";
import { expect } from "expect";
import { z } from "zod";
import { generateCases, makeRng, MUTATION_OPERATORS, type EvalCase, type SourceFile } from "./mutations.js";
import { applyResolvedOps, numberedView } from "./line_ops.js";
import { ARMS, ARM_IDS, armsFor, parseReply, type ArmId } from "./arms.js";
import { dryModel, dryReplyText } from "./dry.js";
import { evaluateDecisionRule, mcnemarExact, normalizeForMatch, pairedComparison, scoreOutcome, summarize, wilson, type TrialRecord } from "./scoring.js";
import { estimateCostUsd, runEval, type CallModel } from "./runner.js";
import { formatReport } from "./report.js";
import { loadDiffXyzCases } from "./diffxyz.js";

const SOURCE = `export const MAX_RETRIES = 5;
export const TIMEOUT_MS = 30;

export interface Item { id: number; label?: { text: string } }

export function totalPrice(items: number[], limit: number): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i] > limit && total >= 0) {
      total = total + items[i];
    }
  }
  return total;
}

export function describe(item: Item, enabled = true): string {
  if (item.label?.text !== undefined && enabled === true) {
    return item.label?.text.trim();
  }
  return "item " + (item.id + 1);
}

export function stats(values: number[]): number {
  const count = values.length;
  const result = count === 0 ? 0 : values[count - 1];
  return result + count;
}
`;
const FILES: SourceFile[] = [
  { path: "src/a.ts", content: SOURCE },
  { path: "src/b.ts", content: SOURCE.replace(/totalPrice/g, "sumPrice") },
  { path: "src/c.ts", content: SOURCE.replace(/describe/g, "render") },
];

const diffLines = (a: string, b: string) => {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  expect(x.length).toBe(y.length);
  return x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0);
};

describe("generateCases", () => {
  it("is deterministic: same seed and inputs give the same cases, a different seed gives different ones", () => {
    const a = generateCases(FILES, { count: 18, seed: 7 });
    const b = generateCases([...FILES].reverse(), { count: 18, seed: 7 });
    expect(a).toEqual(b);
    expect(generateCases(FILES, { count: 18, seed: 8 })).not.toEqual(a);
  });

  it("covers all six operators, and each case differs from the original on exactly the one reported line", () => {
    const cases = generateCases(FILES, { count: 30, seed: 1 });
    expect(new Set(cases.map((c) => c.operator))).toEqual(new Set(MUTATION_OPERATORS));
    for (const c of cases) {
      const changed = diffLines(c.mutated, c.original);
      expect(changed).toEqual([c.line - 1]);
      expect(c.instruction).toContain(`line ${c.line}`);
      expect(c.id).toMatch(new RegExp(`^${c.operator}-`));
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("writes the instruction as a description, never the verbatim buggy line", () => {
    for (const c of generateCases(FILES, { count: 30, seed: 3 })) {
      const bad = c.mutated.split(/\r?\n/)[c.line - 1]!.trim();
      expect(c.instruction.includes(bad)).toBe(false);
    }
  });

  it("converts the requested share of cases to CRLF in both the shown and the expected file", () => {
    const cases = generateCases(FILES, { count: 30, seed: 5, crlfShare: 1 });
    expect(cases.every((c) => c.eol === "crlf" && c.mutated.includes("\r\n") && c.original.includes("\r\n"))).toBe(true);
    expect(generateCases(FILES, { count: 30, seed: 5, crlfShare: 0 }).every((c) => !c.mutated.includes("\r"))).toBe(true);
  });

  it("returns fewer cases when the files do not have enough sites, and none for an operator that has none", () => {
    expect(generateCases([{ path: "x.ts", content: "const a = 1;\n" }], { count: 50, seed: 1 }).length).toBeLessThan(5);
    expect(generateCases([{ path: "x.py", content: "if a < b:\n    pass\n" }], { count: 5, seed: 1, operators: ["optional_chain_drop"] })).toEqual([]);
  });

  it("ignores comments, imports and string contents when choosing a site", () => {
    const src = `import { a } from "./x";\n// if (a < b) then true\nconst s = "a < b and true";\nconst n = 4;\n`;
    const cases = generateCases([{ path: "y.ts", content: src }], { count: 20, seed: 2, operators: ["operator_swap", "boolean_flip", "off_by_one"] });
    expect(cases.every((c) => c.line === 4)).toBe(true);
  });

  it("makeRng is reproducible", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe("line ops", () => {
  const f = "a\nb\nc\nd\n";
  it("replaces, inserts, deletes and swaps a token, bottom-up, preserving CRLF", () => {
    const r = applyResolvedOps(f, [
      { kind: "replace", start: 1, end: 1, newLines: ["A", "A2"] },
      { kind: "delete", start: 3, end: 3 },
      { kind: "insert_after", start: 4, end: 4, newLines: ["e"] },
    ]);
    expect(r).toEqual({ ok: true, content: "A\nA2\nb\nd\ne\n" });
    expect(applyResolvedOps("x\r\ny\r\n", [{ kind: "replace", start: 2, end: 2, newLines: ["Y"] }])).toEqual({ ok: true, content: "x\r\nY\r\n" });
    expect(applyResolvedOps("let a = b + c;\n", [{ kind: "token", start: 1, end: 1, oldToken: "+", newToken: "-" }])).toEqual({ ok: true, content: "let a = b - c;\n" });
  });
  it("fails loudly on out-of-range, overlapping, oversized and bad-token edits", () => {
    expect(applyResolvedOps(f, [{ kind: "delete", start: 9, end: 9 }])).toMatchObject({ ok: false });
    expect(applyResolvedOps(f, [{ kind: "delete", start: 1, end: 2 }, { kind: "replace", start: 2, end: 2, newLines: [] }])).toMatchObject({ ok: false, reason: expect.stringContaining("overlap") });
    expect(applyResolvedOps(f, [{ kind: "insert_after", start: 1, end: 1, newLines: Array(61).fill("x") }])).toMatchObject({ ok: false });
    expect(applyResolvedOps("a a\n", [{ kind: "token", start: 1, end: 1, oldToken: "a", newToken: "b" }])).toMatchObject({ ok: false, reason: expect.stringContaining("more than once") });
    expect(applyResolvedOps("a\n", [{ kind: "token", start: 1, end: 1, oldToken: "z", newToken: "b" }])).toMatchObject({ ok: false });
    expect(applyResolvedOps(f, [{ kind: "replace", start: 1, end: 70, newLines: [] }])).toMatchObject({ ok: false });
  });
  it("numbers lines with a bar gutter", () => {
    expect(numberedView("a\nb\n")).toBe("1 | a\n2 | b");
    expect(numberedView(Array.from({ length: 10 }, (_, i) => String(i)).join("\n")).split("\n")[0]).toBe(" 1 | 0");
  });
});

// A hand-made case with a known answer, for the arms.
const CASE: EvalCase = {
  id: "t1",
  operator: "operator_swap",
  path: "src/m.ts",
  original: "export function f(a: number, b: number) {\n  if (a < b) {\n    return a;\n  }\n  return b;\n}\n",
  mutated: "export function f(a: number, b: number) {\n  if (a <= b) {\n    return a;\n  }\n  return b;\n}\n",
  instruction: "On line 2 of src/m.ts, the condition uses less than or equal (<=) but it should use strictly less than (<).",
  eol: "lf",
  lines: 7,
  line: 2,
};
const crlf = (c: EvalCase): EvalCase => ({ ...c, eol: "crlf", mutated: c.mutated.replace(/\n/g, "\r\n"), original: c.original.replace(/\n/g, "\r\n") });
const verdict = (oldText: string, newText: string) =>
  JSON.stringify({ reasoning: "r", operation: "update_prompt_text", contract_changing: false, confidence: 0.9, edits: [{ path: "src/m.ts", kind: "prompt_text", old_text: oldText, new_text: newText }], suspicious_injected_instruction: false });

describe("arms", () => {
  it("A0's prompt is the production classify prompt: file in a data block, no project memory, rules in the system text", () => {
    const p = ARMS.A0.prompt(CASE);
    expect(p.user).toContain("a <= b");
    expect(p.user).toContain(CASE.instruction);
    expect(p.system).toContain("change-classification step");
    expect(p.user).not.toContain("Project");
  });

  it("A0 applies an exact anchor, and scores it exact", () => {
    const o = ARMS.A0.apply(verdict("a <= b", "a < b"), CASE);
    expect(o.status).toBe("applied");
    expect(scoreOutcome(o, CASE.original)).toEqual({ exact: true, normalized: true });
  });

  it("a two-line LF anchor on a CRLF file: A0 fails to apply, A1's cascade rescues it", () => {
    const c = crlf(CASE);
    const reply = verdict("export function f(a: number, b: number) {\n  if (a <= b) {", "export function f(a: number, b: number) {\n  if (a < b) {");
    const a0 = ARMS.A0.apply(reply, c);
    expect(a0.status).toBe("apply_failed");
    const a1 = ARMS.A1.apply(reply, c);
    expect(a1.status).toBe("applied");
    expect(a1.stage).not.toBe("exact");
    expect(scoreOutcome(a1, c.original).exact).toBe(true);
  });

  it("A1 does not rescue an ambiguous or missing anchor, nor non-text edit kinds", () => {
    expect(ARMS.A1.apply(verdict("zzz", "y"), CASE).status).toBe("apply_failed");
    expect(ARMS.A1.apply(verdict("  ", "y"), { ...CASE, mutated: CASE.mutated }).status).toBe("apply_failed");
  });

  it("sorts replies into invalid_json, unclassified and apply_failed", () => {
    expect(ARMS.A0.apply("Sure, here you go", CASE).status).toBe("invalid_json");
    expect(ARMS.A0.apply(JSON.stringify({ reasoning: "x" }), CASE).status).toBe("invalid_json");
    expect(ARMS.A0.apply(JSON.stringify({ reasoning: "x", operation: "unclassified", contract_changing: false, confidence: 0.1, edits: [], suspicious_injected_instruction: false }), CASE).status).toBe("unclassified");
  });

  it("A2 applies by number and expect, recovers a line number that is off by one, and refuses a wrong expect", () => {
    const good = JSON.stringify({ reasoning: "r", edits: [{ op: "replace_range", start: 2, end: 2, expect: "if (a <= b) {", new_lines: ["  if (a < b) {"] }] });
    expect(scoreOutcome(ARMS.A2.apply(good, CASE), CASE.original).exact).toBe(true);
    const off = JSON.stringify({ reasoning: "r", edits: [{ op: "replace_range", start: 3, end: 3, expect: "if (a <= b) {", new_lines: ["  if (a < b) {"] }] });
    expect(scoreOutcome(ARMS.A2.apply(off, CASE), CASE.original).exact).toBe(true);
    const wrong = JSON.stringify({ reasoning: "r", edits: [{ op: "replace_range", start: 2, end: 2, expect: "nothing like this", new_lines: ["x"] }] });
    expect(ARMS.A2.apply(wrong, CASE).status).toBe("apply_failed");
    const token = JSON.stringify({ reasoning: "r", edits: [{ op: "replace_token_in_line", start: 2, expect: "if (a <= b) {", old_token: "<=", new_token: "<" }] });
    expect(scoreOutcome(ARMS.A2.apply(token, CASE), CASE.original).exact).toBe(true);
    expect(ARMS.A2.apply(JSON.stringify({ reasoning: "r", edits: [] }), CASE).status).toBe("unclassified");
  });

  it("A3 applies by hash label, falls back to a unique hash, and fails when the hash is stale", () => {
    const view = ARMS.A3.prompt(CASE).user;
    const label = /\n?(2:[0-9a-f]{2})\|/.exec(view)![1]!;
    const ok = JSON.stringify({ reasoning: "r", edits: [{ op: "replace", ref: label, new_lines: ["  if (a < b) {"] }] });
    expect(scoreOutcome(ARMS.A3.apply(ok, CASE), CASE.original).exact).toBe(true);
    const miscounted = JSON.stringify({ reasoning: "r", edits: [{ op: "replace", ref: `9:${label.slice(2)}`, new_lines: ["  if (a < b) {"] }] });
    expect(scoreOutcome(ARMS.A3.apply(miscounted, CASE), CASE.original).exact).toBe(true);
    const stale = JSON.stringify({ reasoning: "r", edits: [{ op: "replace", ref: "2:zz", new_lines: ["x"] }] });
    expect(ARMS.A3.apply(stale, CASE).status).toBe("apply_failed");
    expect(ARMS.A3.apply(JSON.stringify({ reasoning: "r", edits: [{ op: "delete", ref: "2:00" }] }), CASE).status).toBe("apply_failed");
  });

  it("A4 takes the whole file back, only for files under 150 lines", () => {
    const o = ARMS.A4.apply(JSON.stringify({ reasoning: "r", content: CASE.original }), CASE);
    expect(scoreOutcome(o, CASE.original).exact).toBe(true);
    expect(ARMS.A4.applicable(CASE)).toBe(true);
    expect(ARMS.A4.applicable({ ...CASE, lines: 150 })).toBe(false);
    expect(ARMS.A4.apply(JSON.stringify({ reasoning: "r", content: " " }), CASE).status).toBe("unclassified");
  });

  it("parseReply strips code fences and names the problem", () => {
    const schema = z.object({ a: z.number() });
    expect(parseReply('```json\n{"a":1}\n```', schema)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseReply("nope", schema)).toEqual({ ok: false, reason: "not valid JSON" });
    const bad = parseReply('{"a":"x"}', schema);
    expect(!bad.ok && bad.reason).toContain("wrong shape: a:");
  });

  it("armsFor keeps the order asked for, and there are five arms", () => {
    expect(armsFor(["A3", "A0"]).map((a) => a.id)).toEqual(["A3", "A0"]);
    expect(ARM_IDS.length).toBe(5);
  });
});

describe("scoring and statistics", () => {
  it("normalises line endings, trailing spaces and trailing blank lines only", () => {
    expect(normalizeForMatch("a  \r\nb\t\r\n\r\n")).toBe("a\nb");
    expect(normalizeForMatch("a\n b")).not.toBe(normalizeForMatch("a\nb"));
    expect(scoreOutcome({ status: "apply_failed" }, "x")).toEqual({ exact: false, normalized: false });
    expect(scoreOutcome({ status: "applied", result: "a\r\n" }, "a\n")).toEqual({ exact: false, normalized: true });
  });

  it("wilson interval matches known values", () => {
    const w = wilson(8, 10);
    expect(w.p).toBeCloseTo(0.8, 5);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 0 });
    expect(wilson(10, 10).hi).toBe(1);
  });

  it("exact McNemar matches known binomial tail values", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(0, 10)).toBeCloseTo(2 / 1024, 8);
    expect(mcnemarExact(5, 5)).toBe(1);
    expect(mcnemarExact(2, 8)).toBeCloseTo(0.109375, 6); // 2 * P(X <= 2), n = 10
  });

  const rec = (arm: ArmId, tier: "low" | "high", caseId: string, ok: boolean, over: Partial<TrialRecord> = {}): TrialRecord => ({
    caseId, operator: "operator_swap", eol: "lf", arm, tier, trial: 1, status: ok ? "applied" : "apply_failed", exact: ok, normalized: ok, inputTokens: 1000, outputTokens: 100, costUsd: 0.001, latencyMs: 1, ...over,
  });

  it("pairs by case and trial, ignores skipped records, and reports the difference in points", () => {
    const rs = [
      rec("A0", "low", "1", true), rec("A1", "low", "1", true),
      rec("A0", "low", "2", false), rec("A1", "low", "2", true),
      rec("A0", "low", "3", true), rec("A1", "low", "3", false),
      rec("A0", "low", "4", false), rec("A1", "low", "4", true),
      rec("A0", "low", "5", true), rec("A1", "low", "5", false, { status: "skipped", normalized: false }),
    ];
    expect(pairedComparison(rs, "A0", "A1", "low")).toMatchObject({ pairs: 4, bothRight: 1, onlyA: 1, onlyB: 2, neither: 0, diffPoints: 25 });
  });

  it("summarises rates, tokens per match, and how many matches the cascade rescued", () => {
    const rs = [
      rec("A1", "low", "1", true, { stage: "exact" }),
      rec("A1", "low", "2", true, { stage: "eol" }),
      rec("A1", "low", "3", false, { status: "invalid_json" }),
      rec("A1", "low", "4", false, { status: "unclassified" }),
      rec("A1", "low", "5", false, { status: "provider_error" }),
      rec("A1", "low", "6", false, { status: "skipped" }),
    ];
    const s = summarize(rs)[0]!;
    expect(s).toMatchObject({ arm: "A1", tier: "low", n: 4, skipped: 1, providerErrors: 1, appliedRate: 0.5, invalidJsonRate: 0.25, unclassifiedRate: 0.25, rescuedByCascade: 0.5 });
    expect(s.tokensPerResolved).toBe((4 * 1100) / 2);
  });

  it("the decision rule needs 8 points on the tier, at most 2 lost on the other, and at most 15% more tokens", () => {
    const build = (gainLow: number, deltaHigh: number, tokenFactor: number) => {
      const rs: TrialRecord[] = [];
      for (let i = 0; i < 100; i++) {
        rs.push(rec("A0", "low", `l${i}`, i < 50), rec("A2", "low", `l${i}`, i < 50 + gainLow, { inputTokens: 1000 * tokenFactor }));
        rs.push(rec("A0", "high", `h${i}`, i < 70), rec("A2", "high", `h${i}`, i < 70 + deltaHigh, { inputTokens: 1000 * tokenFactor }));
      }
      return rs;
    };
    expect(evaluateDecisionRule(build(10, 0, 1), "A2", "low")).toMatchObject({ passes: true, gainPoints: 10, otherTierPoints: 0 });
    expect(evaluateDecisionRule(build(7, 0, 1), "A2", "low").reasons.join()).toContain("below 8");
    expect(evaluateDecisionRule(build(10, -3, 1), "A2", "low").reasons.join()).toContain("loses 3.0 points on high");
    expect(evaluateDecisionRule(build(10, 0, 2), "A2", "low").reasons.join()).toContain("more tokens per resolved case");
    // Other tier missing counts against the arm.
    const onlyLow = build(10, 0, 1).filter((r) => r.tier === "low");
    expect(evaluateDecisionRule(onlyLow, "A2", "low")).toMatchObject({ passes: false, otherTierPoints: null });
    expect(evaluateDecisionRule([], "A2", "low").passes).toBe(false);
  });
});

describe("runEval", () => {
  const cases = generateCases(FILES, { count: 6, seed: 11, crlfShare: 0.5 });
  const price = () => ({ input: 1, output: 4 });
  const fake: CallModel = (_p, _t, ctx) => Promise.resolve({ text: dryReplyText(ctx), inputTokens: 1000, outputTokens: 100 });

  it("refuses to run without a positive, finite budget", async () => {
    for (const budgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runEval({ cases, arms: armsFor(["A0"]), tiers: ["low"], trials: 1, callModel: fake, budgetUsd, price })).rejects.toThrow("positive, finite budgetUsd");
    }
  });

  it("makes one call per case, arm and tier, records skips without calling, and sums the cost", async () => {
    let calls = 0;
    const counting: CallModel = (p, t, ctx) => { calls++; return fake(p, t, ctx); };
    const r = await runEval({ cases, arms: armsFor(ARM_IDS), tiers: ["low", "high"], trials: 1, callModel: counting, budgetUsd: 100, price });
    const skipped = r.records.filter((x) => x.status === "skipped").length;
    expect(r.records.length).toBe(cases.length * 5 * 2);
    expect(calls).toBe(r.records.length - skipped);
    expect(r.stoppedForBudget).toBe(false);
    expect(r.spentUsd).toBeCloseTo(calls * ((1000 / 1e6) * 1 + (100 / 1e6) * 4), 9);
  });

  it("stops before the budget would be passed and keeps whole cases together", async () => {
    const perCall = estimateCostUsd(ARMS.A0.prompt(cases[0]!), price(), 1000);
    const r = await runEval({ cases, arms: armsFor(["A0", "A1"]), tiers: ["low"], trials: 1, callModel: fake, budgetUsd: perCall * 3.5, price });
    expect(r.stoppedForBudget).toBe(true);
    expect(r.spentUsd).toBeLessThanOrEqual(perCall * 3.5);
    expect(r.notRun).toBeGreaterThan(0);
    expect(r.records.length).toBeLessThan(cases.length * 2);
  });

  it("records a provider error without scoring it or charging for it", async () => {
    const boom: CallModel = () => Promise.reject(new Error("429"));
    const r = await runEval({ cases: cases.slice(0, 2), arms: armsFor(["A0"]), tiers: ["low"], trials: 1, callModel: boom, budgetUsd: 10, price });
    expect(r.records.every((x) => x.status === "provider_error" && x.costUsd === 0)).toBe(true);
    expect(r.spentUsd).toBe(0);
  });

  it("never records prompt or reply text, only ids, counts and outcomes (canary)", async () => {
    const CANARY = "CANARY_7f3a9c_do_not_log";
    const c: EvalCase = { ...CASE, instruction: `${CASE.instruction} ${CANARY}`, mutated: `${CASE.mutated}// ${CANARY}\n`, original: `${CASE.original}// ${CANARY}\n` };
    const echo: CallModel = (p) => Promise.resolve({ text: `${p.user}\n${CANARY}`, inputTokens: 10, outputTokens: 10 });
    const r = await runEval({ cases: [c], arms: armsFor(ARM_IDS), tiers: ["low"], trials: 1, callModel: echo, budgetUsd: 10, price });
    expect(r.records.length).toBe(5);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("runs several trials, one record per trial", async () => {
    const r = await runEval({ cases: cases.slice(0, 2), arms: armsFor(["A0"]), tiers: ["low"], trials: 3, callModel: fake, budgetUsd: 10, price });
    expect(r.records.map((x) => x.trial)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("dry mode and the report", () => {
  it("a dry run over 40 cases, five arms and two tiers produces the full table, labelled as canned", async () => {
    const cases = generateCases(FILES, { count: 40, seed: 3, crlfShare: 0.5 });
    const r = await runEval({ cases, arms: armsFor(ARM_IDS), tiers: ["low", "high"], trials: 1, callModel: dryModel, budgetUsd: 50, price: () => ({ input: 1, output: 4 }) });
    const text = formatReport(r.records, { dry: true, cases: cases.length, trials: 1, seed: 3, spentUsd: r.spentUsd, budgetUsd: 50, stoppedForBudget: false, notRun: 0 });
    expect(text.startsWith("> DRY RUN")).toBe(true);
    for (const arm of ARM_IDS) expect(text).toContain(`| low | ${arm} |`);
    expect(text).toContain("## Paired comparison against A0");
    expect(text).toContain("## Decision rule");
    expect(text).toContain("One trial is a screening run");
    // The canned model is better on the high tier, and the cascade rescues CRLF anchors, which the tables must show.
    const sums = summarize(r.records);
    const m = (arm: ArmId, tier: "low" | "high") => sums.find((s) => s.arm === arm && s.tier === tier)!.match.p;
    expect(m("A0", "high")).toBeGreaterThan(m("A0", "low"));
    expect(m("A1", "low")).toBeGreaterThan(m("A0", "low"));
    expect(sums.find((s) => s.arm === "A1" && s.tier === "low")!.rescuedByCascade).toBeGreaterThan(0);
  });

  it("is reproducible: the same dry run twice gives identical records", async () => {
    const cases = generateCases(FILES, { count: 10, seed: 9 });
    const run = () => runEval({ cases, arms: armsFor(["A0", "A2"]), tiers: ["low"], trials: 1, callModel: dryModel, budgetUsd: 10, price: () => ({ input: 1, output: 4 }), now: () => 0 });
    expect((await run()).records).toEqual((await run()).records);
  });

  it("the report names an early stop and omits the dry banner for a real run", () => {
    const text = formatReport([], { dry: false, provider: "anthropic", cases: 0, trials: 3, seed: 1, spentUsd: 1, budgetUsd: 1, stoppedForBudget: true, notRun: 12 });
    expect(text).not.toContain("DRY RUN");
    expect(text).toContain("STOPPED EARLY");
    expect(text).toContain("12 calls were not made");
    expect(text).toContain("3 trials.");
  });
});

describe("Diff-XYZ adapter", () => {
  const line = (o: object) => JSON.stringify(o);
  it("refuses to load until the license has been confirmed", () => {
    expect(() => loadDiffXyzCases(line({}), { licenseConfirmed: false })).toThrow("license");
  });
  it("keeps Python and JavaScript records with an instruction, skips the rest, and reports how many", () => {
    const jsonl = [
      line({ id: "a", language: "Python", old_code: "x = 1\ny = 2\n", new_code: "x = 1\ny = 3\n", instruction: "set y to 3" }),
      line({ id: "b", language: "rust", old_code: "a", new_code: "b", instruction: "x" }),
      line({ id: "c", language: "js", old_code: "a", new_code: "a", instruction: "no change" }),
      line({ id: "d", language: "js", old_code: "a", new_code: "b" }),
      "not json",
      line({ language: "javascript", path: "src/q.js", old_code: "a\r\nb", new_code: "a\r\nc", instruction: "  rename b to c " }),
    ].join("\n");
    const { cases, skipped } = loadDiffXyzCases(jsonl, { licenseConfirmed: true });
    expect(skipped).toBe(4);
    expect(cases.map((c) => [c.id, c.path, c.eol, c.line])).toEqual([["diffxyz-a", "case_a.py", "lf", 2], ["diffxyz-6", "src/q.js", "crlf", 2]]);
    expect(cases[0]).toMatchObject({ mutated: "x = 1\ny = 2\n", original: "x = 1\ny = 3\n", instruction: "set y to 3" });
    expect(loadDiffXyzCases(jsonl, { licenseConfirmed: true, maxCases: 1 }).cases.length).toBe(1);
  });
});
