// src/hooks/doctor.test.ts
//
// A9-1: `purix hooks doctor`. What these tests cover: the doctor's logic, with the command runner injected, plus one run of the
// REAL installed command string through /bin/sh against the real engine where the platform allows it (see doctor.e2e in the cli
// package). What they do not cover: any real agent. The doctor's own wording says so, and these tests hold it to that.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry";
import { installHooks } from "./install";
import { runHookDoctor, canaryPayload, blockSeen, CANARY_RELATIVE_PATH, type CanaryRunner } from "./doctor";
import { runHook } from "./run";
import { HOOK_AGENTS, type HookAgent } from "./protocol";

describe("hooks doctor", () => {
  let root: string;
  let home: string;
  let prev: string;
  beforeEach(() => {
    prev = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-doctor-root-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "purix-doctor-home-")));
    mkdirSync(join(root, ".git"));
  });
  afterEach(() => {
    process.chdir(prev);
    safeRmSync(root);
    safeRmSync(home);
  });

  // A runner that behaves like a working install: the real engine answers the canary; "no purix" gives the wrapper's block.
  const engineRunner = (agent: HookAgent): CanaryRunner => (_command, payload, mode) => {
    if (mode === "no-purix") return { exitCode: 2, stdout: agent === "gemini" || agent === "antigravity" ? '{"decision":"deny","reason":"Purix hook did not run"}' : "", stderr: "Purix hook did not run (exit 127)" };
    const a = runHook(agent, "pre-tool-use", payload);
    return { exitCode: a.exitCode, stdout: a.stdout, stderr: a.stderr };
  };

  test("nothing installed: every agent is reported as not installed and the report is not ok", () => {
    const r = runHookDoctor({ root, home, platform: "linux", run: engineRunner("claude-code") });
    expect(r.agents).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.notes.join(" ")).toMatch(/no hook is installed/i);
  });

  test("an installed Claude Code hook: config and strength pass, the canary shows a block, the wrapper blocks when purix is missing, the live-agent step is NOT claimed", () => {
    installHooks("claude-code", "local", root, home);
    const r = runHookDoctor({ root, home, platform: "linux", run: engineRunner("claude-code") });
    expect(r.agents).toHaveLength(1);
    const by = Object.fromEntries(r.agents[0]!.checks.map((c) => [c.id, c]));
    expect(by["config"]!.outcome).toBe("pass");
    expect(by["strength"]!.outcome).toBe("pass");
    expect(by["canary-block"]!.outcome).toBe("pass");
    expect(by["canary-fail-closed"]!.outcome).toBe("pass");
    expect(by["live-agent"]!.outcome).toBe("not-run");
    expect(by["live-agent"]!.message).toContain(CANARY_RELATIVE_PATH);
    expect(r.ok).toBe(true);
    // The wording must not say the agent enforces anything.
    expect(r.agents[0]!.checks.map((c) => c.message).join(" ")).not.toMatch(/verified|proves? (the|that) (live )?agent/i);
    expect(r.notes.join(" ")).toMatch(/simulated payload/i);
  });

  test("a hook that lets the canary through is a FAIL, not a pass", () => {
    installHooks("claude-code", "local", root, home);
    const r = runHookDoctor({ root, home, platform: "linux", run: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const by = Object.fromEntries(r.agents[0]!.checks.map((c) => [c.id, c]));
    expect(by["canary-block"]!.outcome).toBe("fail");
    expect(by["canary-fail-closed"]!.outcome).toBe("fail");
    expect(r.ok).toBe(false);
  });

  test("a hook command that cannot be run (not found, timeout) is a fail with the reason, never a pass", () => {
    installHooks("claude-code", "local", root, home);
    const r = runHookDoctor({ root, home, platform: "linux", run: () => ({ exitCode: null, stdout: "", stderr: "ENOENT", stopped: "not_found" }) });
    const c = r.agents[0]!.checks.find((x) => x.id === "canary-block")!;
    expect(c.outcome).toBe("fail");
    expect(c.message).toMatch(/not_found|could not be run/);
  });

  test("an old install without onFailure is reported as weak, with the upgrade command", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "purix hook claude-code pre-tool-use; exit $?" }] }], Stop: [{ hooks: [{ type: "command", command: "purix hook claude-code stop" }] }] } }));
    const r = runHookDoctor({ root, home, platform: "linux", run: engineRunner("claude-code") });
    const s = r.agents[0]!.checks.find((c) => c.id === "strength")!;
    expect(s.outcome).toBe("fail");
    expect(s.message).toContain("purix hooks install claude-code");
  });

  test("a canary file left behind in Purix's state folder is a FAIL: some tool wrote there past the hook", () => {
    installHooks("claude-code", "local", root, home);
    mkdirSync(join(root, ".purix"), { recursive: true });
    writeFileSync(join(root, CANARY_RELATIVE_PATH), "x");
    const r = runHookDoctor({ root, home, platform: "linux", run: engineRunner("claude-code") });
    const live = r.agents[0]!.checks.find((c) => c.id === "live-agent")!;
    expect(live.outcome).toBe("fail");
  });

  test("Windows: the canary is not run (not claimed), and a ready-to-paste PowerShell line is given", () => {
    installHooks("claude-code", "local", root, home);
    const r = runHookDoctor({ root, home, platform: "win32", run: () => { throw new Error("must not run on win32"); } });
    const a = r.agents[0]!;
    expect(a.checks.find((c) => c.id === "canary-block")!.outcome).toBe("not-run");
    expect(a.manual.powershell).toContain("purix hook claude-code pre-tool-use");
    expect(a.manual.powershell).toContain("$LASTEXITCODE");
    expect(r.ok).toBe(false);
  });

  test("every agent's canary payload is a WRITE to Purix's state folder that the real engine blocks, in that agent's own answer style", () => {
    for (const agent of HOOK_AGENTS) {
      const payload = canaryPayload(agent, root);
      const a = runHook(agent, "pre-tool-use", payload);
      expect(blockSeen(agent, a)).toBe(true);
    }
  });
  test("blockSeen: an allow, an empty answer and a failure to start are not a block", () => {
    expect(blockSeen("claude-code", { exitCode: 0, stdout: "", stderr: "" })).toBe(false);
    expect(blockSeen("claude-code", { exitCode: 1, stdout: "", stderr: "boom" })).toBe(false);
    expect(blockSeen("gemini", { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" })).toBe(false);
    expect(blockSeen("gemini", { exitCode: 0, stdout: JSON.stringify({ decision: "deny", reason: "x" }), stderr: "" })).toBe(true);
    expect(blockSeen("cursor", { exitCode: 2, stdout: JSON.stringify({ permission: "deny" }), stderr: "x" })).toBe(true);
  });
});
