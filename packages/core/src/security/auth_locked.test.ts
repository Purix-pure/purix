import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lockPrompts, unlockPromptsForTests } from "../cli-io/confirm.js";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";
import { assertAuthorizedToApprove, approverStatus, noApproverMessage, REGISTER_APPROVER_COMMAND } from "./auth.js";

isolateCwdForFile();
beforeEach(() => lockPrompts("mcp"));
afterEach(() => unlockPromptsForTests());

describe("approver check when nobody can be asked", () => {
  test("refuses with the terminal command, and writes no approver file", async () => {
    await expect(assertAuthorizedToApprove()).rejects.toThrow(REGISTER_APPROVER_COMMAND);
    expect(existsSync(join(".purix", "authorized_operators.json"))).toBe(false);
  });

  test("approverStatus reports none without prompting or writing", () => {
    const s = approverStatus();
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.reason).toBe("none");
      expect(s.message).toBe(noApproverMessage());
    }
    expect(existsSync(join(".purix", "authorized_operators.json"))).toBe(false);
  });
});
