// src/gates/trustgate.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTestPath } from "../verify/test_discovery.js";
import { isPythonTestPath } from "../verify/python_test_discovery.js";
import { languageForFile, getLanguageProvider } from "../language/registry.js";
import { matchAnyPath } from "./path_match.js";
import { POLICY_PATH } from "../config/policy.js";
import { recordGovernanceEvent } from "../security/audit_events.js";

export type TrustGateAction = "auto_commit" | "human_confirm" | "abort";

export interface TrustGateDecision {
  action: TrustGateAction;
  reason: string;
}

// §6.2's own two named thresholds. Earlier code had one confidence floor
// conflating "don't auto-commit" with "stop and ask a clarifying
// question" — those are two different outcomes in v1.0, so two numbers.
const REJECT_THRESHOLD = 0.35;
const CONFIRM_THRESHOLD = 0.75;

export interface TrustGateInput {
  confidence: number;
  contractChanging: boolean;
  hasCoverage: boolean;
  testIntegrity: { flagged: boolean; reason?: string };
  /**
   * TEST-REPORT F4: the classifier's self-reported
   * `suspicious_injected_instruction`. Before this field existed the flag
   * only printed a warning and the change could still auto-commit at high
   * confidence. It is model-self-reported, so a compromised model may not
   * raise it — this is one extra tripwire, not a guarantee. Optional so
   * callers that have no such signal keep working.
   */
  injectionSuspected?: boolean;
  /**
   * How isolated the verification run was (sandbox result's `isolation`). "none" means generated code ran with no sandbox,
   * so a clean result is weaker evidence: such a change is never auto-committed, a human confirms it. Optional so callers
   * with no verification result keep the old behaviour.
   */
  isolation?: string;
  /**
   * A2a-1: filled by A6 (verification and test trust), read by nobody yet. Share of the CHANGED lines that a passing test ran,
   * 0 to 1. Defined here, optional, so A6 can fill it without editing this file and so the decision log already has the column.
   * It does not change any decision today: the final auto-commit rule waits for real numbers from A3 and A6.
   */
  changedLineCoverage?: number;
  /** A2a-1: filled by A6. Test counts before the change, so "tests that passed before now fail" can be a rule later. Not read yet. */
  testBaseline?: { passed: number; failed: number; skipped: number };
}

/**
 * §6.2. Three independent gates feeding one decision, checked in the
 * order the spec's own diagram lays out: test-integrity first, then
 * coverage, then confidence-vs-thresholds. Any one of them can route to
 * human confirmation; only a clean pass through all three — at or above
 * the confirm threshold and not contract-changing — auto-commits.
 *
 * Both the Instruction Path and Diff Ingestion (classifyDiff) call this
 * one function with the classifier's real confidence.
 */
export function evaluateTrustGate(input: TrustGateInput): TrustGateDecision {
  if (input.injectionSuspected) {
    return {
      action: "human_confirm",
      reason: `the classifier flagged possible prompt injection in the request or diff — a human must approve regardless of confidence (${input.confidence.toFixed(2)})`,
    };
  }

  if (input.testIntegrity.flagged) {
    return {
      action: "human_confirm",
      reason: `a touched test's assertions were weakened or removed${input.testIntegrity.reason ? `: ${input.testIntegrity.reason}` : ""}`,
    };
  }

  if (!input.hasCoverage) {
    return {
      action: "human_confirm",
      reason: `high model confidence, but the modified file has no test coverage`,
    };
  }

  if (input.confidence < REJECT_THRESHOLD) {
    return {
      action: "abort",
      reason: `classifier confidence ${input.confidence.toFixed(2)} is below the reject threshold (${REJECT_THRESHOLD})`,
    };
  }

  if (input.confidence >= CONFIRM_THRESHOLD && !input.contractChanging && input.isolation === "none") {
    return {
      action: "human_confirm",
      reason: `confidence ${input.confidence.toFixed(2)} would auto-commit, but verification ran with no isolation, so a human must confirm`,
    };
  }

  if (input.confidence >= CONFIRM_THRESHOLD && !input.contractChanging) {
    return {
      action: "auto_commit",
      reason: `confidence ${input.confidence.toFixed(2)} clears the confirm threshold, non-contract-changing`,
    };
  }

  if (input.confidence >= CONFIRM_THRESHOLD && input.contractChanging) {
    return {
      action: "human_confirm",
      reason: `confidence ${input.confidence.toFixed(2)} is high, but this is a contract-changing operation — always requires confirmation regardless of confidence (§7.5)`,
    };
  }

  return {
    action: "human_confirm",
    reason: `confidence ${input.confidence.toFixed(2)} is between the reject (${REJECT_THRESHOLD}) and confirm (${CONFIRM_THRESHOLD}) thresholds — requires confirmation regardless of taxonomy`,
  };
}

