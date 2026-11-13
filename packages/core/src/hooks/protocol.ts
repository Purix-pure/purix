// src/hooks/protocol.ts
//
// Reading what an agent's hook sends us, and answering in the form that agent understands (ADR-064: one canonical
// check, thin adapters; PURIX-21 section 5.0: hooks enforce, MCP is the interface).
//
// Two agents are supported: Claude Code and Cursor. Their payloads differ, so each is turned into one NormalizedCall and
// the decision (decide.ts) never sees an agent-specific shape.
//
// Fail-closed rule for this file: a payload that cannot be read is NOT treated as "nothing to check". The caller turns
// an unreadable pre-tool payload into a deny. (A Stop payload that cannot be read is allowed, so a parsing bug can never
// trap an agent in a loop.)
//
// What is verified and what is not (state it, do not imply it): the Claude Code shapes follow Anthropic's hooks
// reference (PreToolUse, tool_input.file_path, exit code 2 blocks and shows stderr to the model). The Cursor shapes
// follow Cursor's hooks documentation as quoted by third parties (hooks.json version 1, preToolUse and
// beforeShellExecution, permission allow/deny/ask, failClosed). Neither has been run against a real client in this
// session. Cursor's tool_input key for a file path is not pinned down in the sources read, so every plausible key is
// accepted and a write-class tool with NO readable path is denied, not allowed.

export type HookAgent = "claude-code" | "cursor" | "codex" | "gemini" | "antigravity" | "opencode";
export type HookEvent = "pre-tool-use" | "stop";

export const HOOK_AGENTS: readonly HookAgent[] = ["claude-code", "cursor", "codex", "gemini", "antigravity", "opencode"];

/**
 * How an agent wants to be told "no". One engine, three answer styles (PURIX-23 section 2.3):
 *  - exit2: exit code 2 with the reason on stderr (Claude Code, Codex, and the OpenCode plugin shim, which reads the code).
 *  - cursor: a permission:deny JSON body plus exit 2.
 *  - decision-json: {"decision":"deny","reason":...} on stdout with exit 0 (Gemini CLI, Antigravity). These two also want an
 *    explicit {"decision":"allow"}: Antigravity is reported to fail closed on a missing decision, and its own approval
 *    prompt still runs after an allow, so the line grants nothing.
 */
export type AnswerStyle = "exit2" | "cursor" | "decision-json";
export const ANSWER_STYLE: Readonly<Record<HookAgent, AnswerStyle>> = {
  "claude-code": "exit2",
  codex: "exit2",
  opencode: "exit2",
  cursor: "cursor",
  gemini: "decision-json",
  antigravity: "decision-json",
};
export const HOOK_EVENTS: readonly HookEvent[] = ["pre-tool-use", "stop"];

export type ToolClass = "write" | "shell" | "other";

export interface NormalizedCall {
  agent: HookAgent;
  event: HookEvent;
  /** The agent's own tool name, as sent. */
  tool: string;
  toolClass: ToolClass;
  /** Working directory the agent reports, when it reports one. */
  cwd: string | null;
  /** Workspace roots the agent reports (Cursor), first one is the project. */
  roots: string[];
  /** Every file path the call would write, as sent (not yet resolved). Empty for non-write tools. */
  paths: string[];
  /** Shell command text for shell tools, else null. */
  command: string | null;
  /** True when the agent says it is already continuing because of a Stop hook (loop guard). */
  stopHookActive: boolean;
}

export type ParseResult = { ok: true; call: NormalizedCall } | { ok: false; reason: string };

/** Tool names that write files. Lower-case, compared case-insensitively. Anything not listed here or in SHELL_TOOLS is "other". */
const WRITE_TOOLS = new Set([
  "edit", "write", "multiedit", "notebookedit", // Claude Code
  "strreplace", "str_replace", "delete", "editnotebook", "applypatch", "apply_patch", "multi_edit", "search_replace", "edit_file", "write_file", "delete_file", // Cursor and common variants
  "replace", // Gemini CLI's edit tool (its write_file is listed above)
  "patch", "create_file", "write_to_file", "replace_file_content", "multi_replace_file_content", // OpenCode / Antigravity: names from memory or one source, NOT confirmed against a real client
]);
const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_cmd", "run_terminal_command", "powershell", "terminal", "run_shell_command", "run_command"]);

