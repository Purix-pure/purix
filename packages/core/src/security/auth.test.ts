// src/security/auth.test.ts
//
// Verifies review finding #1's fix: authorized_operators.json is chmod'd
// 0600 after every write, matching secrets_manager.ts's existing
// discipline for its own store. Permission bits aren't meaningful on
// Windows, so this test only asserts on posix platforms.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAuthorizedToApprove } from "./auth";

let originalCwd: string;
let tmpDir: string;
let originalAutoConfirm: string | undefined;
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-auth-test-"));
  process.chdir(tmpDir);
  originalAutoConfirm = process.env.AUTO_CONFIRM;
  // AUTO_CONFIRM is only honored when NODE_ENV === "test" (see the
  // security note in confirm.ts) — mirrors the same pattern
  // registry.test.ts already uses for PURIX_DEV_TIER.
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.AUTO_CONFIRM = "1"; // bypass the interactive bootstrap prompt
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalAutoConfirm === undefined) delete process.env.AUTO_CONFIRM;
  else process.env.AUTO_CONFIRM = originalAutoConfirm;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("authorized_operators.json permissions", () => {
  it("is written with 0600 permissions after bootstrap", async () => {
    if (process.platform === "win32") return; // posix permission bits don't apply
    await assertAuthorizedToApprove(); // bootstraps on first call
    const mode = statSync(".purix/authorized_operators.json").mode & 0o777;
    expect(mode).toBe(0o600);
  });
});