/**
 * §6.2's coverage gate, still the cheap version (a file-level boolean, no coverage tool): "has
 * coverage" means a test is RELATED to a changed source file, as the file's own language provider
 * defines it (provider.findRelatedTests: a test that imports it, directly or through other files, or
 * one with the matching name in the usual places). Every language goes through the same call, so
 * TypeScript and Python files are judged by their own conventions and by nothing accidental.
 *
 * Unchanged meanings: a test file itself does not need its own test and does not count toward
 * coverage; coverage is "some changed source is covered", not "all" (whether it should be "all" is a
 * founder decision, PURIX-11 Phase C item 3). This still says nothing about whether the related tests
 * assert anything useful (that is mutation testing, a later step).
 *
 * Files no registered language claims (prompts, JSON config, markdown) keep the previous check exactly:
 * the file counts as covered if it exists. That is a long-standing quirk, not a design, and prompt and
 * config edits are Purix's main use, so it stays until the founder decides what "covered" should mean
 * for non-code components. Changing it here would send every such edit to human confirmation.
 */
export function hasTestCoverage(files: { path: string }[], baseDir: string = process.cwd()): boolean {
  const byLanguage = new Map<string, string[]>();
  for (const f of files) {
    if (isTestPath(f.path) || isPythonTestPath(f.path)) continue;
    const lang = languageForFile(f.path);
    if (!lang) {
      if (existsSync(resolve(baseDir, f.path.replace(/\.ts$/, ".test.ts")))) return true; // legacy rule, see above
      continue;
    }
    (byLanguage.get(lang) ?? byLanguage.set(lang, []).get(lang)!).push(f.path);
  }
  for (const [lang, paths] of byLanguage) {
    const found = getLanguageProvider(lang)?.findRelatedTests?.(paths, baseDir);
    if (found && found.tests.length > 0) return true;
  }
  return false;
}

// --- Bundle E-DOF: Deterministic Override Floors ---

const DOF_CONFIG_FILENAME = "dof-patterns.json";

// The floor: paths a person must always look at, whatever the classifier says. Matching is the shared matcher's
// (gates/path_match.ts): separators and case are normalised first, so a backslash path and a differently cased folder name
// are the same path as the plain one (research 08 missed both).
//
// Over-matching is the safe direction: a "**" may absorb text in front of a literal, so "**/auth/**" also holds
// "src/notauth/x.ts", and a hit only forces a human look. Tighten one pattern when a specific false positive gets noisy.
// Never use this list to ALLOW something.
const DEFAULT_DOF_PATTERNS: string[] = [
  // identity, access, secrets, data
  "**/auth/**",
  "**/authn/**",
  "**/authz/**",
  "**/authentication/**",
  "**/authorization/**",
  "**/iam/**",
  "**/security/**",
  "**/migrations/**",
  "**/*.env*",
  // who may approve, how code is built and shipped
  "**/CODEOWNERS",
  ".github/workflows/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "azure-pipelines.yml",
  "**/Jenkinsfile",
  "**/Dockerfile*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  // what gets installed: manifests and lockfiles
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock*",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/go.mod",
  "**/go.sum",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/pom.xml",
  "**/build.gradle*",
  "**/Gemfile",
  "**/Gemfile.lock",
  // the settings of the agents that run under the guard
  ".claude/**",
  ".cursor/**",
  ".codex/**",
  ".gemini/**",
  ".opencode/**",
  ".windsurf/**",
  "opencode.json",
];

// Always held, even when a project's own dof-patterns.json replaces the list above: the files that define the floor and the
// policy. Otherwise one edit to dof-patterns.json (an empty list) would switch the floor off without anyone being asked.
const PROTECTED_CONFIG_PATTERNS: string[] = ["dof-patterns.json", "purix.config.json", POLICY_PATH];

/** The one place loading the protected-paths file writes to the terminal. */
function warnDof(message: string): void {
  console.warn(`  warning: ${message}`);
}

/**
 * Loads dof-patterns.json from the project root if present and adds its patterns to DEFAULT_DOF_PATTERNS (never replacing them).
 * The defaults are used on their own (logged, not silent) when the file is missing, malformed or empty. A missing config is a normal first-run state, not an
 * error — this never throws.
 */
export function loadDofPatterns(baseDir: string = process.cwd()): string[] {
  const configPath = resolve(baseDir, DOF_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return [...DEFAULT_DOF_PATTERNS, ...PROTECTED_CONFIG_PATTERNS];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      // A project's list ADDS to the built-in floor, it never replaces it: a repository that ships its own list (or an empty one)
      // must not be able to drop `.env`, workflows or lockfiles from what always needs a human look. Blank entries are ignored.
      const own = parsed.map((p) => p.trim()).filter((p) => p.length > 0);
      if (own.length === 0) {
        warnDof(`${DOF_CONFIG_FILENAME} has no patterns in it — refused; using the built-in defaults.`);
        return [...DEFAULT_DOF_PATTERNS, ...PROTECTED_CONFIG_PATTERNS];
      }
      return [...new Set([...DEFAULT_DOF_PATTERNS, ...own, ...PROTECTED_CONFIG_PATTERNS])];
    }
    warnDof(`${DOF_CONFIG_FILENAME} exists but isn't a JSON array of strings — using built-in defaults.`);
  } catch (err) {
    warnDof(`couldn't parse ${DOF_CONFIG_FILENAME} (${err instanceof Error ? err.message : String(err)}) — using built-in defaults.`);
  }
  return [...DEFAULT_DOF_PATTERNS, ...PROTECTED_CONFIG_PATTERNS];
}

