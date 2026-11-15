// The approver of an MCP modify is shown how the model read the agent's instruction, when it read it differently or assumed something.
import { describe, test } from "node:test";
import { expect } from "expect";
import { buildModifyResult, interpretationLine } from "./modify_result";

const base = (o: Partial<Parameters<typeof buildModifyResult>[0]> = {}): Parameters<typeof buildModifyResult>[0] => ({
  agentId: "agent", componentId: "billing", instruction: "raise the limit", baseVersion: 1, operation: "modify", contractChanged: false,
  fromEscalation: false, isolation: "none", notTested: undefined, hasCoverage: true, decision: { action: "human_confirm", reason: "r" },
  originalFiles: [{ path: "a.ts", content: "a\n" }], finalFiles: [{ path: "a.ts", new_content: "b\n" }], ...o,
});

describe("interpretationLine", () => {
  test("nothing is said when the model read the instruction the same way and assumed nothing", () => {
    expect(interpretationLine("raise the limit", "  Raise  the LIMIT ", [])).toBeUndefined();
    expect(interpretationLine("raise the limit", undefined, undefined)).toBeUndefined();
  });
  test("a different reading, or any assumption, is shown", () => {
    expect(interpretationLine("raise the limit", "raise the request limit in billing.ts from 3 to 5", [])).toBe('Interpreted as: "raise the request limit in billing.ts from 3 to 5"');
    expect(interpretationLine("raise the limit", "raise the limit", ["the limit is the request limit"])).toContain("(assumed: the limit is the request limit)");
  });
  test("model text is one line, without control or hidden direction characters, and capped", () => {
    const line = interpretationLine("x", "do\nthis\u202e\u0007 now" + "y".repeat(400), ["a\nb", "", "c", "d", "e"])!;
    expect(line).not.toMatch(/[\n\u202e\u0007]/);
    expect(line.length).toBeLessThan(700);
    expect(line).toContain("(assumed: a b; c; d)");
  });
});

describe("approval text", () => {
  test("carries the interpretation line, and omits it when there is nothing to say", () => {
    const shown = buildModifyResult(base({ interpretedAs: "raise the limit constant from 3 to 5", assumptions: [] }));
    expect(shown.message).toContain('Interpreted as: "raise the limit constant from 3 to 5"');
    expect(shown.summary).toContain("Interpreted as:");
    expect(buildModifyResult(base({ interpretedAs: "raise the limit", assumptions: [] })).message).not.toContain("Interpreted as");
    expect(buildModifyResult(base()).message).not.toContain("Interpreted as");
  });
});
