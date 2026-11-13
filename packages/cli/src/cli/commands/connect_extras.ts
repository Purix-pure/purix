// packages/cli/src/cli/commands/connect_extras.ts
//
// The parts of `purix connect` beyond writing the agent's MCP config (C-11):
//  - the short instruction block that tells the agent when to call Purix,
//  - a check that Purix's server starts on this machine and answers a call,
//  - whether the `purix` command the agent will launch is on PATH,
//  - which hook agent a connect id corresponds to.
// IDEA-090 was not available when this was written; only the gaps named in PURIX-25 section 5 are covered.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const BLOCK_BEGIN = "<!-- purix:begin (written by `purix connect`; your own text outside these markers is never touched) -->";
export const BLOCK_END = "<!-- purix:end -->";

export const INSTRUCTION_BODY = [
  "## Purix",
  "",
  "Purix checks and records changes to tracked code. Use it instead of editing tracked files directly.",
  "",
  "- To change tracked code, call `purix_change` (plain-language intent) or `purix_modify` (known component id).",
  "- `purix_status` lists tracked components; `purix_find` locates one.",
  "- If a call returns a request id, a person must approve it: tell them to run `purix approve <id>` in their own terminal, then check `purix_approval_status`. You cannot approve it yourself, so do not retry in a loop.",
  "- A Purix result says what it covered. A pass means those checks passed; it does not mean the code is correct or safe.",
].join("\n");

const BLOCK = `${BLOCK_BEGIN}\n${INSTRUCTION_BODY}\n${BLOCK_END}\n`;

/** Where each agent reads standing instructions. Anything not listed reads AGENTS.md. */
const INSTRUCTION_FILE: Record<string, { path: string; ownsFile: boolean }> = {
  "claude-code": { path: "CLAUDE.md", ownsFile: false },
  "gemini-cli": { path: "GEMINI.md", ownsFile: false },
  cursor: { path: join(".cursor", "rules", "purix.mdc"), ownsFile: true },
};

export function instructionFileFor(agentId: string): { path: string; ownsFile: boolean } {
  return INSTRUCTION_FILE[agentId] ?? { path: "AGENTS.md", ownsFile: false };
}

const CURSOR_FRONTMATTER = "---\ndescription: How to use Purix in this project\nalwaysApply: true\n---\n\n";

export interface InstructionResult {
  path: string;
  changed: boolean;
  /** Why nothing was written, when changed is false and it is not simply up to date. */
  skipped?: string;
}

/**
 * Writes the block between markers. Idempotent: a second run changes nothing. Text outside the markers is never touched.
 * A file Purix would own (Cursor's rule file) that already exists without our markers is left alone.
 */
export function writeInstructionBlock(cwd: string, agentId: string): InstructionResult {
  const target = instructionFileFor(agentId);
  const abs = join(cwd, target.path);
  const existing = existsSync(abs) ? readFileSync(abs, "utf-8") : null;

  let next: string;
  if (existing === null) {
    next = (target.ownsFile ? CURSOR_FRONTMATTER : "") + BLOCK;
  } else if (existing.includes(BLOCK_BEGIN)) {
    const start = existing.indexOf(BLOCK_BEGIN);
    const endAt = existing.indexOf(BLOCK_END, start);
    if (endAt === -1) return { path: target.path, changed: false, skipped: "the Purix block in this file has no end marker, so it was left alone" };
    next = existing.slice(0, start) + BLOCK.trimEnd() + existing.slice(endAt + BLOCK_END.length);
    if (!next.endsWith("\n")) next += "\n";
  } else if (target.ownsFile) {
    return { path: target.path, changed: false, skipped: "a file with this name exists and was not written by Purix" };
  } else {
    next = existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + (existing === "" ? "" : "\n") + BLOCK;
  }

  if (next === existing) return { path: target.path, changed: false };
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next);
  return { path: target.path, changed: true };
}

/** `purix connect` ids that have a hook installer, mapped to the hook agent name. */
const HOOK_AGENT_FOR: Record<string, string> = {
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  "gemini-cli": "gemini",
  antigravity: "antigravity",
  opencode: "opencode",
};

export function hookAgentFor(connectId: string): string | undefined {
  return HOOK_AGENT_FOR[connectId];
}

/** True when `name` resolves to a file on PATH (with PATHEXT on Windows). */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  return dirs.some((d) => exts.some((e) => existsSync(join(d, name + e))));
}

