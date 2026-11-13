// A2a-1: approval requests, answers and uses are inside the audit chain (today none are).
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { closeDb } from "../manifest/store.js";
import { readAuditChain, verifyAuditChain } from "../security/audit_tamper_evidence.js";
import { decideApproval, requestOrConsume, type ApprovalRequestInput } from "./pending.js";

let base: string;
let userDir: string;
let cwd: string;
let saved: string | undefined;

beforeEach(() => {
  cwd = process.cwd();
  base = mkdtempSync(join(tmpdir(), "purix-apr-audit-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-apr-user-"));
  saved = process.env.PURIX_USER_DIR;
  process.env.PURIX_USER_DIR = userDir;
  process.chdir(base);
});
afterEach(() => {
  closeDb();
  process.chdir(cwd);
  if (saved === undefined) delete process.env.PURIX_USER_DIR;
  else process.env.PURIX_USER_DIR = saved;
  safeRmSync(base);
  safeRmSync(userDir);
});

const input = (): ApprovalRequestInput => ({
  tool: "purix_index",
  checkpointKind: "mcp_index_full",
  componentId: "alpha",
  args: { full: true },
  summary: "Full indexing",
  message: "Agent requests a full re-index. Approve?",
  client: "agent-x",
});
const events = () => readAuditChain().rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>).filter((p) => p.event === "approval");

describe("approvals in the audit chain", () => {
  test("request, answer and use each leave one record, in order", () => {
    const r = requestOrConsume(base, input());
    expect(r.state).toBe("pending");
    expect(decideApproval(base, r.record.id, "approved")).toEqual({ ok: true });
    expect(requestOrConsume(base, input()).state).toBe("approved");
    const e = events();
    expect(e.map((x) => x.state)).toEqual(["requested", "approved", "consumed"]);
    expect(e.every((x) => x.approval_id === r.record.id)).toBe(true);
    expect(e[0]).toMatchObject({ tool: "purix_index", component_id: "alpha", checkpoint_kind: "mcp_index_full" });
    expect(verifyAuditChain().valid).toBe(true);
  });

  test("a denial is recorded too", () => {
    const r = requestOrConsume(base, input());
    decideApproval(base, r.record.id, "denied");
    expect(events().map((x) => x.state)).toEqual(["requested", "denied"]);
  });

  test("a repeated request for the same live call does not add a second 'requested' record", () => {
    requestOrConsume(base, input());
    requestOrConsume(base, input());
    expect(events().map((x) => x.state)).toEqual(["requested"]);
  });

  test("the record holds hashes, never the message text or the arguments", () => {
    requestOrConsume(base, input());
    const text = JSON.stringify(events());
    expect(text).not.toContain("Agent requests a full re-index");
    expect(events()[0]).toHaveProperty("action_key");
    expect(events()[0]).toHaveProperty("message_hash");
  });

  test("a project folder other than the one the store belongs to writes nothing to this chain", () => {
    const other = mkdtempSync(join(tmpdir(), "purix-apr-other-"));
    try {
      requestOrConsume(other, input());
      expect(events()).toEqual([]);
    } finally {
      safeRmSync(other);
    }
  });
});
