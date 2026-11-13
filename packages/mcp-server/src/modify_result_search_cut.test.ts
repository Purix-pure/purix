// F06-05 (MCP side): when the search for tests stopped at its file limit, the MCP result a person approves, the stored result that is
// applied later, and the diff-ingest event must say so instead of "no test is related", which nobody checked for a cut-off search.
import { describe, test } from "node:test";
import { expect } from "expect";
import { appliedNotTestedLine, buildModifyResult, parseModifyResultPayload } from "./modify_result";

const input = (over: Partial<Parameters<typeof buildModifyResult>[0]> = {}) => ({
  agentId: "a", componentId: "svc", instruction: "i", baseVersion: 1, operation: "update_config_value",
  contractChanged: false, fromEscalation: false, isolation: "bwrap" as string | undefined, notTested: ["a.ts"] as string[] | undefined,
  notChecked: undefined as string[] | undefined, testSearchCut: undefined as boolean | undefined, hasCoverage: false,
  decision: { action: "human_confirm" as const, reason: "r" },
  originalFiles: [{ path: "a.ts", content: "a\n" }],
  finalFiles: [{ path: "a.ts", new_content: "b\n" }],
  ...over,
});

describe("F06-05: the MCP result says the test search was cut off", () => {
  test("a cut-off search is worded as cut, in the summary and in the approval message", () => {
    const r = buildModifyResult(input({ testSearchCut: true }));
    expect(r.summary).toContain("file limit");
    expect(r.message).toContain("file limit");
    expect(r.summary).not.toContain("no test is related");
  });

  test("a finished search keeps the generic sentence", () => {
    const r = buildModifyResult(input());
    expect(r.summary).toContain("no test is related to a.ts");
    expect(r.summary).not.toContain("file limit");
  });

  test("the stored payload keeps the flag, an older payload without it still parses, and a non-boolean is refused", () => {
    const r = buildModifyResult(input({ testSearchCut: true }));
    expect(parseModifyResultPayload(r.payload)?.testSearchCut).toBe(true);
    const { testSearchCut: _drop, ...older } = r.payload;
    expect(parseModifyResultPayload(older)).not.toBeNull();
    expect(parseModifyResultPayload({ ...r.payload, testSearchCut: "yes" })).toBeNull();
  });

  test("the line printed when a stored result is applied uses the stored flag", () => {
    const cut = buildModifyResult(input({ testSearchCut: true })).payload;
    const done = buildModifyResult(input()).payload;
    expect(appliedNotTestedLine(cut)).toContain("file limit");
    expect(appliedNotTestedLine(done)).toContain("no test is related to a.ts");
    expect(appliedNotTestedLine({ ...done, notTested: [] })).toBe("");
  });
});
