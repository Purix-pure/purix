import { describe, it } from "node:test";
import { expect } from "expect";
import { approvalWaitTimes, summarizeApprovalWaits } from "./wait_times.js";

const row = (o: Record<string, unknown>, ts = "2026-11-22T10:00:00.000Z") => ({ payload: JSON.stringify({ event: "approval", ...o }), timestamp: ts });
const T = (s: string) => `2026-11-22T10:${s}.000Z`;

describe("approvalWaitTimes", () => {
  it("pairs a request with its decision and measures the wait from the stamps inside the records", () => {
    const w = approvalWaitTimes([
      row({ state: "requested", approval_id: "apr-1", tool: "purix_modify", component_id: "c1", at: T("00:00") }),
      row({ state: "approved", approval_id: "apr-1", at: T("00:42") }),
      row({ state: "consumed", approval_id: "apr-1", at: T("00:45") }),
    ]);
    expect(w).toEqual([{ approvalId: "apr-1", tool: "purix_modify", componentId: "c1", requestedAt: T("00:00"), decision: "approved", decidedAt: T("00:42"), waitMs: 42_000, consumedAt: T("00:45") }]);
  });

  it("a request nobody answered has no decision and no wait, not a wait of zero", () => {
    const w = approvalWaitTimes([row({ state: "requested", approval_id: "apr-2", tool: "purix_create", component_id: null, at: T("00:00") })]);
    expect(w[0]!.decision).toBeUndefined();
    expect(w[0]!.waitMs).toBeUndefined();
    expect(summarizeApprovalWaits(w)).toEqual({ requested: 1, approved: 0, denied: 0, unanswered: 1 });
  });

  it("keeps the first decision only, and ignores answers whose request is gone", () => {
    const w = approvalWaitTimes([
      row({ state: "approved", approval_id: "apr-ghost", at: T("00:05") }),
      row({ state: "requested", approval_id: "apr-3", tool: "t", at: T("00:00") }),
      row({ state: "denied", approval_id: "apr-3", at: T("00:10") }),
      row({ state: "approved", approval_id: "apr-3", at: T("00:20") }),
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]!.decision).toBe("denied");
    expect(w[0]!.waitMs).toBe(10_000);
  });

  it("ignores other records and unreadable payloads", () => {
    const w = approvalWaitTimes([{ payload: "not json", timestamp: T("00:00") }, { payload: JSON.stringify({ event: "gate" }), timestamp: T("00:00") }, { payload: "[]", timestamp: T("00:00") }]);
    expect(w).toEqual([]);
  });

  it("falls back to the chain's own timestamp when a record has no usable `at`", () => {
    const w = approvalWaitTimes([
      row({ state: "requested", approval_id: "apr-4", tool: "t" }, T("00:00")),
      row({ state: "approved", approval_id: "apr-4", at: "garbage" }, T("00:30")),
    ]);
    expect(w[0]!.waitMs).toBe(30_000);
  });

  it("a negative wait (a clock that moved back) is left out, not shown as a number", () => {
    const w = approvalWaitTimes([row({ state: "requested", approval_id: "apr-5", tool: "t", at: T("01:00") }), row({ state: "denied", approval_id: "apr-5", at: T("00:30") })]);
    expect(w[0]!.decision).toBe("denied");
    expect(w[0]!.waitMs).toBeUndefined();
  });
});

describe("summarizeApprovalWaits", () => {
  it("counts by outcome and gives the median of the answered waits", () => {
    const s = summarizeApprovalWaits([
      { approvalId: "a", tool: "t", componentId: null, requestedAt: "x", decision: "approved", waitMs: 10_000 },
      { approvalId: "b", tool: "t", componentId: null, requestedAt: "x", decision: "approved", waitMs: 30_000 },
      { approvalId: "c", tool: "t", componentId: null, requestedAt: "x", decision: "denied", waitMs: 20_000 },
      { approvalId: "d", tool: "t", componentId: null, requestedAt: "x" },
    ]);
    expect(s).toEqual({ requested: 4, approved: 2, denied: 1, unanswered: 1, medianWaitMs: 20_000 });
  });
});
