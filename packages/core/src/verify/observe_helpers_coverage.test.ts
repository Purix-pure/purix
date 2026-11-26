// Direct tests for the small helpers behind the receipt and the "not checked" lines, which the larger tests only reach in part.
import { describe, it } from "node:test";
import { expect } from "expect";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";
import { recordAnchorOutcome } from "./anchor_events.js";
import { metricsDetail } from "./metrics_detail.js";
import { partialLineBadge, partialLinePathsFor, latestPartialLine } from "./partial_line_record.js";
import { couldNotCheckHeadline, partialPassLine, partialLineMessage } from "./surface_text.js";
import { sanitizeAndRecord, sanitizeRepairText } from "../llm/input_scan.js";
import { knownProviderKeyNames, listProviders, priceFor } from "../llm/providers.js";
import { listEvents } from "../manifest/events.js";
import type { CompileResult } from "./compile.js";

isolateCwdForFile();

const asResult = (x: unknown) => x as CompileResult;
function anchorEvents(): { outcome: string }[] {
  return listEvents({ kind: "anchor_match" }).map((e) => ({ outcome: String((e.detail as Record<string, unknown>)["outcome"]) }));
}

describe("recordAnchorOutcome", () => {
  it("writes one event for a rescued anchor, one for a partial-line edit, one for a miss, and nothing for a clean exact match", () => {
    recordAnchorOutcome("c1", asResult({ ok: true }));
    expect(anchorEvents()).toEqual([]);
    recordAnchorOutcome("c1", asResult({ ok: true, anchorRescues: [{ stage: "whitespace" }] }));
    recordAnchorOutcome("c1", asResult({ ok: true, partialLinePaths: ["src/a.ts"] }));
    recordAnchorOutcome("c1", asResult({ ok: false, reason: "anchor text not found in src/a.ts" }));
    recordAnchorOutcome("c1", asResult({ ok: false, reason: "something else" }));
    expect(anchorEvents().map((e) => e.outcome)).toEqual(["rescued", "partial_line", "missed"]);
  });
});

describe("metricsDetail", () => {
  it("keeps valid counts and time, and leaves out what was not recorded", () => {
    const d = metricsDetail({ testCounts: { passed: 4, failed: 0, skipped: 1 }, verifyMs: 12.6 });
    expect(d.test_counts).toEqual({ passed: 4, failed: 0, skipped: 1 });
    expect(d.verify_ms).toBe(13);
    const none = metricsDetail({ testCounts: { passed: -1, failed: 0, skipped: 0 }, verifyMs: Number.NaN });
    expect(none.test_counts).toBeUndefined();
    expect(none.verify_ms).toBeUndefined();
  });
  it("summarises changed-line coverage as counts only, and drops a bad record", () => {
    const d = metricsDetail({ changedCoverage: { covered: 8, total: 10, ratio: 0.8, uncovered: { "a.ts": [3, 4] }, notMeasured: ["b.py"], whyNotMeasured: "no python coverage" } });
    expect(d.changed_coverage).toEqual({ covered: 8, total: 10, ratio: 0.8, uncovered_files: 1, uncovered_lines: 2, not_measured_files: 1, why_not_measured: "no python coverage" });
    expect(metricsDetail({ changedCoverage: { covered: -1, total: 3 } }).changed_coverage).toBeUndefined();
  });
  it("keeps a valid duplication record and drops an invalid one", () => {
    const ok = metricsDetail({ duplication: { before: 2, after: 1, linesChecked: 40, filesCompared: 3, cut: true } });
    expect(ok.duplication).toEqual({ before: 2, after: 1, lines_checked: 40, files_compared: 3, cut: true });
    expect(metricsDetail({ duplication: { before: 2, after: 1, linesChecked: 40, filesCompared: 3, cut: "yes" as unknown as boolean } }).duplication).toBeUndefined();
  });
});

describe("partial-line helpers", () => {
  it("lists each path once, from the compile and from the run, and says nothing when there is none", () => {
    expect(partialLinePathsFor(asResult({ ok: true, partialLinePaths: ["a.ts"] }), false, ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
    expect(partialLinePathsFor(asResult({ ok: true, partialLinePaths: ["a.ts"] }), true)).toBeUndefined();
    expect(partialLineBadge(["a.ts", "a.ts", "b.ts"])).toBe("edited inside a line: 2 file(s), rest of that line kept");
  });
  it("holds a partial-line edit until the next passing run and clears it after a clean pass", () => {
    const ev = (kind: string, detail: Record<string, unknown> = {}) => ({ kind, component_id: "c", detail });
    expect(latestPartialLine([ev("anchor_match", { outcome: "partial_line", paths: ["a.ts"] }), ev("verification_pass")]).get("c")).toEqual(["a.ts"]);
    expect(latestPartialLine([ev("anchor_match", { outcome: "partial_line", paths: ["a.ts"] }), ev("verification_pass"), ev("verification_pass")]).has("c")).toBe(false);
    expect(latestPartialLine([ev("anchor_match", { outcome: "partial_line", paths: "no" })]).size).toBe(0);
  });
});

describe("surface text", () => {
  it("says a check that could not run is not a failure of the code, for every reason", () => {
    for (const k of ["not_installed", "timeout", "output_limit", "sandbox_unavailable", "resource_limit"] as const) {
      expect(couldNotCheckHeadline(k)).toContain("not a failure of your code");
    }
    expect(couldNotCheckHeadline(undefined)).toContain("could not run");
    expect(couldNotCheckHeadline("unsupported_language")).toContain("unsupported language");
  });
  it("never calls unchecked files verified", () => {
    expect(partialPassLine({ checkedAny: true, isolation: "bwrap" })).toContain("were not verified");
    expect(partialPassLine({ checkedAny: false, isolation: undefined })).toBe("Nothing was verified.");
    expect(partialLineMessage(["a", "b", "c", "d"])).toContain("and 1 more");
    expect(partialLineMessage([])).toBeUndefined();
  });
});

describe("sanitizeRepairText", () => {
  it("removes hidden characters and counts them", () => {
    const r = sanitizeRepairText("he​llo‮");
    expect(r.cleaned).toBe("hello");
    expect(r.strippedHidden).toBe(2);
  });
});

describe("sanitizeAndRecord", () => {
  it("records one input_neutralized event when hidden characters were removed, and none for clean text", () => {
    const before = listEvents({ kind: "input_neutralized" }).length;
    expect(sanitizeAndRecord("plain text", { componentId: "c", operation: "modify", stage: "self_heal", source: "failure" })).toBe("plain text");
    expect(listEvents({ kind: "input_neutralized" }).length).toBe(before);
    const out = sanitizeAndRecord("a\u200bb", { componentId: "c", operation: "modify", stage: "refine", source: "memory", attempt: 2 });
    expect(out).toBe("ab");
    const events = listEvents({ kind: "input_neutralized" });
    expect(events.length).toBe(before + 1);
    expect((events[events.length - 1]!.detail as Record<string, unknown>)["hidden_characters_removed"]).toBe(1);
  });
});

describe("provider registry helpers", () => {
  it("lists every credential name Purix reads, and a price for each tier", () => {
    const names = knownProviderKeyNames();
    expect(names.length).toBeGreaterThan(5);
    expect(names.every((n) => n.envVar.length > 0 && n.providerId.length > 0 && n.label.length > 0)).toBe(true);
    expect(listProviders().length).toBeGreaterThan(5);
    expect(priceFor("openai", "low").input).toBeGreaterThan(0);
    expect(priceFor("no-such-provider", "high").output).toBeGreaterThan(0);
  });
});
