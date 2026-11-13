// src/hooks/decide.ts
//
// The decision itself: pure, no model, no network, no state writes. Given what the agent is about to do and what Purix
// governs, answer allow or deny and say why in one sentence an agent (and a person) can act on.
//
// What this enforces, and what it does not (these limits are also written in docs/HOOKS.md and must stay in step):
//  - An edit made with the agent's own file tools (Edit, Write, MultiEdit, NotebookEdit, Cursor's StrReplace/Delete/...)
//    to a file Purix governs is DENIED. Purix itself never writes through the agent's tools, so an agent edit to a
//    governed file is by definition a path around Purix.
//  - Purix's own state, the committed lock, and the hook configuration are DENIED to every write tool and write-like shell
//    command, so the agent cannot switch the hook off by editing its config.
//  - A shell command is screened as a TRIPWIRE, not a wall (A9-1, research 09). The whole command text is read: a redirect, a
//    write verb, or ANY mention of a governed or protected path in a command that is not on a short read-only list is denied.
//    Variables set earlier in the command, `cd`, braces and `~` are resolved first. It still cannot see a script file written
//    and run later, `npm run <script>`, an encoded string piped to a shell, or a formatter run over a folder without naming a
//    governed file. The Stop-time drift check (run.ts) is the backstop for those, and it reports; it cannot prevent.
//  - Commands that start with `purix` (or `pnpm exec purix` and the like) are left alone: that is the governed route. A package
//    runner in front (the repo's tool-boundary rule bans naming one outside tools/) is screened like any other command, so only a
//    write-capable word together with a governed path blocks it.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeRepoPath } from "../gates/path_normalize.js";
import { CHECKER_NAMES, PACKAGE_RUNNER_NAMES } from "../tools/shell_screen_names.js";
import { isPurixTool, isReadLikeTool, type NormalizedCall } from "./protocol.js";

export interface GovernedContext {
  /** Absolute project root. */
  projectRoot: string;
  /** Project-relative POSIX path -> component id. */
  governed: ReadonlyMap<string, string>;
  /** Project-relative POSIX files no write tool may touch (lock, hook configs). */
  protectedFiles: ReadonlySet<string>;
  /** Absolute directories and files no write tool may touch (Purix state, user-level hook configs). May be outside the project. */
  protectedAbsolute: readonly string[];
  /**
   * "ok": the store was read. "absent": no store and no lock, so nothing is governed. "damaged": a store exists but could
   * not be read, so the governed list may be incomplete (the lock, if any, is still used).
   */
  state: "ok" | "absent" | "damaged";
  /** True when the committed lock supplied the governed list (used when the store is unreadable). */
  lockUsed: boolean;
  /** Compare paths case-insensitively (Windows, macOS). */
  caseInsensitive: boolean;
}

export type HookRule = "governed-file" | "protected-file" | "state-unreadable" | "no-path" | "shell-write" | "human-only" | "allow";

export interface HookDecision {
  action: "allow" | "deny";
  rule: HookRule;
  reason: string;
  /** Project-relative (or absolute, when outside) paths that triggered the decision. */
  targets: string[];
  /**
   * C5 (decision 3 of 2026-11-08): on an allow of a write tool, the project files in the call that Purix does not govern. The write is not
   * blocked; the caller names these in its answer, records them, and `purix check` lists them. Absent when none, when the project governs
   * nothing, and for shell commands (a text screen cannot tell what a command writes).
   */
  unadopted?: string[];
}

// C5: folders whose files are dependencies or build output, not work a person adopts. A write there is not named.
const UNTRACKED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "__pycache__", ".venv", "venv", "target"]);
function inUntrackedDir(rel: string): boolean {
  return rel.split("/").slice(0, -1).some((seg) => UNTRACKED_DIRS.has(seg));
}

const ALLOW: HookDecision = { action: "allow", rule: "allow", reason: "", targets: [] };

/** The one comparison form (gates/path_normalize.ts): slashes, "." and ".." segments, and case when the disk folds it. */
function key(ctx: GovernedContext, s: string): string {
  return normalizeRepoPath(s, { foldCase: ctx.caseInsensitive });
}

function stripWindowsPrefix(p: string): string {
  return p.startsWith("\\\\?\\") ? p.slice(4) : p;
}

