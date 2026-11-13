// src/hooks/protocol.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { classifyTool, denyAnswer, allowAnswer, parseHookPayload } from "./protocol";

const claude = (o: object) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/p", ...o });

describe("parseHookPayload", () => {
  test("Claude Code Edit: reads file_path and classes the tool as a write", () => {
    const r = parseHookPayload("claude-code", "pre-tool-use", claude({ tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } }));
    expect(r.ok && r.call.toolClass).toBe("write");
    expect(r.ok && r.call.paths).toEqual(["src/a.ts"]);
  });
  test("MultiEdit: every edits[] entry's path is collected, de-duplicated", () => {
    const r = parseHookPayload("claude-code", "pre-tool-use", claude({ tool_name: "MultiEdit", tool_input: { file_path: "a.ts", edits: [{ file_path: "b.ts" }, { file_path: "a.ts" }] } }));
    expect(r.ok && r.call.paths.sort()).toEqual(["a.ts", "b.ts"]);
  });
  test("NotebookEdit uses notebook_path", () => {
    const r = parseHookPayload("claude-code", "pre-tool-use", claude({ tool_name: "NotebookEdit", tool_input: { notebook_path: "n.ipynb" } }));
    expect(r.ok && r.call.paths).toEqual(["n.ipynb"]);
  });
  test("an apply-patch style input names its files in the patch text", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n*** End Patch";
    const r = parseHookPayload("cursor", "pre-tool-use", JSON.stringify({ tool_name: "ApplyPatch", tool_input: { input: patch } }));
    expect(r.ok && r.call.paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
  test("Codex apply_patch: the patch text arrives in tool_input.command; every file it names, including a rename target, is collected", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** Delete File: old.ts\n*** End Patch";
    const r = parseHookPayload("cursor", "pre-tool-use", JSON.stringify({ tool_name: "apply_patch", tool_input: { command: patch } }));
    expect(r.ok && r.call.toolClass).toBe("write");
    expect(r.ok && r.call.paths.sort()).toEqual(["old.ts", "src/a.ts", "src/b.ts"]);
  });
  test("Cursor beforeShellExecution: no tool_name, command at top level, becomes a shell call", () => {
    const r = parseHookPayload("cursor", "pre-tool-use", JSON.stringify({ command: "rm src/a.ts", cwd: "/p", workspace_roots: ["/p"] }));
    expect(r.ok && r.call.toolClass).toBe("shell");
    expect(r.ok && r.call.command).toBe("rm src/a.ts");
    expect(r.ok && r.call.roots).toEqual(["/p"]);
  });
  test("Bash reads tool_input.command", () => {
    const r = parseHookPayload("claude-code", "pre-tool-use", claude({ tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(r.ok && r.call.command).toBe("ls");
  });
  test("an MCP tool and a read tool are 'other'", () => {
    expect(classifyTool("mcp__purix__purix_change")).toBe("other");
    expect(classifyTool("Read")).toBe("other");
    expect(classifyTool("write")).toBe("write");
  });
  test("invalid JSON, a non-object and a missing tool are all refused (the caller denies)", () => {
    expect(parseHookPayload("claude-code", "pre-tool-use", "not json").ok).toBe(false);
    expect(parseHookPayload("claude-code", "pre-tool-use", "[]").ok).toBe(false);
    expect(parseHookPayload("claude-code", "pre-tool-use", "{}").ok).toBe(false);
  });
  test("stop reads the loop guard", () => {
    const r = parseHookPayload("claude-code", "stop", JSON.stringify({ stop_hook_active: true }));
    expect(r.ok && r.call.stopHookActive).toBe(true);
  });
});

describe("answers", () => {
  test("Claude Code deny is exit 2 with the reason on stderr and no stdout (JSON is ignored on exit 2)", () => {
    const a = denyAnswer("claude-code", "because");
    expect(a.exitCode).toBe(2);
    expect(a.stdout).toBe("");
    expect(a.stderr).toContain("because");
  });
  test("Cursor deny is exit 2 AND a permission:deny JSON, so either reading of the protocol denies", () => {
    const a = denyAnswer("cursor", "because");
    expect(a.exitCode).toBe(2);
    expect(JSON.parse(a.stdout).permission).toBe("deny");
  });
  test("allow says nothing (an explicit allow can act as a grant in Cursor)", () => {
    expect(allowAnswer()).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});
