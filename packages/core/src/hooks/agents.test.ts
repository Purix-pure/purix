// src/hooks/agents.test.ts
//
// The shared engine across agents (PURIX-23): one decision, different payloads and answer styles. Payload shapes come from the
// sources quoted in docs/HOOKS.md (Codex: OpenAI hooks page; Gemini CLI: Google reference; Antigravity: a logged real payload
// from a third-party write-up). None of them has come from a real client run in this repo.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, findProjectRoot } from "./run";
import { parseHookPayload, allowAnswer, denyAnswer, ANSWER_STYLE, HOOK_AGENTS } from "./protocol";
import { addHookConfig, removeHookConfig, hookInstallState, installHooks, uninstallHooks, detectHookAgents, hookConfigPath, openCodePluginSource } from "./install";
import { writeManifest, closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry";
import type { ManifestEntry } from "../manifest/schema";

function entry(id: string, files: string[]): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} }, files,
    depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: "h",
  } as unknown as ManifestEntry;
}

describe("answer styles", () => {
  test("every agent has a style, and exactly three styles exist", () => {
    for (const a of HOOK_AGENTS) expect(["exit2", "cursor", "decision-json"]).toContain(ANSWER_STYLE[a]);
  });
  test("exit2 agents (Claude Code, Codex, OpenCode): deny = exit 2 + stderr; allow = silence", () => {
    for (const a of ["claude-code", "codex", "opencode"] as const) {
      const d = denyAnswer(a, "why");
      expect(d.exitCode).toBe(2);
      expect(d.stdout).toBe("");
      expect(d.stderr).toContain("why");
      expect(allowAnswer(a)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });
  test("decision-json agents (Gemini CLI, Antigravity): deny = JSON decision on exit 0 with nothing else on stdout; allow = explicit allow", () => {
    for (const a of ["gemini", "antigravity"] as const) {
      const d = denyAnswer(a, "why");
      expect(d.exitCode).toBe(0);
      expect(JSON.parse(d.stdout)).toEqual({ decision: "deny", reason: expect.stringContaining("why") });
      expect(d.stderr).toBe("");
      expect(JSON.parse(allowAnswer(a).stdout)).toEqual({ decision: "allow" });
    }
  });
});

describe("payload shapes", () => {
  test("Codex apply_patch and Bash read tool_input.command", () => {
    const patch = parseHookPayload("codex", "pre-tool-use", JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }, cwd: "/p" }));
    expect(patch.ok && patch.call.paths).toEqual(["src/a.ts"]);
    const bash = parseHookPayload("codex", "pre-tool-use", JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm src/a.ts" }, cwd: "/p" }));
    expect(bash.ok && bash.call.command).toBe("rm src/a.ts");
  });
  test("Gemini CLI write_file / replace use file_path; run_shell_command uses command", () => {
    const w = parseHookPayload("gemini", "pre-tool-use", JSON.stringify({ tool_name: "write_file", tool_input: { file_path: "src/a.ts", content: "x" }, cwd: "/p" }));
    expect(w.ok && w.call.paths).toEqual(["src/a.ts"]);
    const r = parseHookPayload("gemini", "pre-tool-use", JSON.stringify({ tool_name: "replace", tool_input: { file_path: "src/a.ts" } }));
    expect(r.ok && r.call.toolClass).toBe("write");
    const s = parseHookPayload("gemini", "pre-tool-use", JSON.stringify({ tool_name: "run_shell_command", tool_input: { command: "ls" } }));
    expect(s.ok && s.call.toolClass).toBe("shell");
  });
  test("Antigravity: the nested toolCall, workspacePaths and PascalCase argument keys are read (shape logged from a real agy session)", () => {
    const real = {
      artifactDirectoryPath: "/h/.gemini/antigravity-ide/brain/x", conversationId: "x", stepIdx: 4,
      toolCall: { args: { TargetFile: "/w/src/a.ts", CommandLine: "ignored for a write tool" }, name: "write_to_file" },
      transcriptPath: "/t.jsonl", workspacePaths: ["/w"],
    };
    const r = parseHookPayload("antigravity", "pre-tool-use", JSON.stringify(real));
    expect(r.ok && r.call.toolClass).toBe("write");
    expect(r.ok && r.call.paths).toEqual(["/w/src/a.ts"]);
    expect(r.ok && r.call.roots).toEqual(["/w"]);
    const sh = parseHookPayload("antigravity", "pre-tool-use", JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "rm src/a.ts" } }, workspacePaths: ["/w"] }));
    expect(sh.ok && sh.call.command).toBe("rm src/a.ts");
    const dir = parseHookPayload("antigravity", "pre-tool-use", JSON.stringify({ toolCall: { name: "list_dir", args: { DirectoryPath: "/w" } } }));
    expect(dir.ok && dir.call.toolClass).toBe("other");
  });
  test("OpenCode plugin payload: lower-case tool names and filePath", () => {
    const r = parseHookPayload("opencode", "pre-tool-use", JSON.stringify({ tool_name: "edit", tool_input: { filePath: "src/a.ts", oldString: "a" }, cwd: "/p" }));
    expect(r.ok && r.call.toolClass).toBe("write");
    expect(r.ok && r.call.paths).toEqual(["src/a.ts"]);
  });
});