/** Keys that carry a file path in a tool_input object. */
const PATH_KEYS = new Set([
  "file_path", "filepath", "path", "notebook_path", "target_file", "targetfile", "file", "filename", "target_notebook", "absolutepath",
  // Move, copy and rename tools name two paths. Both are written (the source of a move disappears).
  "source", "destination", "src", "dest", "old_path", "new_path", "oldpath", "newpath", "old_file_path", "new_file_path", "from_path", "to_path",
]);
/** Keys whose value is a list of paths (a batch writer). */
const PATH_LIST_KEYS = new Set(["paths", "files", "file_paths", "filepaths"]);
/** Keys that carry shell text in a tool the hook does not know by name (an MCP command runner). */
const SHELL_SHAPE_KEYS = ["command", "cmd", "commandline", "script"];
/** Keys that carry the command text of a shell tool, compared in lower case (Antigravity sends PascalCase: CommandLine). */
const COMMAND_KEYS = ["command", "commandline"];

export function classifyTool(name: string): ToolClass {
  const n = name.trim().toLowerCase();
  if (WRITE_TOOLS.has(n)) return "write";
  if (SHELL_TOOLS.has(n)) return "shell";
  return "other";
}

/** Words that, in a tool's name, say it only looks. Compared as whole words of the name (split on _, -, spaces and camelCase). */
const READ_WORDS = new Set(["read", "view", "get", "list", "ls", "glob", "grep", "search", "find", "cat", "open", "stat", "head", "tail", "show", "fetch", "query", "lookup", "describe", "diff", "status", "log", "inspect", "peek", "tree", "exists", "check"]);
/** Words that say it changes something. A name with one of these is never "read-like", even if it also says "get" (get_or_create). */
const WRITE_WORDS = new Set(["write", "edit", "create", "delete", "remove", "move", "rename", "copy", "patch", "replace", "append", "save", "put", "update", "set", "apply", "insert", "modify", "touch", "mkdir", "rm", "mv", "cp", "truncate", "overwrite", "upload", "store", "add", "make", "new", "clear", "reset", "revert", "restore", "format", "fix", "install", "generate", "execute", "exec", "run"]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when the tool's NAME says it only reads (Read, Glob, Grep, LS, mcp__fs__read_file, get_file_contents). Used only to let a
 * tool with a path in its input through: it is never used to decide a call is safe when the name also has a write word.
 */
export function isReadLikeTool(name: string): boolean {
  const words = nameWords(name);
  return words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w));
}

/**
 * Purix's own MCP tools (purix_change, purix_index, ...) are the governed route. Several take a path (purix_index) and must never
 * be blocked by the rule that treats an unknown tool with a path as a write. A name match only: it is not an identity check, and
 * a tool called "purix_x" in another server gets the same pass. The decision is therefore limited to the path-shape rule; the
 * file-tool and shell rules still apply to anything classed write or shell by name.
 */
export function isPurixTool(name: string): boolean {
  return /(^|[_.\s-])purix[_-]/i.test(name);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collectPaths(input: unknown, out: string[]): void {
  if (!isObject(input)) return;
  for (const [k, v] of Object.entries(input)) {
    if (PATH_KEYS.has(k.toLowerCase()) && typeof v === "string" && v.length > 0) out.push(v);
  }
  for (const [k, v] of Object.entries(input)) {
    if (PATH_LIST_KEYS.has(k.toLowerCase()) && Array.isArray(v)) for (const item of v) if (typeof item === "string" && item.length > 0) out.push(item);
  }
  // MultiEdit-style: edits[] each may name a file.
  const edits = input["edits"];
  if (Array.isArray(edits)) for (const e of edits) collectPaths(e, out);
  // ApplyPatch-style: a unified patch names its files in the text. Names are read, never executed.
  // Codex sends an apply_patch call's whole patch text as tool_input.command.
  const patch = input["patch"] ?? input["input"] ?? input["diff"] ?? input["command"];
  if (typeof patch === "string") {
    for (const m of patch.matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File:|\*\*\* Move to:|\+\+\+ b\/|--- a\/|\+\+\+ |--- )\s*(\S+)/gm)) {
      if (m[1] && m[1] !== "/dev/null") out.push(m[1]);
    }
  }
}

