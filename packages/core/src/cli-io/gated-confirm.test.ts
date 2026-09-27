// src/cli-io/gated-confirm.test.ts
//
// Regression coverage for GAPS-REPORT-2 §1: a real human "y" and an
// AUTO_CONFIRM=1 bypass used to record an identical "confirm_response"
// event — permanently indistinguishable in the audit trail. confirmGated()
// now tags every recorded checkpoint with whether it was auto-confirmed.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmGated } from "./gated-confirm";
import { listEvents } from "../manifest/events";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";

describe("confirmGated — auto_confirmed audit field", () => {
  let originalCwd: string;
  let tmpDir: string;
  let originalAutoConfirm: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-gated-confirm-test-"));
    process.chdir(tmpDir);
    originalAutoConfirm = process.env.AUTO_CONFIRM;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    closeDb();
    process.chdir(originalCwd);
    safeRmSync(tmpDir);
    if (originalAutoConfirm === undefined) delete process.env.AUTO_CONFIRM;
    else process.env.AUTO_CONFIRM = originalAutoConfirm;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("records auto_confirmed: true when the test-only AUTO_CONFIRM bypass fires", async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTO_CONFIRM = "1";

    const approved = await confirmGated("Proceed?", "test_checkpoint", "comp-x");
    expect(approved).toBe(true);

    const events = listEvents({ kind: "confirm_response" }).filter((e) => e.component_id === "comp-x");
    expect(events.length).toBe(1);
    expect((events[0]!.detail as any).auto_confirmed).toBe(true);
    expect((events[0]!.detail as any).approved).toBe(true);
  });
});