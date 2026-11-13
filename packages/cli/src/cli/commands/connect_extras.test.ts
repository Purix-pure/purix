import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInstructionBlock, instructionFileFor, hookAgentFor, commandOnPath, checkServerStarts, canPrompt, offerHooks, BLOCK_BEGIN, BLOCK_END, type HookOfferDeps } from "./connect_extras";
import { safeRmSync } from "@purix/core/platform/fs_retry";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "purix-extras-"));
});
afterEach(() => safeRmSync(cwd));

describe("instruction block", () => {
  test("creates the file the agent reads, with the block between markers", () => {
    const r = writeInstructionBlock(cwd, "claude-code");
    expect(r).toEqual({ path: "CLAUDE.md", changed: true });
    const text = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(text.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(text).toContain("purix_change");
    expect(text).toContain("purix approve <id>");
    expect(text.trimEnd().endsWith(BLOCK_END)).toBe(true);
  });

  test("agents with no file of their own read AGENTS.md", () => {
    expect(instructionFileFor("opencode").path).toBe("AGENTS.md");
    expect(instructionFileFor("codex").path).toBe("AGENTS.md");
    expect(instructionFileFor("gemini-cli").path).toBe("GEMINI.md");
  });

  test("a second run changes nothing", () => {
    writeInstructionBlock(cwd, "opencode");
    const before = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(writeInstructionBlock(cwd, "opencode").changed).toBe(false);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(before);
  });

  test("the person's own text is kept, before and after the block", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# Our rules\n\nUse tabs.\n");
    writeInstructionBlock(cwd, "codex");
    let text = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(text.startsWith("# Our rules\n\nUse tabs.\n")).toBe(true);
    expect(text).toContain(BLOCK_BEGIN);
    writeFileSync(join(cwd, "AGENTS.md"), text.replace(BLOCK_END, `${BLOCK_END}\n\n## After\nkeep me\n`));
    // Make the block stale so a rewrite is needed.
    writeFileSync(join(cwd, "AGENTS.md"), readFileSync(join(cwd, "AGENTS.md"), "utf-8").replace("purix_status", "OLD_TEXT"));
    expect(writeInstructionBlock(cwd, "codex").changed).toBe(true);
    text = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(text).not.toContain("OLD_TEXT");
    expect(text).toContain("Use tabs.");
    expect(text).toContain("## After\nkeep me");
    expect(text.split(BLOCK_BEGIN).length - 1).toBe(1);
  });

  test("a block with no end marker is left alone", () => {
    writeFileSync(join(cwd, "AGENTS.md"), `${BLOCK_BEGIN}\nhalf a block\n`);
    const r = writeInstructionBlock(cwd, "codex");
    expect(r.changed).toBe(false);
    expect(r.skipped).toContain("no end marker");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(`${BLOCK_BEGIN}\nhalf a block\n`);
  });

  test("Cursor gets its own rule file with front matter; an existing foreign file is not overwritten", () => {
    expect(writeInstructionBlock(cwd, "cursor").changed).toBe(true);
    const text = readFileSync(join(cwd, ".cursor", "rules", "purix.mdc"), "utf-8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("alwaysApply: true");

    const other = mkdtempSync(join(tmpdir(), "purix-extras-b-"));
    mkdirSync(join(other, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(other, ".cursor", "rules", "purix.mdc"), "mine");
    const r = writeInstructionBlock(other, "cursor");
    expect(r.changed).toBe(false);
    expect(r.skipped).toContain("not written by Purix");
    expect(readFileSync(join(other, ".cursor", "rules", "purix.mdc"), "utf-8")).toBe("mine");
    safeRmSync(other);
  });
});

describe("helpers", () => {
  test("connect ids map to hook agents; others have none", () => {
    expect(hookAgentFor("gemini-cli")).toBe("gemini");
    expect(hookAgentFor("claude-code")).toBe("claude-code");
    expect(hookAgentFor("windsurf")).toBeUndefined();
  });

  test("commandOnPath finds an executable on PATH and says no for a missing one", () => {
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "purix"), "#!/bin/sh\n");
    chmodSync(join(bin, "purix"), 0o755);
    expect(commandOnPath("purix", { PATH: bin }, "linux")).toBe(true);
    expect(commandOnPath("purix", { PATH: join(cwd, "nowhere") }, "linux")).toBe(false);
  });
});

