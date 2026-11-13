// src/modify_result_security.test.ts
//
// C4: the MCP result a person approves must carry what the security gate saw and did not block, and the files its code rules did not read.
import { test } from "node:test";
import { expect } from "expect";
import { buildModifyResult, type BuildInput } from "./modify_result";

const base: BuildInput = {
  agentId: "a", componentId: "greet", instruction: "x", baseVersion: 1, operation: "modify_code", contractChanged: false, fromEscalation: false,
  isolation: "none", notTested: undefined, hasCoverage: false, decision: { action: "human_confirm", reason: "r" },
  originalFiles: [{ path: "greet.ts", content: "a\n" }], finalFiles: [{ path: "greet.ts", new_content: "b\n" }],
};

test("advisories and unread files appear in the summary, the approval message and the payload", () => {
  const r = buildModifyResult({ ...base, securityNotes: { advisories: [{ path: "package.json", line: 1, category: "Scan Limit" }], notRead: [{ path: "ci.yml", reason: "data or configuration file" }] } });
  for (const text of [r.summary, r.message]) {
    expect(text).toMatch(/Security advisories \(did not block\): 1 — Scan Limit in package\.json:1/);
    expect(text).toMatch(/Security code rules did not read 1 file\(s\): ci\.yml/);
  }
  expect(r.payload.securityNotes?.notRead?.[0]?.path).toBe("ci.yml");
});

test("nothing to report adds nothing", () => {
  const r = buildModifyResult({ ...base, securityNotes: { advisories: [], notRead: [] } });
  expect(r.summary).not.toMatch(/Security/);
  expect(r.payload.securityNotes).toBeUndefined();
});
