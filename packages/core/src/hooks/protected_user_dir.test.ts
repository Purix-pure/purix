// The user-level Purix folder holds stored API keys, the login, approvals and consent. An agent may not write there, and the hook context
// built for a real project lists it (and the credential files in it) so the rules in decide.ts can see it.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadGovernedContext } from "./run";
import { decideHook } from "./decide";
import { safeRmSync } from "../platform/fs_retry.js";
import type { NormalizedCall } from "./protocol";

describe("the user-level Purix folder is protected", () => {
  let root: string;
  let saved: string | undefined;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "purix-hookuser-")); saved = process.env.PURIX_USER_DIR; delete process.env.PURIX_USER_DIR; });
  afterEach(() => { safeRmSync(root); if (saved === undefined) delete process.env.PURIX_USER_DIR; else process.env.PURIX_USER_DIR = saved; });

  const write = (path: string) => ({ agent: "claude-code", event: "pre-tool-use", tool: "Write", toolClass: "write", cwd: root, roots: [root], paths: [path], command: null, stopHookActive: false }) as unknown as NormalizedCall;

  test("~/.purix is in the protected list by default", () => {
    expect(loadGovernedContext(root).protectedAbsolute).toContain(join(homedir(), ".purix"));
  });

  test("PURIX_USER_DIR replaces it", () => {
    process.env.PURIX_USER_DIR = join(root, "custom-user-dir");
    expect(loadGovernedContext(root).protectedAbsolute).toContain(join(root, "custom-user-dir"));
  });

  test("the credential files in the user folder are listed for the read rule", () => {
    const secretPaths = loadGovernedContext(root).secretPaths ?? [];
    for (const name of ["user-secrets.enc.json", "user-secrets.master.key", "session.enc"]) expect(secretPaths).toContain(join(homedir(), ".purix", name));
  });

  test("a write tool aimed at a stored-key file in the user folder is denied", () => {
    const d = decideHook(write(join(homedir(), ".purix", "user-secrets.enc.json")), loadGovernedContext(root), root);
    expect(d.action).toBe("deny");
  });

  test("a write tool aimed at any other file in the user folder is denied as protected", () => {
    const d = decideHook(write(join(homedir(), ".purix", "telemetry.json")), loadGovernedContext(root), root);
    expect(d).toMatchObject({ action: "deny", rule: "protected-file" });
  });
});
