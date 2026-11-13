// F04-04 (MCP side): an anchor that started or ended in the middle of a line leaves the rest of that line in place. The approval message,
// the stored result and the summary the agent gets must say so, so the person approving sees a possible leftover tail.
import { describe, test } from "node:test";
import { expect } from "expect";
import { buildModifyResult, parseModifyResultPayload } from "./modify_result";

const input = (over: Partial<Parameters<typeof buildModifyResult>[0]> = {}) => ({
  agentId: "a", componentId: "svc", instruction: "i", baseVersion: 1, operation: "update_prompt_text",
  contractChanged: false, fromEscalation: false, isolation: "bwrap" as string | undefined, notTested: [] as string[] | undefined,
  notChecked: undefined as string[] | undefined, testSearchCut: undefined as boolean | undefined, hasCoverage: true,
  partialLinePaths: undefined as string[] | undefined,
  decision: { action: "human_confirm" as const, reason: "r" },
  originalFiles: [{ path: "a.ts", content: "const x = foo(a, b);\n" }],
  finalFiles: [{ path: "a.ts", new_content: "const x = bar(a, b);\n" }],
  ...over,
});

describe("F04-04: the MCP result says an edit left the rest of a line in place", () => {
  test("a partial-line edit is named in the summary and the approval message", () => {
    const r = buildModifyResult(input({ partialLinePaths: ["a.ts"] }));
    expect(r.summary).toContain("rest of that line");
    expect(r.summary).toContain("a.ts");
    expect(r.message).toContain("rest of that line");
  });
  test("no flag, no sentence", () => {
    expect(buildModifyResult(input()).summary).not.toContain("rest of that line");
  });
  test("the stored payload keeps the paths; an older payload parses; a malformed value is refused", () => {
    const r = buildModifyResult(input({ partialLinePaths: ["a.ts"] }));
    expect(parseModifyResultPayload(r.payload)?.partialLinePaths).toEqual(["a.ts"]);
    const { partialLinePaths: _d, ...older } = r.payload;
    expect(parseModifyResultPayload(older)).not.toBeNull();
    expect(parseModifyResultPayload({ ...r.payload, partialLinePaths: "a.ts" })).toBeNull();
    expect(parseModifyResultPayload({ ...r.payload, partialLinePaths: [1] })).toBeNull();
  });
});