describe("config writers", () => {
  const ok = (r: ReturnType<typeof addHookConfig>) => {
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  test("Codex: nested PreToolUse with apply_patch in the matcher, a Windows command, the exit guard, and a Stop entry", () => {
    const doc = JSON.parse(ok(addHookConfig("codex", null)).text);
    const h = doc.hooks.PreToolUse[0];
    expect(h.matcher).toContain("apply_patch");
    expect(h.hooks[0].command).toContain("purix hook codex pre-tool-use");
    expect(h.hooks[0].command).toContain("exit 2");
    expect(h.hooks[0].commandWindows).toContain("purix hook codex pre-tool-use");
    expect(doc.hooks.Stop[0].hooks[0].command).toBe("purix hook codex stop");
  });
  test("Gemini CLI: BeforeTool with a tool-name regex; a missing hook answers with a JSON deny, never silence", () => {
    const doc = JSON.parse(ok(addHookConfig("gemini", null)).text);
    expect(doc.hooks.BeforeTool[0].matcher).toBe("write_file|replace|run_shell_command");
    expect(doc.hooks.BeforeTool[0].hooks[0].command).toContain('"decision":"deny"');
  });
  test("Antigravity: a named group `purix`; the user's other groups survive; a second install changes nothing; uninstall removes only ours", () => {
    const mine = JSON.stringify({ "event-logger": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "log.py" }] }] } });
    const once = ok(addHookConfig("antigravity", mine));
    const doc = JSON.parse(once.text);
    expect(doc["event-logger"].PreToolUse[0].hooks[0].command).toBe("log.py");
    expect(doc.purix.PreToolUse[0].matcher).toBe("*");
    expect(doc.purix.PreToolUse[0].hooks[0].timeout).toBe(10);
    expect(ok(addHookConfig("antigravity", once.text)).changed).toBe(false);
    expect(hookInstallState("antigravity", once.text)).toBe("installed");
    const removed = ok(removeHookConfig(once.text));
    expect(JSON.parse(removed.text)).toEqual(JSON.parse(mine));
  });
  test("a user's own group that merely happens to be named purix, with no Purix command in it, is not removed", () => {
    const theirs = JSON.stringify({ purix: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "their-script" }] }] } });
    expect(ok(removeHookConfig(theirs)).changed).toBe(false);
  });
  test("Gemini and Codex merges keep unrelated settings and other tools' hooks", () => {
    const existing = JSON.stringify({ theme: "dark", hooks: { BeforeTool: [{ matcher: "x", hooks: [{ type: "command", command: "other" }] }] } });
    const doc = JSON.parse(ok(addHookConfig("gemini", existing)).text);
    expect(doc.theme).toBe("dark");
    expect(doc.hooks.BeforeTool).toHaveLength(2);
  });
});

describe("files and detection", () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "purix-agents-"));
    home = mkdtempSync(join(tmpdir(), "purix-home-"));
  });
  afterEach(() => {
    safeRmSync(root);
    safeRmSync(home);
  });

  test("Antigravity defaults to the global file under the given home; --project writes .agents/hooks.json", () => {
    expect(hookConfigPath("antigravity", "user", root, home)).toBe(join(home, ".gemini", "config", "hooks.json"));
    const r = installHooks("antigravity", "user", root, home);
    expect(r.result.ok && existsSync(join(home, ".gemini", "config", "hooks.json"))).toBe(true);
    expect(installHooks("antigravity", "project", root, home).path).toBe(join(root, ".agents", "hooks.json"));
    expect(() => hookConfigPath("codex", "user", root, home)).toThrow();
  });
  test("OpenCode: writes one owned plugin that runs the shared engine and throws on a block or a failed spawn", () => {
    const r = installHooks("opencode", "local", root, home);
    const text = readFileSync(r.path, "utf-8");
    expect(text).toContain('"hook", "opencode", "pre-tool-use"');
    expect(text).toContain("tool.execute.before");
    expect(text).toContain("throw new Error");
    expect(text).toBe(openCodePluginSource());
    expect(installHooks("opencode", "local", root, home).result.ok && installHooks("opencode", "local", root, home).result).toMatchObject({ changed: false });
    expect(uninstallHooks("opencode", "local", root, home).result).toMatchObject({ ok: true, changed: true });
    expect(existsSync(r.path)).toBe(false);
  });
  test("OpenCode: a file with that name that Purix did not write is never overwritten or deleted", () => {
    const p = hookConfigPath("opencode", "local", root, home);
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(p, "// my own plugin\n");
    expect(installHooks("opencode", "local", root, home).result.ok).toBe(false);
    expect(uninstallHooks("opencode", "local", root, home).result.ok).toBe(false);
    expect(readFileSync(p, "utf-8")).toBe("// my own plugin\n");
  });
  test("detection installs only for agents already used in the folder", () => {
    expect(detectHookAgents(root)).toEqual([]);
    mkdirSync(join(root, ".codex"));
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, "opencode.json"), "{}");
    expect(detectHookAgents(root).sort()).toEqual(["claude-code", "codex", "opencode"]);
  });
});

