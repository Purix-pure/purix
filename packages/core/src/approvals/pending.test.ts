import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import {
  APPROVAL_TTL_MS,
  actionKeyFor,
  approvalStatus,
  canonicalJson,
  decideApproval,
  listApprovals,
  loadApprovalForReview,
  peekApproved,
  requestOrConsume,
  peekRequest,
  type ApprovalRequestInput,
} from "./pending.js";

let base: string;
let userDir: string;
let saved: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "purix-pending-proj-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-pending-user-"));
  saved = process.env.PURIX_USER_DIR;
  process.env.PURIX_USER_DIR = userDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PURIX_USER_DIR;
  else process.env.PURIX_USER_DIR = saved;
  safeRmSync(base);
  safeRmSync(userDir);
});

const input = (over: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput => ({
  tool: "purix_index",
  checkpointKind: "mcp_index_full",
  componentId: null,
  args: { full: true },
  summary: "Full indexing",
  message: "Agent requests a full re-index. Approve?",
  client: "agent-x",
  ...over,
});

const file = (id: string) => join(base, ".purix", "approvals", `${id}.json`);

describe("pending approvals (C-30)", () => {
  test("a new call makes one pending request and repeating the call does not make another", () => {
    const a = requestOrConsume(base, input());
    const b = requestOrConsume(base, input());
    expect(a.state).toBe("pending");
    expect(b.state).toBe("pending");
    expect(b.record.id).toBe(a.record.id);
    expect(a.record.id).toMatch(/^apr-[0-9a-f]{12}$/);
    expect(readdirSync(join(base, ".purix", "approvals")).filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  test("expires 30 minutes after it was made", () => {
    const t0 = new Date("2026-10-13T10:00:00Z");
    const a = requestOrConsume(base, input(), t0);
    expect(Date.parse(a.record.expiresAt) - t0.getTime()).toBe(APPROVAL_TTL_MS);
    expect(approvalStatus(base, a.record.id, new Date(t0.getTime() + APPROVAL_TTL_MS - 1000))?.state).toBe("pending");
    expect(approvalStatus(base, a.record.id, new Date(t0.getTime() + APPROVAL_TTL_MS + 1000))?.state).toBe("expired");
  });

  test("an expired request cannot be approved, and the next call starts a new one", () => {
    const t0 = new Date("2026-10-13T10:00:00Z");
    const late = new Date(t0.getTime() + APPROVAL_TTL_MS + 5000);
    const a = requestOrConsume(base, input(), t0);
    expect(decideApproval(base, a.record.id, "approved", late)).toEqual({ ok: false, reason: "the request is already expired" });
    const b = requestOrConsume(base, input(), late);
    expect(b.record.id).not.toBe(a.record.id);
  });

  test("an approval is used once", () => {
    const a = requestOrConsume(base, input());
    expect(decideApproval(base, a.record.id, "approved").ok).toBe(true);
    expect(peekApproved(base, input())?.id).toBe(a.record.id);
    expect(requestOrConsume(base, input()).state).toBe("approved");
    expect(approvalStatus(base, a.record.id)?.state).toBe("used");
    expect(peekApproved(base, input())).toBeNull();
    const again = requestOrConsume(base, input());
    expect(again.state).toBe("pending");
    expect(again.record.id).not.toBe(a.record.id);
  });

  test("an approval does not cover a call with different arguments, tool, or component", () => {
    const a = requestOrConsume(base, input());
    decideApproval(base, a.record.id, "approved");
    expect(requestOrConsume(base, input({ args: { full: false } })).state).toBe("pending");
    expect(requestOrConsume(base, input({ tool: "purix_adopt" })).state).toBe("pending");
    expect(requestOrConsume(base, input({ componentId: "billing" })).state).toBe("pending");
    // The original approval is still there for the exact call.
    expect(requestOrConsume(base, input()).state).toBe("approved");
  });

  test("argument key order does not matter; values do", () => {
    const k1 = actionKeyFor({ tool: "t", checkpointKind: "k", componentId: null, args: { a: 1, b: { c: 2, d: 3 } } });
    const k2 = actionKeyFor({ tool: "t", checkpointKind: "k", componentId: null, args: { b: { d: 3, c: 2 }, a: 1 } });
    const k3 = actionKeyFor({ tool: "t", checkpointKind: "k", componentId: null, args: { a: 1, b: { c: 2, d: 4 } } });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(canonicalJson({ b: undefined, a: [1, { z: 1, y: 2 }] })).toBe('{"a":[1,{"y":2,"z":1}]}');
  });

  test("a denial holds until it expires and is not consumed", () => {
    const a = requestOrConsume(base, input());
    decideApproval(base, a.record.id, "denied");
    expect(requestOrConsume(base, input()).state).toBe("denied");
    expect(requestOrConsume(base, input()).state).toBe("denied");
    expect(approvalStatus(base, a.record.id)?.state).toBe("denied");
  });

  test("a decided request cannot be decided again", () => {
    const a = requestOrConsume(base, input());
    expect(decideApproval(base, a.record.id, "denied").ok).toBe(true);
    expect(decideApproval(base, a.record.id, "approved")).toEqual({ ok: false, reason: "the request is already denied" });
  });

  test("a record edited to say approved fails its check and is never used", () => {
    const a = requestOrConsume(base, input());
    const forged = JSON.parse(readFileSync(file(a.record.id), "utf-8"));
    forged.status = "approved";
    writeFileSync(file(a.record.id), JSON.stringify(forged));
    expect(approvalStatus(base, a.record.id)?.state).toBe("invalid");
    expect(peekApproved(base, input())).toBeNull();
    expect(requestOrConsume(base, input()).state).toBe("pending");
    expect(requestOrConsume(base, input()).record.id).not.toBe(a.record.id);
    expect(decideApproval(base, a.record.id, "approved").ok).toBe(false);
    expect(loadApprovalForReview(base, a.record.id)).toBeNull();
  });

  test("a whole record written by hand, without the key, does not verify", () => {
    const a = requestOrConsume(base, input());
    const real = JSON.parse(readFileSync(file(a.record.id), "utf-8"));
    const fakeId = "apr-aaaaaaaaaaaa";
    writeFileSync(file(fakeId), JSON.stringify({ ...real, id: fakeId, status: "approved" }));
    expect(approvalStatus(base, fakeId)?.state).toBe("invalid");
    expect(peekApproved(base, input())).toBeNull();
  });

  test("a record signed with another machine's key does not verify", () => {
    const a = requestOrConsume(base, input());
    // A different user folder means a different key.
    const other = mkdtempSync(join(tmpdir(), "purix-pending-other-"));
    process.env.PURIX_USER_DIR = other;
    try {
      expect(approvalStatus(base, a.record.id)?.state).toBe("invalid");
    } finally {
      process.env.PURIX_USER_DIR = userDir;
      safeRmSync(other);
    }
  });

  test("ids that are not request ids are ignored, so a path cannot be smuggled in", () => {
    expect(approvalStatus(base, "../../etc/passwd")).toBeNull();
    expect(approvalStatus(base, "apr-123")).toBeNull();
    expect(decideApproval(base, "../x", "approved")).toEqual({ ok: false, reason: "no such request" });
  });

  test("the signing key stays in the user folder, not the project", () => {
    requestOrConsume(base, input());
    expect(existsSync(join(userDir, "approval.key"))).toBe(true);
    expect(readdirSync(join(base, ".purix", "approvals")).some((f) => f.includes("key"))).toBe(false);
    expect(readFileSync(join(userDir, "approval.key"), "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the payload a person approved comes back with the approved call", () => {
    const plan = { component_id: "billing", files: [{ path: "src/billing.ts" }] };
    const a = requestOrConsume(base, input({ payload: plan }));
    decideApproval(base, a.record.id, "approved");
    expect(peekApproved(base, input())?.payload).toEqual(plan);
    expect(requestOrConsume(base, input()).record.payload).toEqual(plan);
  });

  test("status shows the agent nothing it could use to approve (no signature, no message)", () => {
    const a = requestOrConsume(base, input());
    const view = approvalStatus(base, a.record.id) as unknown as Record<string, unknown>;
    expect(view.sig).toBeUndefined();
    expect(view.message).toBeUndefined();
  });

  test("list shows state per request; invalid ones are reported, not hidden", () => {
    const a = requestOrConsume(base, input());
    const b = requestOrConsume(base, input({ args: { full: false } }));
    decideApproval(base, b.record.id, "denied");
    writeFileSync(file("apr-bbbbbbbbbbbb"), "{ not json");
    const rows = listApprovals(base);
    expect(rows.find((r) => r.id === a.record.id)?.state).toBe("pending");
    expect(rows.find((r) => r.id === b.record.id)?.state).toBe("denied");
    expect(rows.find((r) => r.id === "apr-bbbbbbbbbbbb")?.state).toBe("invalid");
  });

  test("finished requests are cleaned up a day after they expire", () => {
    const t0 = new Date("2026-10-13T10:00:00Z");
    const old = requestOrConsume(base, input(), t0);
    const much = new Date(t0.getTime() + APPROVAL_TTL_MS + 25 * 60 * 60 * 1000);
    requestOrConsume(base, input({ args: { other: 1 } }), much);
    expect(existsSync(file(old.record.id))).toBe(false);
  });

  test("a second caller after the first has claimed an approval does not get it", () => {
    const a = requestOrConsume(base, input());
    decideApproval(base, a.record.id, "approved");
    const results = [requestOrConsume(base, input()), requestOrConsume(base, input())];
    expect(results.filter((r) => r.state === "approved").length).toBe(1);
  });

  test("peekRequest reads pending, approved and denied without creating or consuming anything (AI-09)", () => {
    const call = { tool: input().tool, checkpointKind: input().checkpointKind, componentId: input().componentId, args: input().args };
    expect(peekRequest(base, call)).toBeNull();
    expect(existsSync(join(base, ".purix", "approvals"))).toBe(false); // peeking creates nothing, not even the folder

    const made = requestOrConsume(base, input());
    expect(peekRequest(base, call)?.state).toBe("pending");
    expect(peekRequest(base, call)?.record.id).toBe(made.record.id);
    expect(readdirSync(join(base, ".purix", "approvals")).length).toBe(1);

    decideApproval(base, made.record.id, "approved");
    expect(peekRequest(base, call)?.state).toBe("approved");
    expect(peekRequest(base, call)?.state).toBe("approved"); // peeking twice does not use it up
    expect(requestOrConsume(base, input()).state).toBe("approved"); // the real consume still works once
    expect(peekRequest(base, call)).toBeNull(); // used

    const other = requestOrConsume(base, input({ args: { other: 1 } }));
    decideApproval(base, other.record.id, "denied");
    expect(peekRequest(base, { ...call, args: { other: 1 } })?.state).toBe("denied");
    const later = new Date(Date.now() + APPROVAL_TTL_MS + 1000);
    expect(peekRequest(base, { ...call, args: { other: 1 } }, later)).toBeNull(); // expired
  });
});
