// src/modify_result_excluded.test.ts
//
// C3 item 2 (plan v4): the MCP result a person approves (and the agent reads) must name credential-looking files that were left out of the
// verification copy, like the CLI now does. Before, this reached nobody on a pass.
import { test } from "node:test";
import { expect } from "expect";
import { buildModifyResult, type BuildInput } from "./modify_result";

const base: BuildInput = {
  agentId: "a", componentId: "greet", instruction: "x", baseVersion: 1, operation: "modify_code", contractChanged: false, fromEscalation: false,
  isolation: "none", notTested: undefined, hasCoverage: false, decision: { action: "human_confirm", reason: "r" },
  originalFiles: [{ path: "greet.ts", content: "a\n" }], finalFiles: [{ path: "greet.ts", new_content: "b\n" }],
};

test("a result names the files left out of the verification copy, in the summary and the approval message", () => {
  const r = buildModifyResult({ ...base, excludedForSafety: [".npmrc"] });
  expect(r.summary).toMatch(/Left out of the verification copy for safety: \.npmrc/);
  expect(r.message).toMatch(/Left out of the verification copy for safety: \.npmrc/);
  expect(r.payload.excludedForSafety).toEqual([".npmrc"]);
});

test("a result with nothing left out says nothing about it", () => {
  const r = buildModifyResult(base);
  expect(r.summary).not.toMatch(/Left out of the verification copy/);
  expect(r.payload.excludedForSafety).toBeUndefined();
});