describe("server check", () => {
  test("a command that is not a Purix server is reported as a failure, with a reason", async () => {
    const script = join(cwd, "notpurix.mjs");
    writeFileSync(script, "process.exit(3);\n");
    const r = await checkServerStarts({ entry: script, timeoutMs: 8_000, execArgv: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  test("the built CLI starts, lists its tools and answers purix_status, and leaves the project untouched", async () => {
    const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "cli.js");
    if (!existsSync(entry)) return; // needs the build, like mcp_stdout_purity.test.ts
    const before = readdirSync(cwd);
    const r = await checkServerStarts({ entry, execArgv: [] });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.tools).toBeGreaterThan(10);
    expect(readdirSync(cwd)).toEqual(before);
  });
});

describe("server check and the person's own user folder", () => {
  test("the check does not write into the user folder the person has configured", async () => {
    const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "cli.js");
    if (!existsSync(entry)) return; // needs the build
    const userDir = mkdtempSync(join(tmpdir(), "purix-extras-user-"));
    const saved = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    try {
      const r = await checkServerStarts({ entry, execArgv: [] });
      expect(r).toMatchObject({ ok: true });
      expect(readdirSync(userDir)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.PURIX_USER_DIR;
      else process.env.PURIX_USER_DIR = saved;
      safeRmSync(userDir);
    }
  });
});

describe("canPrompt", () => {
  test("needs two terminals and no CI", () => {
    expect(canPrompt({}, true, true)).toBe(true);
    expect(canPrompt({}, true, false)).toBe(false);
    expect(canPrompt({}, false, true)).toBe(false);
    expect(canPrompt({}, undefined, undefined)).toBe(false);
    expect(canPrompt({ CI: "true" }, true, true)).toBe(false);
  });
});

describe("hook offer (the prompt a person answers at a terminal)", () => {
  function make(over: Partial<HookOfferDeps> = {}) {
    const lines: string[] = [];
    const asked: string[] = [];
    const installed: string[] = [];
    const deps: HookOfferDeps = {
      cwd: "/proj",
      connected: ["claude-code"],
      flag: undefined,
      interactive: true,
      ask: (q) => {
        asked.push(q);
        return Promise.resolve(true);
      },
      print: (l) => lines.push(l),
      install: (agent) => {
        installed.push(agent);
        return Promise.resolve({ ok: true as const, path: `/proj/${agent}.json` });
      },
      ...over,
    };
    return { deps, lines, asked, installed };
  }

  test("at a terminal, with no flag, it asks once, names the agent, and installs on yes", async () => {
    const m = make();
    const r = await offerHooks(m.deps);
    expect(m.asked.length).toBe(1);
    expect(m.asked[0]).toContain("claude-code");
    expect(m.installed).toEqual(["claude-code"]);
    expect(r).toEqual({ failed: 0, installed: ["claude-code"] });
    expect(m.lines.join("\n")).toContain("Without hooks, Purix only advises");
  });

  test("at a terminal, answering no installs nothing and says how to do it later", async () => {
    const m = make({ ask: () => Promise.resolve(false) });
    const r = await offerHooks(m.deps);
    expect(m.installed).toEqual([]);
    expect(r.installed).toEqual([]);
    expect(m.lines.join("\n")).toContain("purix hooks install");
  });

  test("with no terminal (script, pipe or CI) it never asks and installs nothing", async () => {
    const m = make({ interactive: false, ask: () => Promise.reject(new Error("must not ask")) });
    const r = await offerHooks(m.deps);
    expect(m.installed).toEqual([]);
    expect(r.failed).toBe(0);
    expect(m.lines.join("\n")).toContain("Hooks are not installed");
  });

  test("--hooks installs without asking, even with no terminal", async () => {
    const m = make({ flag: true, interactive: false, ask: () => Promise.reject(new Error("must not ask")) });
    await offerHooks(m.deps);
    expect(m.installed).toEqual(["claude-code"]);
  });

  test("--no-hooks neither asks nor prints anything", async () => {
    const m = make({ flag: false, ask: () => Promise.reject(new Error("must not ask")) });
    const r = await offerHooks(m.deps);
    expect(m.installed).toEqual([]);
    expect(m.lines).toEqual([]);
    expect(r).toEqual({ failed: 0, installed: [] });
  });

  test("an agent with no hook installer is not offered one", async () => {
    const m = make({ connected: ["windsurf"], ask: () => Promise.reject(new Error("must not ask")) });
    const r = await offerHooks(m.deps);
    expect(m.lines).toEqual([]);
    expect(r.installed).toEqual([]);
  });

  test("two agents are asked about once, together, and each is installed", async () => {
    const m = make({ connected: ["claude-code", "cursor"] });
    await offerHooks(m.deps);
    expect(m.asked.length).toBe(1);
    expect(m.asked[0]).toContain("claude-code, cursor");
    expect(m.installed).toEqual(["claude-code", "cursor"]);
  });

  test("two connect ids that share a hook agent are installed once", async () => {
    const m = make({ connected: ["gemini-cli", "gemini-cli"], flag: true });
    await offerHooks(m.deps);
    expect(m.installed).toEqual(["gemini"]);
  });

  test("a failed install is counted and reported, and the next agent is still tried", async () => {
    const m = make({
      connected: ["claude-code", "cursor"],
      flag: true,
      install: (agent) => Promise.resolve(agent === "claude-code" ? { ok: false as const, error: "read-only folder" } : { ok: true as const, path: "/proj/cursor.json" }),
    });
    const r = await offerHooks(m.deps);
    expect(r.failed).toBe(1);
    expect(r.installed).toEqual(["cursor"]);
    expect(m.lines.join("\n")).toContain("Could not install the claude-code hook: read-only folder");
  });
});
