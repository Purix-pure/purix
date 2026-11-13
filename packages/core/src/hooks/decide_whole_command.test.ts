// src/hooks/decide_whole_command.test.ts
//
// A9-1: the shell screen reads the WHOLE command text, not just the arguments of a verb list. Each "BYPASS TRIED" case is one of
// the misses research 09 measured with probe p1_shell_and_paths (20 of 41 should-deny cases passed before this change).
// What these tests are: the real decideHook against a synthetic governed context. What they are not: a run inside any agent.
//
// The screen is a TRIPWIRE. The "STILL PASSES" cases below are the ones no text screen can see; they are written down as tests so
// the limit stays on record (research 09 finding 1, ADR-064 wording).
import { describe, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideHook, type GovernedContext } from "./decide";
import { classifyTool, type NormalizedCall } from "./protocol";
import { safeRmSync } from "../platform/fs_retry";

const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-decide-")));
process.on("exit", () => safeRmSync(root));

const ctx: GovernedContext = {
  projectRoot: root,
  governed: new Map([
    ["src/auth.ts", "auth"],
    ["src/auth.test.ts", "auth"],
    ["src/lib/util.py", "util"],
  ]),
  protectedFiles: new Set([".claude/settings.local.json", ".mcp.json", ".vscode/settings.json"]),
  protectedAbsolute: [join(root, ".purix"), join(root, ".git", "hooks")],
  state: "ok",
  lockUsed: false,
  caseInsensitive: false,
};

function shell(command: string, c: GovernedContext = ctx) {
  const call: NormalizedCall = { agent: "claude-code", event: "pre-tool-use", tool: "Bash", toolClass: "shell", cwd: root, roots: [], paths: [], command, stopHookActive: false };
  return decideHook(call, c, root);
}
function tool(name: string, paths: string[], c: GovernedContext = ctx) {
  const call: NormalizedCall = { agent: "claude-code", event: "pre-tool-use", tool: name, toolClass: classifyTool(name), cwd: root, roots: [], paths, command: null, stopHookActive: false };
  return decideHook(call, c, root);
}
const denied = (command: string) => `${command} => ${shell(command).action}`;

