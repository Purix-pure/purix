// An agent may not READ the credential files or the OS keyring entry, as well as not write them. A write was already refused;
// a read of `.purix/secrets.master.key` plus `secrets.enc.json` gave an agent every stored key.
//
// What this proves: the text and path rules below, on Linux-style paths. What it does not: that a real agent client sends these
// calls to the hook (Claude Code's registered matcher does not include its built-in Read tool), or Windows path handling.
import { after, before, describe, test } from "node:test";
import { expect } from "expect";
import { decideHook, type GovernedContext } from "./decide";
import { parseHookPayload, type NormalizedCall } from "./protocol";

const HOME = "/home/ann";
const ctx: GovernedContext = {
  projectRoot: "/p",
  governed: new Map(),
  protectedFiles: new Set(),
  protectedAbsolute: [`${HOME}/.purix`, "/p/.purix"],
  secretPaths: [
    `${HOME}/.purix/user-secrets.enc.json`,
    `${HOME}/.purix/user-secrets.master.key`,
    `${HOME}/.purix/secrets.enc.json`,
    `${HOME}/.purix/secrets.master.key`,
    `${HOME}/.purix/session.enc`,
    "/p/.purix/secrets.enc.json",
    "/p/.purix/secrets.master.key",
  ],
  state: "ok",
  lockUsed: false,
  caseInsensitive: false,
};

const shell = (command: string): NormalizedCall =>
  ({ agent: "claude-code", event: "pre-tool-use", tool: "Bash", toolClass: "shell", cwd: "/p", roots: [], paths: [], command, stopHookActive: false }) as unknown as NormalizedCall;
const readTool = (tool: string, readPaths: string[]): NormalizedCall =>
  ({ agent: "claude-code", event: "pre-tool-use", tool, toolClass: "other", cwd: "/p", roots: [], paths: [], readPaths, command: null, stopHookActive: false }) as unknown as NormalizedCall;