describe("tamper tests through the shared engine (real store)", () => {
  let root: string;
  let prev: string;
  beforeEach(() => {
    prev = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-agents-run-")));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git")); // marks the project root for agents that send only a working directory
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    process.chdir(root);
    writeManifest(entry("alpha", ["src/a.ts"]));
    closeDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(prev);
    safeRmSync(root);
  });

  test("Codex: apply_patch that updates a governed file is blocked with exit 2; a patch that only adds a new file passes", () => {
    const patch = (p: string) => JSON.stringify({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n@@\n-x\n+y\n*** End Patch` }, cwd: root });
    const blocked = runHook("codex", "pre-tool-use", patch("src/a.ts"));
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain("alpha");
    const added = runHook("codex", "pre-tool-use", patch("src/new.ts"));
    // C5: allowed, silent on stdout, and stderr names the ungoverned file.
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toBe("");
    expect(added.stderr).toContain("src/new.ts");
    expect(runHook("codex", "pre-tool-use", JSON.stringify({ tool_name: "Bash", tool_input: { command: "sed -i s/1/2/ src/a.ts" }, cwd: root })).exitCode).toBe(2);
  });
  test("Codex sends only a working directory: a call from a SUBFOLDER still finds the project and blocks", () => {
    expect(findProjectRoot(join(root, "src"))).toBe(root);
    const r = runHook("codex", "pre-tool-use", JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" }, cwd: join(root, "src") }));
    expect(r.exitCode).toBe(2);
  });
  test("Codex: Stop reports drift with exit 2 and honours the loop guard", () => {
    const stop = (active: boolean) => runHook("codex", "stop", JSON.stringify({ cwd: root, stop_hook_active: active }));
    // The fixture row has a placeholder sync hash, so the governed file reads as changed.
    expect(stop(false).exitCode).toBe(2);
    expect(stop(true).exitCode).toBe(0);
  });
  test("Gemini CLI: a governed write_file is a JSON deny on exit 0; a free file gets an explicit allow", () => {
    const denied = runHook("gemini", "pre-tool-use", JSON.stringify({ tool_name: "write_file", tool_input: { file_path: "src/a.ts", content: "x" }, cwd: root }));
    expect(denied.exitCode).toBe(0);
    expect(JSON.parse(denied.stdout).decision).toBe("deny");
    const free = runHook("gemini", "pre-tool-use", JSON.stringify({ tool_name: "write_file", tool_input: { file_path: "src/new.ts", content: "x" }, cwd: root }));
    expect(JSON.parse(free.stdout)).toEqual({ decision: "allow" });
  });
  test("Antigravity: a governed write_to_file and a rm through run_command are denied; list_dir is allowed; unreadable input is a deny, not silence", () => {
    const write = runHook("antigravity", "pre-tool-use", JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: join(root, "src", "a.ts") } }, workspacePaths: [root] }));
    expect(JSON.parse(write.stdout).decision).toBe("deny");
    const rm = runHook("antigravity", "pre-tool-use", JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "rm src/a.ts" } }, workspacePaths: [root] }));
    expect(JSON.parse(rm.stdout).decision).toBe("deny");
    const ls = runHook("antigravity", "pre-tool-use", JSON.stringify({ toolCall: { name: "list_dir", args: { DirectoryPath: root } }, workspacePaths: [root] }));
    expect(JSON.parse(ls.stdout).decision).toBe("allow");
    expect(JSON.parse(runHook("antigravity", "pre-tool-use", "garbage").stdout).decision).toBe("deny");
  });
  test("OpenCode: the plugin's payload is blocked with exit 2 for a governed edit and passes for a free one", () => {
    const e = (p: string) => JSON.stringify({ tool_name: "edit", tool_input: { filePath: p, oldString: "1", newString: "2" }, cwd: root });
    expect(runHook("opencode", "pre-tool-use", e("src/a.ts")).exitCode).toBe(2);
    expect(runHook("opencode", "pre-tool-use", e("src/free.ts")).exitCode).toBe(0);
  });
  test("every agent's own hook config is protected from a write tool", () => {
    for (const [agent, tool, key] of [["codex", "Write", "file_path"], ["gemini", "write_file", "file_path"], ["opencode", "write", "filePath"]] as const) {
      for (const p of [".codex/hooks.json", ".gemini/settings.json", ".agents/hooks.json", ".opencode/plugins/purix-guard.ts"]) {
        const r = runHook(agent, "pre-tool-use", JSON.stringify({ tool_name: tool, tool_input: { [key]: p }, cwd: root }));
        const blocked = r.exitCode === 2 || (r.stdout !== "" && JSON.parse(r.stdout).decision === "deny");
        expect(`${agent} ${p} blocked=${blocked}`).toBe(`${agent} ${p} blocked=true`);
      }
    }
  });
});
