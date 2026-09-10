// src/gates/trustgate.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTestFilePath } from "../verify/test_integrity.js";

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
}

/**
 * §6.2. Three independent gates feeding one decision, checked in the
 * order the spec's own diagram lays out: test-integrity first, then
 * coverage, then confidence-vs-thresholds. Any one of them can route to
 * human confirmation; only a clean pass through all three — at or above
 * the confirm threshold and not contract-changing — auto-commits.
 *
 * This is the Instruction Path version: it assumes a real classifier
 * confidence exists. Diff Ingestion doesn't have one yet (diff-classify
 * mode isn't built), so ingested diffs go through
 * evaluateTrustGateForDiff below instead of this function with a
 * made-up confidence value.
 */
export function evaluateTrustGate(input: TrustGateInput): TrustGateDecision {
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
 * §6.2's coverage gate, the cheap version the spec explicitly asks for:
 * a file-level boolean, not per-AST-node coverage weighting. "Has
 * coverage" here means "a matching .test.ts file exists" — the same
 * convention tests.ts already uses to find tests for a file. This is
 * genuinely coarser than real coverage instrumentation (a paired test
 * file could exist and still not exercise the changed lines) — no c8/
 * istanbul integration is wired up in this project, so that's the
 * honest limit of what "coverage" means here today, not a claim of
 * more than this actually checks. §6.2 itself calls the more granular
 * version a real refinement, deferred until this proves too coarse.
 */
export function hasTestCoverage(files: { path: string }[], baseDir: string = process.cwd()): boolean {
  return files.some((f) => {
    if (isTestFilePath(f.path)) return false; // a test file itself doesn't need its own test file
    const testPath = f.path.replace(/\.ts$/, ".test.ts");
    return existsSync(resolve(baseDir, testPath));
  });
}

// --- Bundle E-DOF: Deterministic Override Floors ---

const DOF_CONFIG_FILENAME = "dof-patterns.json";

const DEFAULT_DOF_PATTERNS: string[] = [
  "**/auth/**",
  "**/migrations/**",
  "**/*.env*",
  "src/security/**",
];

/**
 * Minimal glob support — "**" (any depth, including zero) and "*" (any
 * one path segment). No dependency added for this: the same "one fewer
 * supply-chain package touching a paranoia-relevant path" reasoning
 * ingest.ts already applies to hand-rolling its own diff parser.
 *
 * Known, accepted limitation: "**\/auth/**" will also match a path like
 * "src/notauth/foo.ts", because ".*" is happy to absorb "not" right
 * before the literal "auth". A real glob engine wouldn't. Left as-is on
 * purpose — a DOF pattern's only job is to force a human look, never to
 * skip one, so over-matching is the safe-direction error here. Tighten
 * the pattern itself (e.g. "**\/auth/\*\*") if a specific false positive
 * gets noisy in practice.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (glob[i] === "/") i += 1; // so "**/x" also matches "x" at the root
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp("^" + re + "$");
}

/**
 * Loads dof-patterns.json from the project root if present; falls back
 * to DEFAULT_DOF_PATTERNS (logged, not silent) if the file is missing
 * or malformed. A missing config is a normal first-run state, not an
 * error — this never throws.
 */
export function loadDofPatterns(baseDir: string = process.cwd()): string[] {
  const configPath = resolve(baseDir, DOF_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return DEFAULT_DOF_PATTERNS;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed;
    }
    console.warn(`  warning: ${DOF_CONFIG_FILENAME} exists but isn't a JSON array of strings — using built-in defaults.`);
  } catch (err) {
    console.warn(`  warning: couldn't parse ${DOF_CONFIG_FILENAME} (${err instanceof Error ? err.message : err}) — using built-in defaults.`);
  }
  return DEFAULT_DOF_PATTERNS;
}

export interface DofCheckResult {
  hit: boolean;
  matchedPath?: string;
  matchedPattern?: string;
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
  for (const p of paths) {
    for (const pattern of patterns) {
      if (globToRegExp(pattern).test(p)) {
        return { hit: true, matchedPath: p, matchedPattern: pattern };
      }
    }
  }
  return { hit: false };
}