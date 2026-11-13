// Handoff item 2 (2026-11-07): the Stop hook allows when its own check throws. That stays (a block here would trap a finished
// agent in a loop; edits are guarded earlier, at PreToolUse), but it must no longer be silent.
import { describe, it } from "node:test";
import { expect } from "expect";
import { stopCheckErrorAnswer } from "./run.js";

describe("Stop hook: an error in its own check", () => {
  for (const agent of ["claude-code", "codex", "cursor", "gemini"] as const) {
    it(`${agent}: still allows (exit 0) but says the end-of-session check did not finish and what to run`, () => {
      const a = stopCheckErrorAnswer(agent, new Error("boom\n    at secret/path.ts:1"));
      expect(a.exitCode).toBe(0);
      expect(a.stderr).toContain("did not finish");
      expect(a.stderr).toContain("purix check");
      expect(a.stderr).not.toContain("secret/path.ts"); // no stack to the agent
    });
  }
  it("does not turn an allow into a block", () => {
    expect(stopCheckErrorAnswer("claude-code", new Error("x")).stdout).not.toContain("deny");
  });
});