// `~` is expanded from the real home folder, so the tests that use it point HOME at the folder the context was written for.
// os.homedir() reads HOME on macOS and Linux but USERPROFILE on Windows, so both are pointed at it (with HOME alone, a Windows run expanded
// `~` to the developer's real home and the `~/.purix/*.key` glob case was judged against the wrong folder).
let savedHome: string | undefined;
let savedProfile: string | undefined;
before(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

describe("secret-read: shell", () => {
  for (const cmd of [
    "cat /p/.purix/secrets.master.key",
    "cat .purix/secrets.master.key",
    "cat .purix/secrets.enc.json",
    "head -c 100 /p/.purix/secrets.enc.json",
    "grep -r . /p/.purix/secrets.master.key",
    "base64 /p/.purix/secrets.master.key",
    "cat ~/.purix/user-secrets.master.key",
    "cat ~/.purix/user-secrets.enc.json",
    "cat ~/.purix/session.enc",
    `cat ${HOME}/.purix/user-secrets.master.key`,
    "cat .purix/secrets.*",
    "cat ~/.purix/*.key",
    "echo hi && cat .purix/secrets.master.key",
    "cd .purix && cat secrets.master.key",
    "security find-generic-password -s purix -a GEMINI_API_KEY -w",
    "secret-tool lookup service purix",
    "cmdkey /list | findstr purix",
    "powershell -c \"(New-Object System.Management.Automation.PSCredential('x', (Get-StoredCredential -Target purix)))\"",
  ]) {
    test(`denies: ${cmd}`, () => {
      const d = decideHook(shell(cmd), ctx, "/p");
      expect(d.action).toBe("deny");
      expect(d.rule).toBe("secret-read");
      expect(d.reason).not.toContain("AIza"); // never echoes a value
    });
  }

  for (const cmd of [
    "cat README.md",
    "cat .purix/config.json",
    "ls .purix",
    "git status",
    "grep -n secret src/a.ts",
    "cat ~/.bashrc",
    "security find-generic-password -s some-other-tool -w", // another tool's entry, no mention of purix
    "purix secret status",
    "pnpm test",
  ]) {
    test(`allows: ${cmd}`, () => {
      expect(decideHook(shell(cmd), ctx, "/p").rule).not.toBe("secret-read");
    });
  }

  test("an agent still cannot run `purix secret migrate`", () => {
    const d = decideHook(shell("purix secret migrate"), ctx, "/p");
    expect(d).toMatchObject({ action: "deny", rule: "human-only" });
  });
});

describe("secret-read: file tools", () => {
  test("a read-named tool that names a credential file is refused", () => {
    for (const p of ["/p/.purix/secrets.master.key", ".purix/secrets.enc.json", `${HOME}/.purix/user-secrets.master.key`]) {
      const d = decideHook(readTool("mcp__filesystem__read_file", [p]), ctx, "/p");
      expect(d).toMatchObject({ action: "deny", rule: "secret-read" });
    }
  });

  test("a read of an ordinary file is not", () => {
    expect(decideHook(readTool("mcp__filesystem__read_file", ["/p/src/a.ts"]), ctx, "/p").action).toBe("allow");
  });

  test("a write tool aimed at a credential file is refused too", () => {
    const write = { agent: "claude-code", event: "pre-tool-use", tool: "Write", toolClass: "write", cwd: "/p", roots: [], paths: [`${HOME}/.purix/user-secrets.enc.json`], command: null, stopHookActive: false } as unknown as NormalizedCall;
    expect(decideHook(write, ctx, "/p").action).toBe("deny");
  });

  test("a write into the user-level Purix folder is refused even for a file that is not a credential", () => {
    const write = { agent: "claude-code", event: "pre-tool-use", tool: "Write", toolClass: "write", cwd: "/p", roots: [], paths: [`${HOME}/.purix/telemetry.json`], command: null, stopHookActive: false } as unknown as NormalizedCall;
    expect(decideHook(write, ctx, "/p")).toMatchObject({ action: "deny", rule: "protected-file" });
  });

  test("with no secretPaths in the context the read rule does nothing (older callers keep working)", () => {
    const bare: GovernedContext = { ...ctx, secretPaths: undefined };
    expect(decideHook(readTool("mcp__filesystem__read_file", ["/p/.purix/secrets.master.key"]), bare, "/p").action).toBe("allow");
  });
});

describe("protocol: readPaths", () => {
  const parse = (tool: string, input: unknown) => parseHookPayload("claude-code", "pre-tool-use", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: "/p" }));

  test("a read-like MCP tool's path is collected as a read path and the call is not turned into a write", () => {
    const r = parse("mcp__filesystem__read_file", { path: "/p/.purix/secrets.master.key" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.call.readPaths).toEqual(["/p/.purix/secrets.master.key"]);
      expect(r.call.paths).toEqual([]);
      expect(r.call.toolClass).toBe("other");
    }
  });

  test("a write tool has no readPaths field, so existing call shapes are unchanged", () => {
    const r = parse("Write", { file_path: "/p/a.ts", content: "x" });
    expect(r.ok && "readPaths" in r.call).toBe(false);
  });
});

// A command that NAMES a credential file is refused whichever folder the file is in, because the file names are the same everywhere
// (another project's old store, a copy). Works with or without the path list in the context.
describe("secret-read: a credential file named in any folder", () => {
  const bare: GovernedContext = { ...ctx, secretPaths: undefined };
  for (const cmd of [
    "cat ../other/.purix/secrets.master.key",
    "cat /elsewhere/.purix/secrets.enc.json",
    "type %USERPROFILE%\\.purix\\secrets.enc.json",
    "Get-Content $HOME/.purix/session.enc",
    "head -c 100 .purix/secrets.enc.json",
    "cp .purix/user-secrets.master.key /tmp/k",
  ]) {
    test(`denies: ${cmd}`, () => {
      for (const c of [ctx, bare]) expect(decideHook(shell(cmd), c, "/p")).toMatchObject({ action: "deny", rule: "secret-read" });
    });
  }
  test("does not trip on a similar but different file name", () => {
    for (const cmd of ["cat docs/secrets.enc.json.md", "cat my-session.enc.txt", "cat package.json"]) {
      expect(decideHook(shell(cmd), bare, "/p").rule).not.toBe("secret-read");
    }
  });
});
