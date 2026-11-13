// src/hooks/install.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { addHookConfig, removeHookConfig, hookInstallState, installHooks, uninstallHooks, hookConfigPath, extractPreToolEntry, hookStrengthFindings, CLAUDE_PRE_MATCHER, CLAUDE_HOOK_TIMEOUT_SECONDS } from "./install";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry";

const ok = (r: ReturnType<typeof addHookConfig>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("addHookConfig", () => {
  test("Claude Code: creates PreToolUse (write tools and Bash) and Stop, with the non-0/2 -> 2 guard", () => {
    const doc = JSON.parse(ok(addHookConfig("claude-code", null)).text);
    const pre = doc.hooks.PreToolUse[0];
    expect(pre.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*");
    expect(pre.hooks[0].command).toContain("purix hook claude-code pre-tool-use");
    expect(pre.hooks[0].command).toContain("exit 2");
    expect(doc.hooks.Stop[0].hooks[0].command).toBe("purix hook claude-code stop");
  });
  test("Cursor: version 1, failClosed on both pre hooks", () => {
    const doc = JSON.parse(ok(addHookConfig("cursor", null)).text);
    expect(doc.version).toBe(1);
    expect(doc.hooks.preToolUse[0].failClosed).toBe(true);
    expect(doc.hooks.beforeShellExecution[0].failClosed).toBe(true);
  });
  test("keeps other settings and other tools' hooks, and a second install leaves exactly one copy", () => {
    const existing = JSON.stringify({ model: "x", permissions: { deny: ["Read(.env)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }], Notification: [{ hooks: [{ type: "command", command: "n" }] }] } });
    const once = ok(addHookConfig("claude-code", existing));
    const twice = ok(addHookConfig("claude-code", once.text));
    expect(twice.changed).toBe(false);
    const doc = JSON.parse(twice.text);
    expect(doc.model).toBe("x");
    expect(doc.permissions.deny).toEqual(["Read(.env)"]);
    expect(doc.hooks.Notification).toHaveLength(1);
    expect(doc.hooks.PreToolUse).toHaveLength(2);
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe("other-tool");
  });
  test("refuses invalid JSON, a non-object, and a non-object hooks, and says nothing was changed", () => {
    for (const bad of ["{oops", "[]", '{"hooks": []}']) {
      const r = addHookConfig("claude-code", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("nothing was changed");
    }
  });
});

describe("removeHookConfig / state", () => {
  test("removes only ours; an otherwise-empty hooks object is dropped; other hooks stay", () => {
    const withOther = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }] } });
    const installed = ok(addHookConfig("claude-code", withOther)).text;
    const removed = ok(removeHookConfig(installed));
    expect(removed.changed).toBe(true);
    expect(JSON.parse(removed.text)).toEqual(JSON.parse(withOther));
    const solo = ok(addHookConfig("claude-code", null)).text;
    expect(JSON.parse(ok(removeHookConfig(solo)).text).hooks).toBeUndefined();
  });
  test("state: installed, partial, not-installed, unreadable", () => {
    const full = ok(addHookConfig("claude-code", null)).text;
    expect(hookInstallState("claude-code", full)).toBe("installed");
    expect(hookInstallState("claude-code", null)).toBe("not-installed");
    expect(hookInstallState("claude-code", "{}")).toBe("not-installed");
    const half = JSON.parse(full);
    delete half.hooks.Stop;
    expect(hookInstallState("claude-code", JSON.stringify(half))).toBe("partial");
    expect(hookInstallState("claude-code", "{bad")).toBe("unreadable");
  });
});

describe("files", () => {
  test("install writes the local settings file by default, shared on request, and uninstall undoes it", () => {
    const root = mkdtempSync(join(tmpdir(), "purix-hookinst-"));
    try {
      const local = installHooks("claude-code", "local", root);
      expect(local.path).toBe(join(root, ".claude", "settings.local.json"));
      expect(existsSync(local.path)).toBe(true);
      expect(hookConfigPath("claude-code", "shared", root)).toBe(join(root, ".claude", "settings.json"));
      expect(installHooks("cursor", "local", root).path).toBe(join(root, ".cursor", "hooks.json"));
      expect(uninstallHooks("claude-code", "local", root).result.ok).toBe(true);
      expect(JSON.parse(readFileSync(local.path, "utf-8"))).toEqual({});
    } finally {
      safeRmSync(root);
    }
  });
  test("a corrupt config file is left byte-for-byte alone", () => {
    const root = mkdtempSync(join(tmpdir(), "purix-hookinst-"));
    try {
      mkdirSync(join(root, ".claude"));
      const p = join(root, ".claude", "settings.local.json");
      writeFileSync(p, "{ not json");
      const r = installHooks("claude-code", "local", root);
      expect(r.result.ok).toBe(false);
      expect(readFileSync(p, "utf-8")).toBe("{ not json");
    } finally {
      safeRmSync(root);
    }
  });
});

describe("A9-1: the Claude Code entry fails closed on a timeout and covers PowerShell and MCP tools", () => {
  test("the PreToolUse entry sets onFailure:block and an explicit timeout; the matcher names PowerShell and every mcp__ tool", () => {
    const doc = JSON.parse(ok(addHookConfig("claude-code", null)).text);
    const h = doc.hooks.PreToolUse[0].hooks[0];
    expect(h.onFailure).toBe("block");
    expect(h.timeout).toBe(CLAUDE_HOOK_TIMEOUT_SECONDS);
    expect(Number.isInteger(h.timeout) && h.timeout > 0).toBe(true);
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]) expect(CLAUDE_PRE_MATCHER.split("|")).toContain(t);
    expect(CLAUDE_PRE_MATCHER.split("|")).toContain("mcp__.*");
    expect(new RegExp(`^(?:${CLAUDE_PRE_MATCHER})$`).test("mcp__filesystem__write_file")).toBe(true);
    expect(new RegExp(`^(?:${CLAUDE_PRE_MATCHER})$`).test("PowerShell")).toBe(true);
  });
  test("the Stop entry has a timeout and NO onFailure: a failing backstop must never trap an agent", () => {
    const doc = JSON.parse(ok(addHookConfig("claude-code", null)).text);
    const stop = doc.hooks.Stop[0].hooks[0];
    expect(typeof stop.timeout).toBe("number");
    expect(stop.onFailure).toBeUndefined();
  });
  test("re-installing over an old entry (no onFailure, no timeout) upgrades it in place and leaves one copy", () => {
    const old = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: "purix hook claude-code pre-tool-use; exit $?" }] }] } });
    expect(hookStrengthFindings("claude-code", old).length).toBeGreaterThan(0);
    const upgraded = ok(addHookConfig("claude-code", old));
    expect(upgraded.changed).toBe(true);
    const doc = JSON.parse(upgraded.text);
    expect(doc.hooks.PreToolUse).toHaveLength(1);
    expect(doc.hooks.PreToolUse[0].hooks[0].onFailure).toBe("block");
    expect(hookStrengthFindings("claude-code", upgraded.text)).toEqual([]);
  });
  test("extractPreToolEntry reads back the command and the fail-closed fields for every JSON agent", () => {
    for (const a of ["claude-code", "codex", "gemini", "cursor", "antigravity"] as const) {
      const e = extractPreToolEntry(a, ok(addHookConfig(a, null)).text);
      expect(e).not.toBeNull();
      expect(e!.command).toContain(`purix hook ${a} pre-tool-use`);
    }
    expect(extractPreToolEntry("claude-code", ok(addHookConfig("claude-code", null)).text)!.onFailure).toBe("block");
    expect(extractPreToolEntry("cursor", ok(addHookConfig("cursor", null)).text)!.failClosed).toBe(true);
    expect(extractPreToolEntry("claude-code", "{}")).toBeNull();
    expect(extractPreToolEntry("claude-code", "{not json")).toBeNull();
  });
  test("strength findings: Cursor without failClosed and Claude without onFailure are named; a fresh install has none for any agent", () => {
    for (const a of ["claude-code", "codex", "gemini", "cursor", "antigravity"] as const) expect(hookStrengthFindings(a, ok(addHookConfig(a, null)).text)).toEqual([]);
    const weakCursor = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "purix hook cursor pre-tool-use", timeout: 10 }] } });
    expect(hookStrengthFindings("cursor", weakCursor).join(" ")).toMatch(/failClosed/);
  });
});