/** realpath of the deepest ancestor that exists, with the missing tail re-attached. Defeats a symlink that points at a governed file. */
export function canonicalize(abs: string): string {
  let probe = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64 && !existsSync(probe); i++) {
    const parent = dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(probe.slice(parent.length).replace(/^[\\/]+/, ""));
    probe = parent;
  }
  try {
    const real = realpathSync(probe);
    return tail.length ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

interface Resolved {
  abs: string;
  /** POSIX path relative to the project root; null when outside it. */
  rel: string | null;
}

function resolveTarget(ctx: GovernedContext, cwd: string, raw: string): Resolved {
  // A backslash is a separator: a Windows-style path from an agent on any platform must resolve to the same file.
  const cleaned = stripWindowsPrefix(raw.trim().replace(/^["']|["']$/g, "")).replace(/\\/g, "/");
  const abs = canonicalize(resolve(isAbsolute(cleaned) ? cleaned : join(cwd, cleaned)));
  const root = canonicalize(ctx.projectRoot);
  const r = relative(root, abs);
  if (r === "" ) return { abs, rel: "" };
  if (r.startsWith("..") || isAbsolute(r)) return { abs, rel: null };
  return { abs, rel: toPosix(r) };
}

/**
 * True when comparison key `a` is `p` or inside it. Both are in the one comparison form (gates/path_normalize.ts), which always uses
 * "/", so the test must use "/" too: the platform separator is "\\" on Windows and never matches, which let a write tool create
 * files inside Purix's own state folder (found in the first live OpenCode run on Windows).
 */
export function isKeyUnder(a: string, p: string): boolean {
  return a === p || a.startsWith(p.endsWith("/") ? p : p + "/");
}

function isUnder(ctx: GovernedContext, abs: string, protectedAbs: string): boolean {
  return isKeyUnder(key(ctx, canonicalize(abs)), key(ctx, canonicalize(protectedAbs)));
}

/** Why this resolved path may not be written, or null when it may. */
function whyBlocked(ctx: GovernedContext, t: Resolved, dirHits = true): { rule: HookRule; reason: string; target: string } | null {
  for (const p of ctx.protectedAbsolute) {
    if (isUnder(ctx, t.abs, p)) {
      return { rule: "protected-file", target: t.rel ?? t.abs, reason: `${t.rel ?? t.abs} is part of Purix's own state or the hook setup that enforces it. An agent may not change it; ask the person to.` };
    }
  }
  if (t.rel === null) return null;
  const rel = key(ctx, t.rel);
  for (const f of ctx.protectedFiles) {
    if (key(ctx, f) === rel) {
      return { rule: "protected-file", target: t.rel, reason: `${t.rel} is part of Purix's own state or the hook setup that enforces it. An agent may not change it; ask the person to.` };
    }
  }
  for (const [file, component] of ctx.governed) {
    const f = foldCase(ctx, file); // governed paths are stored clean (posix, no "./"), so folding is enough and 50,000 of them stay cheap
    // The target is the governed file itself, or a directory that contains governed files (a delete of the folder).
    if (f === rel || (dirHits && ((rel !== "" && f.startsWith(rel + "/")) || rel === ""))) {
      return {
        rule: "governed-file",
        target: file,
        reason: `${file} is governed by Purix (component "${component}"). Change it through Purix (the purix_change MCP tool, or \`purix change\` in a terminal) so the change is checked and recorded. Direct edits are not allowed.`,
      };
    }
  }
  return null;
}

/** First word of a shell segment, ignoring leading VAR=value assignments. */
function leadWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  return words;
}

function isPurixInvocation(words: string[]): boolean {
  const w = words.map((x) => x.toLowerCase().replace(/^["']|["']$/g, ""));
  const base = (s: string | undefined) => (s ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (["purix", "purix.cmd", "purix.exe", "purix.ps1"].includes(base(w[0]))) return true;
  if (["pnpm", "npm", "yarn", "bun"].includes(base(w[0])) && (w[1] === "exec" || w[1] === "dlx") && base(w[2]) === "purix") return true;
  return false;
}

/**
 * The subcommand after `purix` (or after `pnpm exec purix` and the like), skipping flags. `purix approve` and `purix deny`
 * answer an agent's own pending request, so an agent must never run them (C-30). `purix approve` also refuses without a
 * terminal; this stops an agent that does have one.
 */
function purixSubcommand(words: string[]): string | null {
  const w = words.map((x) => x.toLowerCase().replace(/^["']|["']$/g, ""));
  const base = (x: string | undefined) => (x ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const start = ["pnpm", "npm", "yarn", "bun"].includes(base(w[0])) ? 3 : 1;
  for (let i = start; i < w.length; i++) {
    if (w[i]!.startsWith("-")) continue;
    return w[i]!;
  }
  return null;
}

const WRITE_VERBS = new RegExp(
  "(?:^|[\\s;&|(`])(?:rm|rmdir|mv|cp|ln|touch|truncate|dd|install|chmod|chown|tee|sed|perl|awk|gawk|ed|ex|vi|vim|nano|emacs|patch|rsync|unlink|shred|" +
    "del|erase|ren|rename|move|copy|xcopy|robocopy|rd|" +
    "set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|clear-content|rename-item|ni|sc|ac|" +
    "git\\s+(?:checkout|restore|reset|stash|clean|apply|am|rebase|merge|cherry-pick|revert|pull|switch|rm|mv))(?=$|[\\s;&|)`])",
  "i"
);
const INTERPRETER_CODE = /(?:^|[\s;&|(])(?:python3?|py|node|nodejs|deno|bun|ruby|perl|php|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-[A-Za-z]*[ceCE][A-Za-z]*|-command|-encodedcommand|\/c|<<)/i;
const REDIRECT_TARGET = /\d*>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>;&|()]+))/g;

function globToRegExp(token: string): RegExp {
  const esc = token.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${esc}$`, "i");
}

function hasGlob(token: string): boolean {
  return /[*?[]/.test(token);
}

/** A glob names every file it could expand to: test it against every governed and protected path. */
function globHit(ctx: GovernedContext, cwd: string, token: string): HookDecision | null {
  const rx = globToRegExp(toPosix(relative(ctx.projectRoot, resolve(cwd, token))) || token);
  for (const [file, component] of ctx.governed) {
    if (rx.test(file)) return { action: "deny", rule: "shell-write", reason: `this command could change ${file}, which Purix governs (component "${component}"). Use \`purix change\`, or the purix_change MCP tool, instead.`, targets: [file] };
  }
  for (const f of ctx.protectedFiles) {
    if (rx.test(f)) return { action: "deny", rule: "protected-file", reason: `this command could change ${f}, which is part of Purix's own state or hook setup.`, targets: [f] };
  }
  return null;
}

// ---------- A9-1: reading the whole command ----------

interface Segment {
  /** The command line text (quotes kept). */
  head: string;
  /** Heredoc bodies that belong to this command (text fed to it, which for an interpreter is code). */
  body: string;
}

/**
 * Splits a shell command into simple commands at ; && || | & and newlines that are not inside quotes, and keeps a heredoc's body
 * with the command that receives it. It is a text splitter, not a shell parser: `$( )` and backticks stay inside their segment, and
 * a backslash is not treated as an escape (it is a path separator on Windows). Where it is wrong it is wrong toward more text per
 * segment, which only makes the later scan see more.
 */
function splitCommand(command: string): Segment[] {
  const out: Segment[] = [];
  let head = "";
  let body = "";
  let quote: '"' | "'" | null = null;
  const pending: { tag: string; dash: boolean }[] = [];
  const n = command.length;
  const push = () => {
    if (head.trim() !== "" || body.trim() !== "") out.push({ head: head.trim(), body });
    head = "";
    body = "";
  };
  for (let i = 0; i < n; i++) {
    const c = command[i]!;
    if (quote !== null) {
      head += c;
      if (c === quote && !(quote === '"' && command[i - 1] === "\\")) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      head += c;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(["']?)([A-Za-z_][\w-]*)\2/.exec(command.slice(i, i + 200));
      if (m) {
        pending.push({ tag: m[3]!, dash: m[1] === "-" });
        head += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\r") continue;
    if (c === "\n") {
      if (pending.length > 0) {
        let j = i + 1;
        for (const t of pending) {
          while (j < n) {
            let k = command.indexOf("\n", j);
            if (k === -1) k = n;
            const line = command.slice(j, k).replace(/\r$/, "");
            j = k + 1;
            if ((t.dash ? line.trim() : line) === t.tag) break;
            body += line + "\n";
          }
        }
        pending.length = 0;
        i = j - 1;
      }
      push();
      continue;
    }
    if (c === ";") {
      push();
      continue;
    }
    if (c === "&") {
      // `2>&1`, `>&2` and `&>file` are redirections, not command separators.
      if (head.endsWith(">") || head.endsWith("<") || command[i + 1] === ">") {
        head += c;
        continue;
      }
      if (command[i + 1] === "&") i++;
      push();
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") i++;
      push();
      continue;
    }
    head += c;
  }
  push();
  return out;
}

/** `NAME=value`, `export NAME=value`, `declare/local NAME=value`, `set NAME=value` (cmd), `$NAME = 'value'` and `$env:NAME = 'value'` (PowerShell). */
function parseAssignment(head: string): { name: string; value: string } | null {
  // The value is ONE shell word and nothing follows it: `FOO=1 purix approve` is a command with an environment prefix, not an assignment.
  const posix = /^(?:(?:export|declare|local|readonly|typeset|set)\s+)?([A-Za-z_][A-Za-z0-9_]*)=((?:"[^"]*"|'[^']*'|[^\s"'])*)\s*$/.exec(head);
  if (posix) return { name: posix[1]!, value: posix[2]!.replace(/^["']|["']$/g, "") };
  const ps = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/s.exec(head);
  return ps ? { name: ps[1]!, value: ps[2]!.trim().replace(/^["']|["']$/g, "") } : null;
}

/** Replaces $VAR, ${VAR}, $env:VAR, %VAR% (when the command set it earlier) and a leading ~ or $HOME with their text. Unknown names stay as written. */
function expandVars(text: string, vars: ReadonlyMap<string, string>, home: string): string {
  const withVars = text.replace(/\$\{([A-Za-z_]\w*)\}|\$env:([A-Za-z_]\w*)|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g, (m, a, b, c, d) => {
    const name = (a ?? b ?? c ?? d) as string;
    const set = vars.get(name);
    if (set !== undefined) return set;
    return /^(HOME|USERPROFILE)$/i.test(name) ? home : m;
  });
  return withVars.replace(/(^|[\s"'=:(])~(?=[\\/]|$|[\s"'])/g, (_m, pre: string) => pre + home);
}

/**
 * `src/{a,b}.ts` becomes both spellings. A group with no comma (`{auth}`) is literal in bash, so it names a different file there;
 * it is expanded as well, because a tripwire that stays quiet when unsure is not a tripwire. All spellings are returned joined by
 * newlines, so one scan sees every one of them. Capped at 64 spellings.
 */
function expandBraces(text: string): string {
  const seen = new Set<string>([text]);
  let frontier = [text];
  for (let round = 0; round < 4 && seen.size < 64; round++) {
    const next: string[] = [];
    for (const t of frontier) {
      const m = /\{([^{}\s]*)\}/.exec(t);
      if (!m) continue;
      const alts = m[1]!.includes(",") ? m[1]!.split(",") : [m[1]!];
      for (const a of alts) {
        const v = t.slice(0, m.index) + a + t.slice(m.index + m[0].length);
        if (!seen.has(v) && seen.size < 64) {
          seen.add(v);
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  return [...seen].join("\n");
}

const CD_WORDS = new Set(["cd", "chdir", "pushd", "set-location", "sl"]);

function baseName(word: string): string {
  const w = word.replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  const b = (w.split("/").pop() ?? "").toLowerCase();
  return b.replace(/\.(cmd|exe|ps1|bat)$/, "");
}

/** The program a segment really runs, after env assignments, package runners and `python -m`. */
interface Program {
  name: string;
  args: string[];
}

const PM = new Set(["npm", "pnpm", "yarn", "bun"]);
const PM_RUNNERS = new Set(["exec", "dlx", "x"]);
const PY = new Set(["python", "python3", "py", "python2"]);

function effectiveProgram(words: string[]): Program | null {
  let w = words.map((x) => x.replace(/^["']|["']$/g, ""));
  for (let guard = 0; guard < 6 && w.length > 0; guard++) {
    const first = baseName(w[0]!);
    const rest = w.slice(1);
    const nonFlag = (list: string[]) => {
      let i = 0;
      while (i < list.length && list[i]!.startsWith("-")) {
        // a runner's -p <pkg> / --package <pkg> / -c <cmd> take a value
        if (/^(-p|--package|-c|--call)$/.test(list[i]!)) i++;
        i++;
      }
      return list.slice(i);
    };
    if (PACKAGE_RUNNER_NAMES.has(first)) { w = nonFlag(rest); continue; }
    if (PM.has(first)) {
      const r = nonFlag(rest);
      const sub = (r[0] ?? "").toLowerCase();
      if (PM_RUNNERS.has(sub)) { w = nonFlag(r.slice(1)); continue; }
      if (sub === "run" || sub === "run-script") return { name: `script:${(r[1] ?? "").toLowerCase()}`, args: r.slice(2) };
      if (first === "npm" || first === "bun") return { name: `pm:${sub}`, args: r.slice(1) };
      if (sub !== "" && !PM_SUBCOMMANDS.has(sub)) { w = r; continue; } // `pnpm eslint x`, `yarn vitest x`: the bin
      return { name: `pm:${sub}`, args: r.slice(1) };
    }
    if ((first === "uv" || first === "poetry" || first === "pipx" || first === "pdm" || first === "hatch") && (rest[0] === "run")) { w = nonFlag(rest.slice(1)); continue; }
    if (PY.has(first) && rest[0] === "-m" && rest[1]) { w = rest.slice(1); continue; }
    if (first === "command" || first === "builtin" || first === "time" || first === "nohup" || first === "nice") { w = nonFlag(rest); continue; }
    return { name: first, args: rest };
  }
  return w.length > 0 ? { name: baseName(w[0]!), args: w.slice(1) } : null;
}

const PM_SUBCOMMANDS = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "test", "t", "ls", "list", "why", "view", "info", "outdated", "audit", "init", "publish", "pack", "link", "unlink", "config", "cache", "prune", "dedupe", "rebuild", "ci", "start", "stop", "restart", "version", "help", "login", "logout", "whoami", "workspace", "workspaces", "store", "patch"]);
const PM_READ_ONLY = new Set(["test", "t", "ls", "list", "why", "view", "info", "outdated", "audit", "version", "help", "whoami", "ci"]);
const SAFE_SCRIPT = /^(test|tests|lint|typecheck|type-check|check|build|coverage|ci|verify|test:.*|lint:.*|check:.*|typecheck:.*|build:.*)$/;

/** Programs that only read. A flag below that makes one of them write turns it back into a command to screen. */
const READ_ONLY_PROGRAMS = new Set([
  "cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack", "ls", "dir", "tree", "wc", "file", "stat", "diff", "cmp", "comm", "find",
  "sort", "uniq", "cut", "nl", "tac", "od", "hexdump", "xxd", "strings", "md5sum", "sha1sum", "sha256sum", "shasum", "cksum", "basename", "dirname", "realpath",
  "readlink", "pwd", "which", "where", "whoami", "date", "echo", "printf", "true", "false", "test", "[", "type", "sleep", "du", "df", "bat", "jq", "yq",
  "get-content", "gc", "select-string", "sls", "get-childitem", "gci", "test-path", "get-item", "gi", "get-filehash", "measure-object", "resolve-path",
  "write-output", "write-host", "findstr", "get-location", "get-command", "get-date",
]);
/** Checkers and test runners: read-only unless handed a flag that makes them rewrite files (--fix, snapshot update, in-place). */
const CHECKERS = CHECKER_NAMES;
/** Formatters and fixers: read-only only when asked to check, never to write. */
const FORMATTERS = new Set(["prettier", "black", "isort", "biome", "gofmt", "rustfmt", "dprint", "clang-format", "autopep8", "yapf", "ruff"]);
const WRITE_FLAG = /^(--fix|--fix=.*|--write|--write=.*|-w|-u|--update|--update-snapshots?|--updatesnapshot|-U|--in-place|--inplace|-i|--apply|--apply-unsafe|--unsafe-fixes|--auto-correct|-a|-A|--output|--output=.*|-o|--outfile|--outfile=.*|--init|--save|--fix-only)$/;
const CHECK_FLAG = /^(--check|-c|--diff|--list-different|-l|--dry-run|--fix-dry-run)$/;
const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list", "add", "commit", "branch", "tag", "remote", "fetch", "push", "config", "describe",
  "shortlog", "grep", "cat-file", "show-ref", "for-each-ref", "diff-tree", "merge-base", "check-ignore", "reflog", "version", "help", "whatchanged", "name-rev", "count-objects",
]);
const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "python2", "py", "ruby", "perl", "php", "pwsh", "powershell", "bash", "sh", "zsh", "dash", "cmd", "tsx", "ts-node", "lua", "rscript"]);
const INLINE_FLAG = /^(-[A-Za-z]*[ceEprR]|--eval|--print|--command|-command|-encodedcommand|\/[ck])$/;

function gitSubcommand(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (args[i] === "-C" || args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree") i++;
    i++;
  }
  return { sub: (args[i] ?? "").toLowerCase(), rest: args.slice(i + 1) };
}

/** True for a command that cannot write a file by itself. Everything else is screened for any mention of a governed or protected path. */
function isReadOnlyCommand(prog: Program): boolean {
  const { name, args } = prog;
  if (name.startsWith("script:")) return SAFE_SCRIPT.test(name.slice(7));
  if (name.startsWith("pm:")) return PM_READ_ONLY.has(name.slice(3));
  if (name === "git") {
    const { sub, rest } = gitSubcommand(args);
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    return GIT_READ_ONLY.has(sub);
  }
  if (name === "go") return ["test", "vet", "build", "list", "version", "env", "doc", "mod"].includes(args[0] ?? "");
  if (name === "cargo") return ["test", "check", "clippy", "build", "doc", "tree", "metadata", "version"].includes(args[0] ?? "") && !args.some((a) => WRITE_FLAG.test(a));
  if (name === "ruff") return (args[0] === "check" && !args.some((a) => WRITE_FLAG.test(a))) || (!args.some((a) => WRITE_FLAG.test(a)) && args.some((a) => CHECK_FLAG.test(a)));
  if (FORMATTERS.has(name)) return !args.some((a) => WRITE_FLAG.test(a)) && args.some((a) => CHECK_FLAG.test(a));
  if (CHECKERS.has(name)) return !args.some((a) => WRITE_FLAG.test(a));
  if (name === "find") return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (name === "sort") return !args.some((a) => a === "-o" || a.startsWith("--output"));
  return READ_ONLY_PROGRAMS.has(name);
}

/** How an interpreter is being used: with code on the command line or stdin (everything it names may be written), or on a script file. */
function interpreterUse(prog: Program, hasBody: boolean): { inline: boolean; operand: string | null } | null {
  if (!INTERPRETERS.has(prog.name)) return null;
  const inline = hasBody || prog.args.some((a) => INLINE_FLAG.test(a)) || prog.args.includes("-");
  const operand = prog.args.find((a) => !a.startsWith("-")) ?? null;
  return { inline, operand: inline ? null : operand };
}

/** Splits into path-like words. Quotes, commas, `=` and brackets are separators so `open('src/a.ts','w')` and `--output=src/a.ts` yield the path. */
function tokens(segment: string): string[] {
  const norm = segment.replace(/\\/g, "/");
  const words = new Set<string>();
  for (const t of norm.split(/[\s;&|<>()`'",={}[\]$!]+/)) if (t.length > 0 && !t.startsWith("-")) words.add(t);
  // A colon separates too (`--file:src/a.ts`), but a Windows drive (`C:/x`) and a URL (`https://x`) are kept whole by the pass above.
  for (const t of norm.split(/[\s;&|<>()`'",={}[\]$!:]+/)) if (t.length > 0 && !t.startsWith("-")) words.add(t);
  return [...words];
}

function foldCase(ctx: GovernedContext, s: string): string {
  return ctx.caseInsensitive ? s.toLowerCase() : s;
}

/** True when `p` occurs in `text` as a whole path: not glued to a longer name before it, nor continued after it (`a.ts.bak` is another file). */
function mentionsPath(text: string, p: string, asDir: boolean): boolean {
  if (p.length < 2) return false;
  for (let from = text.indexOf(p); from !== -1; from = text.indexOf(p, from + 1)) {
    const before = from === 0 ? "" : text[from - 1]!;
    if (before !== "" && /[A-Za-z0-9_.-]/.test(before) && !(before === "." && from >= 2 && text[from - 2] === "/")) continue;
    const end = from + p.length;
    const after = end >= text.length ? "" : text[end]!;
    if (after === "") return true;
    if (asDir ? after === "/" || !/[A-Za-z0-9_-]/.test(after) : !/[A-Za-z0-9_-]/.test(after) && !(after === "." && /[A-Za-z0-9]/.test(text[end + 1] ?? ""))) return true;
  }
  return false;
}

const TRIPWIRE_TAIL =
  " This is a text check on the command, not a guarantee. If the command only reads, run it as a plain read-only command (cat, grep, git diff); to change the file use `purix change` or the purix_change MCP tool.";

/**
 * The whole-command scan (A9-1). `text` is every spelling of the command (variables and braces expanded); `exempt` is the script a
 * script-mode interpreter runs, which is code being run, not a file being written. Returns the first governed or protected path the
 * text names, by path, glob, or as a whole path anywhere in the text (inside quotes, code, a heredoc, a variable value).
 */
function mentionHit(ctx: GovernedContext, cwd: string, text: string, exempt: string | null, dirHits = false): HookDecision | null {
  const deny = (file: string, why: "governed" | "protected"): HookDecision => {
    const component = ctx.governed.get(file);
    return why === "governed"
      ? { action: "deny", rule: "shell-write", reason: `this command names ${file}, which Purix governs (component "${component}"), and it is not a read-only command, so it is blocked as a precaution.${TRIPWIRE_TAIL}`, targets: [file] }
      : { action: "deny", rule: "protected-file", reason: `this command names ${file}, which is part of Purix's own state or the hook setup that enforces it, and it is not a read-only command, so it is blocked as a precaution.${TRIPWIRE_TAIL}`, targets: [file] };
  };

  const exemptToken = exempt === null ? null : exempt.replace(/\\/g, "/");
  let skipped = false;
  for (const token of tokens(text)) {
    if (!skipped && exemptToken !== null && token === exemptToken) {
      skipped = true;
      continue;
    }
    if (hasGlob(token)) {
      const g = globHit(ctx, cwd, token);
      if (g) return { ...g, reason: g.reason + TRIPWIRE_TAIL };
      continue;
    }
    const hit = whyBlocked(ctx, resolveTarget(ctx, cwd, token), dirHits);
    if (hit) return deny(hit.target, hit.rule === "protected-file" ? "protected" : "governed");
  }

  let scan = exempt !== null && exempt !== "" ? text.replace(exempt, " ") : text;
  scan = foldCase(ctx, scan).replace(/\\/g, "/");
  for (const file of ctx.governed.keys()) {
    const f = foldCase(ctx, file);
    if (scan.includes(f) && mentionsPath(scan, f, false)) return deny(file, "governed");
  }
  for (const file of ctx.protectedFiles) {
    if (mentionsPath(scan, key(ctx, file), false)) return deny(file, "protected");
  }
  const root = canonicalize(ctx.projectRoot);
  for (const abs of ctx.protectedAbsolute) {
    const r = relative(root, canonicalize(abs));
    const forms = [toPosix(abs)];
    if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) forms.push(toPosix(r));
    for (const form of forms) if (mentionsPath(scan, foldCase(ctx, form), true)) return deny(form, "protected");
  }
  return null;
}

function screenShell(ctx: GovernedContext, cwd0: string, command: string): HookDecision {
  const home = homedir();
  const vars = new Map<string, string>();
  let cwd = cwd0;

  for (const seg of splitCommand(command)) {
    const assignment = parseAssignment(seg.head);
    if (assignment) {
      vars.set(assignment.name, expandVars(assignment.value, vars, home));
      continue;
    }
    const expanded = expandVars(seg.head, vars, home);
    const lead = leadWords(expanded);

    if (lead.length > 0 && CD_WORDS.has(baseName(lead[0]!))) {
      // `cd src`, `pushd src`, `Set-Location -Path src`: later relative paths in this command resolve from there.
      const target = lead.slice(1).find((w) => !w.startsWith("-"))?.replace(/^["']|["']$/g, "").replace(/\\/g, "/");
      if (target) cwd = resolve(isAbsolute(target) ? target : join(cwd, target));
      continue;
    }

    if (isPurixInvocation(lead)) {
      const sub = purixSubcommand(lead);
      if (sub === "approve" || sub === "deny") {
        return {
          action: "deny",
          rule: "human-only",
          reason: "`purix approve` and `purix deny` answer your own pending request, so only the person can run them, in their own terminal. Ask the person to run it, then check with purix_approval_status.",
          targets: [],
        };
      }
      // `purix provider trust` and `purix provider set custom` decide where the user's API key is sent, so they are the person's call too.
      if (sub === "provider") {
        const rest = lead.map((x) => x.toLowerCase().replace(/^["']|["']$/g, "")).filter((x) => !x.startsWith("-"));
        const at = rest.indexOf("provider");
        const verb = rest[at + 1];
        if (verb === "trust" || (verb === "set" && rest[at + 2] === "custom")) {
          return {
            action: "deny",
            rule: "human-only",
            reason: "`purix provider trust` and `purix provider set custom` choose where your API key is sent, so only the person can run them, in their own terminal.",
            targets: [],
          };
        }
      }
      continue;
    }

    const text = expandBraces(expanded);

    // 1. Redirections are precise: only the file written to matters.
    let dynamicRedirect = false;
    for (const m of text.matchAll(REDIRECT_TARGET)) {
      const target = m[1] ?? m[2] ?? m[3] ?? "";
      if (!target || target.startsWith("&") || /^\/dev\/(null|stdout|stderr)$/i.test(target) || /^nul$/i.test(target)) continue;
      // `> $(echo path)`, `> `cmd``, `> $UNSET`: the file is not known from the text, so the command is not treated as read-only below.
      if (target.includes("$") || target.includes("`")) dynamicRedirect = true;
      if (hasGlob(target)) {
        const g = globHit(ctx, cwd, target);
        if (g) return g;
        continue;
      }
      const hit = whyBlocked(ctx, resolveTarget(ctx, cwd, target));
      if (hit) return { action: "deny", rule: hit.rule === "protected-file" ? "protected-file" : "shell-write", reason: hit.reason, targets: [hit.target] };
    }

    const prog = effectiveProgram(lead);
    // A command that cannot write by itself (cat, grep, git diff, a test run) is not screened further: its redirections already were.
    if (prog !== null && !dynamicRedirect && isReadOnlyCommand(prog)) continue;

    // 2. A write-capable word, or an interpreter running inline code, that names (or could glob to) a protected or governed path.
    //    This is the original rule and keeps its reach: it also blocks a parent folder (`rm -rf src`, `cp x src/`).
    const writes = WRITE_VERBS.test(text) || INTERPRETER_CODE.test(text);
    if (writes) {
      for (const token of tokens(text)) {
        if (hasGlob(token)) {
          const g = globHit(ctx, cwd, token);
          if (g) return g;
          continue;
        }
        const hit = whyBlocked(ctx, resolveTarget(ctx, cwd, token));
        if (hit) {
          return {
            action: "deny",
            rule: hit.rule === "protected-file" ? "protected-file" : "shell-write",
            reason: `${hit.reason} (Blocked a shell command that names it and can write. If the command only reads the file, use a read-only command instead.)`,
            targets: [hit.target],
          };
        }
      }
    }

    // 3. A9-1: any other command that names a governed or protected path anywhere in its text, heredoc included.
    const use = prog === null ? null : interpreterUse(prog, seg.body !== "");
    // `find DIR -delete` / `-exec rm` can remove anything under DIR, so a folder holding governed files counts as a hit for it.
    const hit = mentionHit(ctx, cwd, seg.body ? `${text}\n${expandBraces(expandVars(seg.body, vars, home))}` : text, use?.operand ?? null, prog?.name === "find");
    if (hit) return hit;
  }
  return ALLOW;
}

export function decideHook(call: NormalizedCall, ctx: GovernedContext, cwd: string): HookDecision {
  if (call.event !== "pre-tool-use") return ALLOW;

  // A tool the hook does not know by name but that carries a path is a write, unless its name says it only reads (A9-1, research 09).
  const writeLike = call.toolClass === "write" || (call.toolClass === "other" && call.paths.length > 0 && !isPurixTool(call.tool) && !isReadLikeTool(call.tool));
  if (writeLike) {
    if (call.paths.length === 0) {
      // Cannot tell which file this edit touches. Allowing it would let any unrecognised input shape slip past.
      return { action: "deny", rule: "no-path", reason: `could not tell which file the "${call.tool}" call writes, so it cannot be checked. Use the Purix tools for governed work.`, targets: [] };
    }
    if (ctx.state === "damaged" && !ctx.lockUsed) {
      return { action: "deny", rule: "state-unreadable", reason: "Purix's state is unreadable and there is no committed lock to fall back on, so edits cannot be checked. Run `purix check` and tell the person.", targets: [] };
    }
    const blocked: { rule: HookRule; reason: string; target: string }[] = [];
    for (const p of call.paths) {
      const hit = whyBlocked(ctx, resolveTarget(ctx, cwd, p));
      if (hit) blocked.push(hit);
    }
    if (blocked.length > 0) {
      const first = blocked[0]!;
      const extra = blocked.length > 1 ? ` (${blocked.length} files in this call are blocked: ${blocked.map((b) => b.target).join(", ")}.)` : "";
      return { action: "deny", rule: first.rule, reason: first.reason + extra, targets: blocked.map((b) => b.target) };
    }
    // C5: nothing blocked. Name the files in the project that no component governs, when the project governs anything at all.
    if ((ctx.state === "ok" || ctx.lockUsed) && ctx.governed.size > 0) {
      const unadopted: string[] = [];
      for (const p of call.paths) {
        const t = resolveTarget(ctx, cwd, p);
        if (t.rel !== null && t.rel !== "" && !inUntrackedDir(t.rel) && !unadopted.includes(t.rel)) unadopted.push(t.rel);
      }
      if (unadopted.length > 0) return { ...ALLOW, unadopted };
    }
    return ALLOW;
  }

  if (call.toolClass === "shell" && call.command !== null) return screenShell(ctx, cwd, call.command);
  return ALLOW;
}
