// Release 1 surface: the MCP result says "not checked" and "could not check" in plain words, never as success.
import { describe, test } from "node:test";
import { expect } from "expect";
import { buildModifyResult, parseModifyResultPayload, verificationFailureText } from "./modify_result";

const input = (over: Partial<Parameters<typeof buildModifyResult>[0]> = {}) => ({
  agentId: "a", componentId: "svc", instruction: "i", baseVersion: 1, operation: "update_config_value",
  contractChanged: false, fromEscalation: false, isolation: "bwrap" as string | undefined, notTested: undefined as string[] | undefined,
  notChecked: undefined as string[] | undefined, hasCoverage: true,
  decision: { action: "human_confirm" as const, reason: "r" },
  originalFiles: [{ path: "a.ts", content: "a\n" }, { path: "main.go", content: "x\n" }],
  finalFiles: [{ path: "a.ts", new_content: "b\n" }, { path: "main.go", new_content: "y\n" }],
  ...over,
});

describe("buildModifyResult with unchecked files", () => {
  test("names the files as not checked and does not say they passed", () => {
    const r = buildModifyResult(input({ notChecked: ["main.go"] }));
    expect(r.summary).toContain("Unsupported language, not checked");
    expect(r.summary).toContain("main.go");
    expect(r.summary).not.toMatch(/Verification: passed in a sandbox/);
    expect(r.message).toContain("not checked");
  });
  test("a clean run keeps the old line", () => {
    expect(buildModifyResult(input()).summary).toContain("Verification: passed in a sandbox (isolation: bwrap).");
  });
  test("the stored payload keeps notChecked and still parses when an older payload lacks it", () => {
    const r = buildModifyResult(input({ notChecked: ["main.go"] }));
    expect(parseModifyResultPayload(r.payload)?.notChecked).toEqual(["main.go"]);
    const { notChecked: _drop, ...older } = r.payload;
    expect(parseModifyResultPayload(older)).not.toBeNull();
  });
});

describe("verificationFailureText", () => {
  test("a missing tool is 'could not check', not 'both failed'", () => {
    const t = verificationFailureText("Sandbox verification and escalation both failed", { reason: "TypeScript is not installed", infrastructure: { kind: "not_installed", actionHint: "Run purix tools install typescript." } });
    expect(t).toContain("Could not check");
    expect(t).not.toContain("both failed");
    expect(t).toContain("No real files were touched.");
    expect(t).toContain("purix tools install typescript");
  });
  test("an unsupported language says not checked", () => {
    expect(verificationFailureText("x", { reason: "Unsupported language, not checked: Go", infrastructure: { kind: "unsupported_language" } })).toContain("Not checked: unsupported language");
  });
  test("a code failure keeps the old wording", () => {
    expect(verificationFailureText("Sandbox verification and escalation both failed", { reason: "TS2322" })).toBe("Sandbox verification and escalation both failed: TS2322. No real files were touched.");
  });
});