/**
 * True only when a person can answer a question: both ends are terminals and this is not CI. `CI` is checked because some CI
 * systems allocate a pseudo-terminal; a prompt there would hang the job until it times out.
 */
export function canPrompt(env: NodeJS.ProcessEnv = process.env, stdinIsTTY: boolean | undefined = process.stdin.isTTY, stdoutIsTTY: boolean | undefined = process.stdout.isTTY): boolean {
  return Boolean(stdinIsTTY && stdoutIsTTY) && !env.CI;
}

export interface HookOfferDeps {
  cwd: string;
  /** `purix connect` ids that were connected in this run. */
  connected: readonly string[];
  /** true = `--hooks`, false = `--no-hooks`, undefined = ask if a person can answer. */
  flag: boolean | undefined;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  /** Installs one hook agent. Injected so tests never write real agent config. */
  install: (hookAgent: string, cwd: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
}

/**
 * Hooks are what make Purix enforce rather than advise, so connect offers them. Never installed silently: with neither flag,
 * only a person at a terminal is asked, the default is no, and a script or CI run never gets a prompt.
 * Returns the number of installs that failed (the caller turns that into a non-zero exit code).
 */
export async function offerHooks(deps: HookOfferDeps): Promise<{ failed: number; installed: string[] }> {
  if (deps.flag === false) return { failed: 0, installed: [] };
  const hookAgents = [...new Set(deps.connected.map((t) => hookAgentFor(t)).filter((h): h is string => h !== undefined))];
  if (hookAgents.length === 0) return { failed: 0, installed: [] };

  let install = deps.flag === true;
  if (!install && deps.interactive) {
    deps.print("\nWithout hooks, Purix only advises: an agent that edits a tracked file directly is not stopped.");
    install = await deps.ask(`Install the Purix hook for ${hookAgents.join(", ")} now (blocks direct edits to tracked files)?`);
  }
  if (!install) {
    deps.print("\nHooks are not installed. To block direct edits to tracked files later: purix hooks install");
    return { failed: 0, installed: [] };
  }

  let failed = 0;
  const installed: string[] = [];
  for (const agent of hookAgents) {
    const res = await deps.install(agent, deps.cwd);
    if (res.ok) {
      installed.push(agent);
      deps.print(`✅ Installed the ${agent} hook — ${res.path}. Restart the agent; see docs/HOOKS.md for any trust step it needs.`);
    } else {
      failed += 1;
      deps.print(`❌ Could not install the ${agent} hook: ${res.error}`);
    }
  }
  return { failed, installed };
}

export type ServerCheck ={ ok: true; tools: number } | { ok: false; reason: string };

/**
 * Starts the Purix server that is running this command (same node, same entry file) in an empty temporary folder, so
 * nothing is created in the project, and calls one read-only tool. This shows Purix itself works on this machine. It does
 * not show the coding agent has loaded the config; the agent has to be restarted for that.
 */
export async function checkServerStarts(opts: { timeoutMs?: number; execPath?: string; entry?: string; execArgv?: string[] } = {}): Promise<ServerCheck> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const entry = opts.entry ?? process.argv[1];
  if (!entry) return { ok: false, reason: "could not tell which file is running this command" };
  const scratch = mkdtempSync(join(tmpdir(), "purix-connect-check-"));
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const transport = new StdioClientTransport({
    command: opts.execPath ?? process.execPath,
    args: [...(opts.execArgv ?? process.execArgv), entry, "mcp-serve"],
    cwd: scratch,
    // PURIX_USER_DIR points into the scratch folder so this check leaves the person's own ~/.purix alone: without it the
    // child server records a usage row there (found by running `connect` with an empty HOME), which breaks C-22's rule that
    // setup commands leave HOME untouched. The scratch folder is deleted below.
    env: { ...(process.env as Record<string, string>), PURIX_MCP_AGENT_ID: "connect-check", PURIX_USER_DIR: join(scratch, "user") },
    stderr: "ignore",
  });
  const client = new Client({ name: "purix-connect-check", version: "0" }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async (): Promise<ServerCheck> => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const res = (await client.callTool({ name: "purix_status", arguments: {} })) as { isError?: boolean };
      if (res.isError) return { ok: false, reason: "purix_status returned an error" };
      return { ok: true, tools: tools.length };
    })();
    const timeout = new Promise<ServerCheck>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: `no answer within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
    });
    return await Promise.race([run, timeout]);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