export function parseHookPayload(agent: HookAgent, event: HookEvent, raw: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `the hook payload is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isObject(body)) return { ok: false, reason: "the hook payload is not a JSON object" };

  const cwd = typeof body["cwd"] === "string" && body["cwd"] ? body["cwd"] : null;
  // Cursor sends workspace_roots; Antigravity sends workspacePaths (protojson, camelCase).
  const rootsRaw = body["workspace_roots"] ?? body["workspacePaths"];
  const roots = Array.isArray(rootsRaw) ? rootsRaw.filter((r): r is string => typeof r === "string" && r.length > 0) : [];
  const stopHookActive = body["stop_hook_active"] === true;

  if (event === "stop") {
    return { ok: true, call: { agent, event, tool: "stop", toolClass: "other", cwd, roots, paths: [], command: null, stopHookActive } };
  }

  // Cursor's beforeShellExecution carries the command at top level and no tool_name.
  const topCommand = typeof body["command"] === "string" ? body["command"] : null;
  // Antigravity nests the call: toolCall: { name, args }.
  const toolCall = isObject(body["toolCall"]) ? body["toolCall"] : null;
  const named = body["tool_name"] ?? toolCall?.["name"];
  const tool = typeof named === "string" && named ? named : topCommand !== null ? "Shell" : "";
  if (!tool) return { ok: false, reason: "the hook payload names no tool (no tool_name and no command)" };

  let toolClass = classifyTool(tool);
  const input = body["tool_input"] ?? toolCall?.["args"];
  const paths: string[] = [];
  let command: string | null = null;
  if (toolClass === "other" && !isPurixTool(tool) && !isReadLikeTool(tool)) {
    // A tool the hook does not know by name (FileWrite, mcp__filesystem__write_file, a new agent's editor) is told apart by what
    // its input carries: a path means it writes a file; shell text means it runs a command. Name alone let both through.
    if (isObject(input)) {
      collectPaths(input, paths);
      const shellKey = Object.keys(input).find((k) => SHELL_SHAPE_KEYS.includes(k.toLowerCase()) && typeof input[k] === "string");
      if (paths.length > 0) toolClass = "write";
      else if (shellKey !== undefined) {
        toolClass = "shell";
        command = input[shellKey] as string;
      }
    }
  } else if (toolClass === "write") {
    collectPaths(input, paths);
  }
  if (toolClass === "shell" && command === null) {
    command = topCommand;
    if (isObject(input)) {
      for (const [k, v] of Object.entries(input)) if (COMMAND_KEYS.includes(k.toLowerCase()) && typeof v === "string") command = v;
    }
  }

  return { ok: true, call: { agent, event, tool, toolClass, cwd, roots, paths: [...new Set(paths)], command, stopHookActive } };
}

export interface HookAnswer {
  /** 0 = no objection from Purix; 2 = block (the only code Claude Code treats as "block"). */
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

/**
 * "No objection". For exit2 and cursor agents this is silence: an explicit allow can act as a grant in Cursor, and Codex only
 * accepts an allow that carries an input rewrite. Decision-json agents get an explicit allow, which grants nothing there.
 */
export function allowAnswer(agent?: HookAgent): HookAnswer {
  if (agent !== undefined && ANSWER_STYLE[agent] === "decision-json") return { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

export function denyAnswer(agent: HookAgent, reason: string): HookAnswer {
  const text = `Purix blocked this: ${reason}`;
  const style = ANSWER_STYLE[agent];
  if (style === "cursor") {
    // JSON for clients that read it, exit code 2 for clients that only honour the exit code. Either one denies.
    return { exitCode: 2, stdout: JSON.stringify({ permission: "deny", user_message: text, agent_message: text }), stderr: text };
  }
  if (style === "decision-json") {
    // The documented block for these agents is JSON on stdout with exit 0 (stdout must hold only that JSON).
    return { exitCode: 0, stdout: JSON.stringify({ decision: "deny", reason: text }), stderr: "" };
  }
  // exit2: exit 2 blocks a PreToolUse call and shows stderr to the model. JSON is parsed only on exit 0, so none is sent.
  return { exitCode: 2, stdout: "", stderr: text };
}