export interface DofCheckResult {
  hit: boolean;
  matchedPath?: string;
  matchedPattern?: string;
  /** True when the hit is only because a path was longer than the matcher's bound: held, never skipped. */
  overLength?: boolean;
}

/**
 * §E-DOF. Pure path matching, no LLM, no confidence involved at all —
 * that's the entire point of a *deterministic* floor. A hit here means
 * "this touches a path someone decided always needs a human, full
 * stop," independent of anything the classifier says. The caller
 * (cli.ts) is responsible for actually forcing human_confirm when
 * hit is true — this function only detects, it doesn't gate.
 */
export function checkDeterministicOverrideFloor(paths: string[], patterns: string[]): DofCheckResult {
  try {
    // overLength "match": a path too long to compare holds the change. A 1 MB "path" can only make this stricter.
    const r = matchAnyPath(paths, patterns, { overLength: "match" });
    if (!r.hit) return { hit: false };
    return { hit: true, matchedPath: r.matchedPath, matchedPattern: r.matchedPattern, ...(r.overLength ? { overLength: true } : {}) };
  } catch (err) {
    // A pattern the matcher refuses (longer than its bound) cannot be evaluated. A floor that cannot be evaluated holds the change.
    if (err instanceof RangeError) return { hit: true, matchedPath: paths[0], matchedPattern: "(a floor pattern could not be evaluated)", overLength: true };
    throw err;
  }
}

/**
 * The Deterministic Override Floor as one step every front door calls (CLI instruction and diff paths, MCP instruction and diff paths).
 * It only ever turns an auto_commit into a human_confirm; an abort or a human_confirm is returned unchanged. Returns the floor's own
 * result too, so the caller can put it in the decision log.
 */
export function applyDeterministicFloor(decision: TrustGateDecision, paths: string[], baseDir: string = process.cwd()): { decision: TrustGateDecision; floor: DofCheckResult } {
  const floor = checkDeterministicOverrideFloor(paths, loadDofPatterns(baseDir));
  if (floor.hit && decision.action === "auto_commit") {
    return {
      decision: { action: "human_confirm", reason: `touches a Deterministic Override Floor path ("${floor.matchedPath}" matches "${floor.matchedPattern}") — always requires confirmation regardless of confidence (§E-DOF)` },
      floor,
    };
  }
  return { decision, floor };
}

// --- A2a-1: decision log ---------------------------------------------------------------------------------------------

export interface TrustGateDecisionContext {
  /** Which front door asked: "instruction", "diff", "mcp" ... */
  source: string;
  componentIds?: string[];
  files?: string[];
  /** The floor's answer for the same change, when the caller ran it. */
  floor?: DofCheckResult;
  /** Test seam: replaces the chain append. */
  append?: (payload: object) => unknown;
  onFailure?: (message: string) => void;
}

const MAX_LOGGED_FILES = 200;

/**
 * Puts one gate decision, with every input it was made from, into the audit chain, so that confidence can be calibrated against
 * what happened afterwards (nothing in Purix can say yet how often "0.75" was right). Call it with the result of
 * evaluateTrustGate. Never throws and never changes the decision: a failed append returns false.
 */
export function recordTrustGateDecision(input: TrustGateInput, decision: TrustGateDecision, ctx: TrustGateDecisionContext): boolean {
  const files = ctx.files ?? [];
  return recordGovernanceEvent(
    "gate_decision",
    {
      gate: "TrustGate",
      action: decision.action,
      reason: decision.reason,
      source: ctx.source,
      component_ids: ctx.componentIds ?? [],
      files: files.slice(0, MAX_LOGGED_FILES),
      ...(files.length > MAX_LOGGED_FILES ? { files_omitted: files.length - MAX_LOGGED_FILES } : {}),
      floor: ctx.floor ?? null,
      inputs: {
        confidence: input.confidence,
        contract_changing: input.contractChanging,
        has_coverage: input.hasCoverage,
        test_integrity_flagged: input.testIntegrity.flagged,
        injection_suspected: input.injectionSuspected ?? null,
        isolation: input.isolation ?? null,
        changed_line_coverage: input.changedLineCoverage ?? null,
        test_baseline: input.testBaseline ?? null,
      },
    },
    { append: ctx.append, onFailure: ctx.onFailure },
  );
}