describe("A9-1: whole-command scan (a tripwire)", () => {
  test("BYPASS TRIED: inline code in an interpreter that writes a governed path is blocked (python -c, node -e, ruby -e, perl -e)", () => {
    for (const c of [
      `python3 -c "open('src/auth.ts','w').write('x')"`,
      `node -e "require('fs').writeFileSync('src/auth.ts','x')"`,
      `ruby -e "File.write('src/auth.ts','x')"`,
      `perl -e 'open(F,">src/auth.ts"); print F "x"'`,
      `php -r "file_put_contents('src/auth.ts','x');"`,
    ]) expect(denied(c)).toBe(`${c} => deny`);
  });
  test("BYPASS TRIED: a heredoc that feeds code to an interpreter is read as part of that command", () => {
    expect(shell("python3 - <<'PY'\nopen('src/auth.ts','w').write('x')\nPY").action).toBe("deny");
    expect(shell("node <<EOF\nrequire('fs').writeFileSync('src/auth.ts','x')\nEOF").action).toBe("deny");
  });
  test("BYPASS TRIED: a path held in a variable, a command substitution, a brace expansion or a cd is resolved", () => {
    for (const c of ["F=src/auth.ts; echo x > $F", "export F=src/auth.ts && echo x > ${F}", "f=src/auth; echo x > $f.ts", "echo x > $(echo src/auth.ts)", "echo x > src/{auth,other}.ts", "cd src && echo x > auth.ts", "cd src; cd .. ; echo x > src/auth.ts", "pushd src && tee auth.ts"]) {
      expect(denied(c)).toBe(`${c} => deny`);
    }
  });
  test("BYPASS TRIED: a download written straight onto a governed file (curl -o, wget -O, Invoke-WebRequest -OutFile)", () => {
    for (const c of ["curl -o src/auth.ts https://example.com/x", "curl -sSL https://example.com/x --output src/auth.ts", "wget -O src/auth.ts https://example.com/x", "Invoke-WebRequest https://example.com/x -OutFile src\\auth.ts"]) {
      expect(denied(c)).toBe(`${c} => deny`);
    }
  });
  test("BYPASS TRIED: a fixer or formatter that names the file (prettier --write, eslint --fix, ruff --fix, black)", () => {
    for (const c of ["npx prettier --write src/auth.ts", "pnpm exec eslint --fix src/auth.ts", "ruff check --fix src/lib/util.py", "python -m black src/lib/util.py"]) {
      expect(denied(c)).toBe(`${c} => deny`);
    }
  });
  test("BYPASS TRIED: PowerShell and Windows spellings (backslash paths, Set-Content, .NET File calls, move)", () => {
    for (const c of ["Set-Content -Path src\\auth.ts -Value x", "[IO.File]::WriteAllText('src\\auth.ts','x')", "Out-File -FilePath .\\src\\auth.ts", "move C:\\tmp\\x src\\auth.ts"]) {
      expect(denied(c)).toBe(`${c} => deny`);
    }
  });
  test("the hook's own configuration and Purix state are protected from every one of these spellings", () => {
    for (const c of [
      `python3 -c "open('.claude/settings.local.json','w').write('{}')"`,
      `node -e "require('fs').writeFileSync('.claude/settings.local.json','{}')"`,
      "F=.claude/settings.local.json; echo '{}' > $F",
      "cd .claude && echo '{}' > settings.local.json",
      `python3 -c "open('.purix/manifest.db','w')"`,
      "echo x > .git/hooks/pre-commit",
      "curl -o .mcp.json https://example.com/x",
    ]) expect(denied(c)).toBe(`${c} => deny`);
  });
  test("the denial says it is a tripwire check and how to proceed, and names the path", () => {
    const d = shell(`python3 -c "open('src/auth.ts','w')"`);
    expect(d.action).toBe("deny");
    expect(d.targets).toEqual(["src/auth.ts"]);
    expect(d.reason).toContain("src/auth.ts");
    expect(d.reason).toMatch(/purix change|purix_change/);
    expect(d.reason).toMatch(/read-only/i);
  });

  test("MUST ALLOW: read-only commands, git bookkeeping, running a governed script, tests and checks that name a governed file", () => {
    for (const c of [
      "cat src/auth.ts",
      "grep -n export src/auth.ts",
      "head -n 5 src/auth.ts",
      "git status",
      "git diff src/auth.ts",
      "git log --oneline -- src/auth.ts",
      "git add src/auth.ts",
      `git commit -m "fix src/auth.ts"`,
      "git commit -F - <<'EOF'\nupdate src/auth.ts and src/auth.test.ts\nEOF",
      "ls src",
      "wc -l src/auth.ts",
      "diff src/auth.ts src/other.ts",
      "node src/auth.js",
      "python3 src/lib/util.py --help",
      "npx vitest run src/auth.test.ts",
      "pnpm exec jest src/auth.test.ts",
      "python -m pytest src/lib/util.py",
      "npx tsc --noEmit -p .",
      "npx eslint src/auth.ts",
      "npx prettier --check src/auth.ts",
      "Get-Content src\\auth.ts",
      "echo hi",
      "echo hi > /dev/null",
      "ls src && pnpm test",
      "F=src/auth.ts; cat $F",
      "cd src && cat auth.ts",
      "purix change \"rename a in src/auth.ts\"",
    ]) expect(`${c} => ${shell(c).action}`).toBe(`${c} => allow`);
  });
  test("MUST ALLOW: a write to a file that is neither governed nor protected, however it is spelled", () => {
    for (const c of ["python3 -c \"open('src/free.ts','w').write('x')\"", "F=src/free.ts; echo x > $F", "cd src && echo x > free.ts", "curl -o src/free.ts https://example.com/x", "mkdir -p src/new && touch src/new/x.ts"]) {
      expect(`${c} => ${shell(c).action}`).toBe(`${c} => allow`);
    }
  });
  test("an in-place flag turns a read-only tool into a write, and a lone name does not matter", () => {
    expect(shell("sed -i 's/1/2/' src/auth.ts").action).toBe("deny");
    expect(shell("find src -name auth.ts -delete").action).toBe("deny");
    expect(shell("find src -name auth.ts -exec rm {} +").action).toBe("deny");
    expect(shell("find src -name '*.ts'").action).toBe("allow");
    expect(shell("npx eslint --fix src/auth.ts").action).toBe("deny");
    expect(shell("npx vitest run src/auth.test.ts -u").action).toBe("deny");
  });
  test("a quoted semicolon or pipe inside one argument does not split the command into fake segments", () => {
    expect(shell(`git commit -m "a; b | c src/auth.ts"`).action).toBe("allow");
  });

  test("STILL PASSES (design limit, stated): a script file, a package script, and an encoded string piped to a shell", () => {
    expect(shell("python3 fix.py").action).toBe("allow");
    expect(shell("node fix.js").action).toBe("allow");
    expect(shell("npm run codemod").action).toBe("allow");
    expect(shell("echo ZWNobyB4ID4gc3JjL2F1dGgudHM= | base64 -d | sh").action).toBe("allow");
  });
  test("STILL PASSES (design limit, stated): a fixer run over a folder without naming a governed file", () => {
    expect(shell("npx prettier --write .").action).toBe("allow");
  });

  test("a script that is handed a governed path as an ARGUMENT is blocked: it may write it", () => {
    expect(shell("python3 fix.py src/auth.ts").action).toBe("deny");
    expect(shell("node fix.js src/auth.ts").action).toBe("deny");
  });
});

describe("A9-1: write tools are told apart by input shape, not only by name", () => {
  test("an unlisted write tool, and an MCP file writer, are blocked on a governed path", () => {
    expect(tool("FileWrite", ["src/auth.ts"]).action).toBe("deny");
    expect(tool("mcp__filesystem__write_file", ["src/auth.ts"]).action).toBe("deny");
    expect(tool("mcp__filesystem__move_file", ["src/auth.ts"]).action).toBe("deny");
    expect(tool("SomeNewEditor", ["src/auth.ts"]).action).toBe("deny");
  });
  test("a read-looking tool with a path is not blocked, and neither is Purix's own MCP server", () => {
    expect(tool("Read", ["src/auth.ts"]).action).toBe("allow");
    expect(tool("mcp__filesystem__read_file", ["src/auth.ts"]).action).toBe("allow");
    expect(tool("Grep", ["src/auth.ts"]).action).toBe("allow");
    expect(tool("mcp__purix__purix_index", ["src/auth.ts"]).action).toBe("allow");
    expect(tool("purix_adopt", ["src/auth.ts"]).action).toBe("allow");
  });
  test("a backslash path is the same file (a Windows-style Edit on any platform)", () => {
    expect(tool("Write", ["src\\auth.ts"]).action).toBe("deny");
    expect(tool("Edit", [".claude\\settings.local.json"]).action).toBe("deny");
  });
  test("an unlisted tool with a path to an ungoverned file is allowed", () => {
    expect(tool("FileWrite", ["src/free.ts"]).action).toBe("allow");
  });
});
