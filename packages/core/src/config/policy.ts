// packages/core/src/config/policy.ts
//
// A2a-1: the declarative, default-deny policy file (POLICY_PATH): path globs, command allow and deny, and a diff-size limit.
// It is a pure decision plus a loader. Nothing calls it yet: the hook (A9-1) and the trust gate decide when to ask. Nothing here
// installs, writes or enforces anything on its own.
//
// Rules, in this order of strength:
//   - A policy file that is present but wrong (cannot be parsed, unknown keys, wrong types) is "invalid", and policyFromLoad turns
//     it into DENY_ALL_POLICY. A broken policy never means "allowed".
//   - A file that is absent is "absent", which is NOT "allowed": the caller decides what no policy means. policyFromLoad gives null.
//   - Inside a policy, a section that is listed is default-deny: a path that no allow_paths rule matches is refused, a command that
//     no allow_commands rule matches is refused. A section that is not listed is not checked (no rule, no opinion). An EMPTY
//     allow list allows nothing.
//   - deny always beats allow.
//
// Paths use the shared matcher (gates/path_match.ts): separators and case are normalised first. Commands are judged as text, a
// tripwire and not prevention: a chained or substituted command (&&, ;, |, backticks, $( ) is split and EVERY part must be
// allowed, and any command that contains a substitution is refused, because its real text is not known until a shell runs it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchAnyPath } from "../gates/path_match.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

export const POLICY_PATH = `${PURIX_DIRNAME}/policy.json`;

export interface PurixPolicy {
  schema: 1;
  /** Globs. When listed, a path must match one of them. */
  allow_paths?: string[];
  /** Globs. A match refuses the path whatever allow_paths says. */
  deny_paths?: string[];
  /** Command prefixes: "git status" matches "git status" and "git status -s"; "git diff *" needs at least one more word. */
  allow_commands?: string[];
  deny_commands?: string[];
  /** Most changed lines (added plus removed) one change may carry. */
  max_diff_lines?: number;
}

export const DENY_ALL_POLICY: PurixPolicy = { schema: 1, allow_paths: [], allow_commands: [], max_diff_lines: 0 };

export type PolicyLoad = { state: "absent" } | { state: "ok"; policy: PurixPolicy } | { state: "invalid"; problems: string[] };

const KNOWN_KEYS = new Set(["schema", "allow_paths", "deny_paths", "allow_commands", "deny_commands", "max_diff_lines"]);

function stringList(v: unknown, key: string, problems: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
    problems.push(`${key} must be a list of non-empty strings`);
    return undefined;
  }
  return v as string[];
}

export function loadPolicy(baseDir: string = process.cwd()): PolicyLoad {
  const path = join(baseDir, POLICY_PATH);
  if (!existsSync(path)) return { state: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { state: "invalid", problems: [`${POLICY_PATH} is not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", problems: [`${POLICY_PATH} must be a JSON object`] };
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (o.schema !== 1) problems.push("schema must be 1");
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.has(k)) problems.push(`unknown key "${k}" (a misspelt rule would be silently ignored)`);
  const policy: PurixPolicy = { schema: 1 };
  const allowPaths = stringList(o.allow_paths, "allow_paths", problems);
  const denyPaths = stringList(o.deny_paths, "deny_paths", problems);
  const allowCmds = stringList(o.allow_commands, "allow_commands", problems);
  const denyCmds = stringList(o.deny_commands, "deny_commands", problems);
  if (allowPaths) policy.allow_paths = allowPaths;
  if (denyPaths) policy.deny_paths = denyPaths;
  if (allowCmds) policy.allow_commands = allowCmds;
  if (denyCmds) policy.deny_commands = denyCmds;
  if (o.max_diff_lines !== undefined) {
    if (typeof o.max_diff_lines !== "number" || !Number.isInteger(o.max_diff_lines) || o.max_diff_lines < 0) problems.push("max_diff_lines must be a whole number, 0 or more");
    else policy.max_diff_lines = o.max_diff_lines;
  }
  return problems.length > 0 ? { state: "invalid", problems } : { state: "ok", policy };
}

/** The policy to enforce for a load result: the file's, deny-all for a broken file, null (no policy) for an absent one. */
export function policyFromLoad(load: PolicyLoad): PurixPolicy | null {
  if (load.state === "ok") return load.policy;
  if (load.state === "invalid") return DENY_ALL_POLICY;
  return null;
}

export interface PolicyRequest {
  paths?: string[];
  command?: string;
  diffLines?: number;
}
export interface PolicyDecision {
  allowed: boolean;
  /** One line per refusal, naming what was refused and which rule did it. Empty when allowed. */
  reasons: string[];
}

function normaliseCommand(c: string): string {
  return c.trim().replace(/\s+/g, " ");
}

function commandMatches(command: string, rule: string): boolean {
  const r = normaliseCommand(rule);
  if (r.endsWith(" *")) {
    const prefix = r.slice(0, -2);
    return command.startsWith(`${prefix} `);
  }
  return command === r || command.startsWith(`${r} `);
}

/** Splits on the shell's separators. A command with a substitution is returned as null: its real text is unknown. */
function commandParts(command: string): string[] | null {
  if (/`|\$\(|<\(|>\(/.test(command)) return null;
  return command
    .split(/&&|\|\||;|\||&|\r?\n/)
    .map(normaliseCommand)
    .filter((p) => p !== "");
}

export function evaluatePolicy(policy: PurixPolicy, req: PolicyRequest): PolicyDecision {
  const reasons: string[] = [];

  if (req.paths && req.paths.length > 0) {
    for (const path of req.paths) {
      const denied = policy.deny_paths ? matchAnyPath([path], policy.deny_paths, { overLength: "match" }) : { hit: false };
      if (denied.hit) {
        reasons.push(`${path} is refused by deny_paths (${denied.matchedPattern})`);
        continue;
      }
      if (policy.allow_paths !== undefined && !matchAnyPath([path], policy.allow_paths, { overLength: "match" }).hit) {
        reasons.push(`${path} is not allowed by any allow_paths rule`);
      }
    }
  }

  if (req.command !== undefined) {
    const parts = commandParts(req.command);
    if (parts === null) {
      if (policy.allow_commands !== undefined || policy.deny_commands !== undefined) reasons.push(`command contains a substitution, so its real text is not known: ${normaliseCommand(req.command).slice(0, 80)}`);
    } else {
      for (const part of parts) {
        const denied = policy.deny_commands?.find((r) => commandMatches(part, r));
        if (denied !== undefined) {
          reasons.push(`command "${part}" is refused by deny_commands (${denied})`);
          continue;
        }
        if (policy.allow_commands !== undefined && !policy.allow_commands.some((r) => commandMatches(part, r))) {
          reasons.push(`command "${part}" is not allowed by any allow_commands rule`);
        }
      }
    }
  }

  if (req.diffLines !== undefined && policy.max_diff_lines !== undefined && req.diffLines > policy.max_diff_lines) {
    reasons.push(`the change is ${req.diffLines} lines, over the limit of ${policy.max_diff_lines}`);
  }

  return { allowed: reasons.length === 0, reasons };
}
