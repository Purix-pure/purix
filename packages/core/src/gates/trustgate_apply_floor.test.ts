// A9-1 follow-up from the handoff: the floor must hold an auto-commit on EVERY front door. The MCP diff-ingest path had no floor at
// all; the instruction path had one inline copy. One helper now serves the CLI and both MCP paths.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { applyDeterministicFloor } from "./trustgate.js";

describe("applyDeterministicFloor", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-floor-")); });
  afterEach(() => safeRmSync(dir));

  it("an auto_commit that touches a floor path becomes human_confirm, and the floor result is returned for the log", () => {
    const r = applyDeterministicFloor({ action: "auto_commit", reason: "ok" }, [".github/workflows/ci.yml"], dir);
    expect(r.decision.action).toBe("human_confirm");
    expect(r.decision.reason).toContain(".github/workflows/ci.yml");
    expect(r.decision.reason).toContain("Deterministic Override Floor");
    expect(r.floor.hit).toBe(true);
  });
  it("never softens an abort or an existing human_confirm, and leaves a non-floor change alone", () => {
    expect(applyDeterministicFloor({ action: "abort", reason: "x" }, ["src/auth/a.ts"], dir).decision).toEqual({ action: "abort", reason: "x" });
    expect(applyDeterministicFloor({ action: "human_confirm", reason: "y" }, ["src/auth/a.ts"], dir).decision).toEqual({ action: "human_confirm", reason: "y" });
    const free = applyDeterministicFloor({ action: "auto_commit", reason: "ok" }, ["src/payments/charge.ts"], dir);
    expect(free.decision.action).toBe("auto_commit");
    expect(free.floor.hit).toBe(false);
  });
});
