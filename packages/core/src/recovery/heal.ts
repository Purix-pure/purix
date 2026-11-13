// src/recovery/heal.ts
import { recordAnchorOutcome } from "../verify/anchor_events.js";
import { classifyRepair } from "../llm/classify.js";
import { applyEdits, type CompiledFileChange } from "../verify/compile.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { recordEvent } from "../manifest/events.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";
import { OscillationGuard, applyEditsAndCheckOscillation } from "./oscillation_guard.js";
import { shapeFailure, type ShapedFailure } from "../verify/failure_shape.js";
import { sanitizeAndRecord } from "../llm/input_scan.js";
import { appendLedger, renderLedger, sameFailurePlace, type LedgerEntry, type LedgerOutcome } from "./repair_ledger.js";
import { healEarlyStopEnabled } from "./heal_config.js";
import { infrastructureStopOf, type InfrastructureStop } from "./infrastructure_stop.js";
import { searchCutDetail, securityNotesDetail } from "../verify/discovery_cut.js";

const MAX_ATTEMPTS = 3;

export interface HealAttemptLog {
  attempt: number;
  reasoning?: string;
  result: "pass" | "fail";
  reason?: string;
}

export interface HealResult {
  ok: boolean;
  files?: CompiledFileChange[];
  attempts: HealAttemptLog[];
  /** The verification the returned files actually passed (carries isolation and notTested). Set only when ok. */
  verification?: SandboxVerificationResult;
  /** C3: paths where a repair-authored exact anchor started or ended inside a line, so the rest of that line stayed. Absent when none did. */
  partialLinePaths?: string[];
  /** A8-1: set only when a round's verification could not run (tool missing, labelled timeout, output limit, resource limit). The loop ended there with no further model call; `attempt` is that round. Not a failure of the code. */
  infrastructureStop?: InfrastructureStop & { attempt: number };
  /** AI-12: set only when PURIX_HEAL_EARLY_STOP ended the loop before MAX_ATTEMPTS. `attempts` still ends with the real last failure, which is what escalation receives. */
  stoppedEarly?: { attempt: number; errorClass: string; location: { path: string; line: number } | null };
  /**
   * E3c (F07-06): every full file set this loop verified and saw fail, starting with the state that first failed. Escalation is told
   * these so its own oscillation guard can refuse a candidate that equals one of them: verification of an identical file set is
   * deterministic, so it cannot pass the second time. Set only on a failure that ended after at least one failed verification; a round
   * whose check could not run (infrastructureStop) says nothing about the code and is not here.
   */
  triedStates?: { path: string; content: string }[][];
}

/** Seams for tests: the model call and the sandbox. Production callers pass nothing and get the real ones. */
export interface HealDeps {
  classifyRepair: typeof classifyRepair;
  verify: typeof verifyInSandbox;
}

/** Paths whose current content is not what the component had before the patch: the files the patch touched. */
function touchedPaths(original: { path: string; content: string }[], current: Map<string, string>): string[] {
  const before = new Map(original.map((f) => [f.path, f.content]));
  return [...current.entries()].filter(([path, content]) => before.get(path) !== content).map(([path]) => path);
}

function firstLocation(shaped: ShapedFailure): { path: string; line: number } | null {
  return shaped.locations[0] ?? null;
}

/**
 * Section 10: visible, capped self-healing. Every attempt runs in the
 * sandbox (engine/sandbox.ts) — real project files are never touched
 * until a passing version is found. Logs each attempt as it happens and
 * stops at MAX_ATTEMPTS to hand back to a human, rather than looping.
 */
export async function runSelfHealingLoop(
  componentId: string,
  operation: string,
  originalFiles: { path: string; content: string }[],
  firstAttemptFiles: CompiledFileChange[],
  firstFailureReason: string,
  targetDir: string = process.cwd(),
  deps: Partial<HealDeps> = {}
): Promise<HealResult> {
  const callRepair = deps.classifyRepair ?? classifyRepair;
  const verify = deps.verify ?? verifyInSandbox;
  const attempts: HealAttemptLog[] = [{ attempt: 0, result: "fail", reason: firstFailureReason }];

  const currentByPath = new Map(originalFiles.map((f) => [f.path, f.content]));
  for (const f of firstAttemptFiles) currentByPath.set(f.path, f.new_content);
  let lastReason = firstFailureReason;

  // §E-OSC oscillation guard — see recovery/oscillation_guard.ts. Fresh
  // instance per runSelfHealingLoop invocation, same as before consolidation.
  const oscillationGuard = new OscillationGuard();
  // F07-06: the state that just failed counts as already tried, so a round that puts it back is not verified again.
  oscillationGuard.seed([...currentByPath.entries()].map(([path, content]) => ({ path, content })));
  // E3c: the states this loop saw fail, for escalation. The starting state failed before the loop began.
  const triedStates: { path: string; content: string }[][] = [[...currentByPath.entries()].map(([path, content]) => ({ path, content }))];

  // AI-12: one ledger line per finished round, so the next prompt shows what was tried without repeating earlier failure bodies.
  let ledger: LedgerEntry[] = [];
  const earlyStop = healEarlyStopEnabled();

  const partialPaths = new Set<string>();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n🩹 Self-healing attempt ${attempt}/${MAX_ATTEMPTS}...`);
    const failingSnapshot = [...currentByPath.entries()].map(([path, content]) => ({ path, content }));

    // AI-12: the prompt carries the shaped failure (errors in the files the patch touched, a count of the rest), never the raw
    // tool output, and every piece of it passes the input scan. `lastReason` stays raw: it is what attempts[] and escalation get.
    const shaped = shapeFailure(lastReason, { touchedPaths: touchedPaths(originalFiles, currentByPath), files: failingSnapshot });
    const scan = { componentId, operation, stage: "self_heal" as const, attempt };
    const failureText = sanitizeAndRecord(shaped.text, { ...scan, source: "failure" });
    const ledgerText = sanitizeAndRecord(renderLedger(ledger), { ...scan, source: "ledger" });
    const finishRound = (outcome: LedgerOutcome, kinds: string[], target: string | null, next?: ShapedFailure): void => {
      ledger = appendLedger(ledger, {
        round: attempt,
        kinds,
        target,
        outcome,
        ...(next ? { errorClass: next.errorClass, location: firstLocation(next) } : outcome === "edits did not apply" ? { errorClass: "apply" as const } : outcome === "no usable reply" ? { errorClass: "call" as const } : {}),
      });
    };

    let repair;
    try {
      repair = await callRepair(componentId, operation, failingSnapshot, failureText, attempt, {
        ...(ledgerText !== "" ? { ledger: ledgerText } : {}),
        locations: shaped.locations,
      });
    } catch (err) {
      const reason = `repair classification threw: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`   ❌ ${reason}`);
      attempts.push({ attempt, result: "fail", reason });
      finishRound("no usable reply", [], null);
      continue;
    }
    const kinds = repair.edits.map((e) => e.kind);
    const target = repair.edits[0]?.path ?? null;

    console.log(`   Reasoning: ${repair.reasoning}`);
    const repairResult = applyEdits(repair.edits, failingSnapshot);
    recordAnchorOutcome(componentId, repairResult);
    // Every applied round builds on the one before, so a flag from an earlier round still describes the final text.
    if (repairResult.ok) for (const p of repairResult.partialLinePaths ?? []) partialPaths.add(p);
    if (!repairResult.ok) {
      console.log(`   ❌ repair edits didn't apply: ${repairResult.reason}`);
      attempts.push({ attempt, result: "fail", reason: repairResult.reason, reasoning: repair.reasoning });
      finishRound(repair.edits.length === 0 ? "no edits proposed" : "edits did not apply", kinds, target);
      continue;
    }

    const { candidateFiles, oscillation } = applyEditsAndCheckOscillation(currentByPath, repairResult.files, oscillationGuard);

    if (oscillation.hit) {
      console.log(`   🔁 ${oscillation.reason}`);
      attempts.push({ attempt, result: "fail", reason: oscillation.reason, reasoning: repair.reasoning });
      finishRound("same state as before", kinds, target);
      // The states verified before this round still failed; escalation needs them (the repeated one is not added: it was never verified twice).
      return { ok: false, attempts, triedStates };
    }

    const verification = verify(componentId, candidateFiles, targetDir);
    if (verification.status === "pass") {
      console.log(`   ✅ attempt ${attempt} passes verification.`);
      recordEvent("verification_pass", { component_id: componentId, operation, detail: { stage: "self_heal", attempt, isolation: verification.isolation, ...(verification.notTested ? { not_tested: verification.notTested } : {}), ...searchCutDetail(verification), ...securityNotesDetail(verification) } });
      attempts.push({ attempt, result: "pass", reasoning: repair.reasoning });
      return { ok: true, files: candidateFiles, attempts, verification, ...(partialPaths.size > 0 ? { partialLinePaths: [...partialPaths] } : {}) };
    }

    // A8-1: a check that could not run says nothing about the code, and the next round would send the same unfixable problem to the model.
    const stop = infrastructureStopOf(verification);
    if (stop) {
      recordEvent("verification_failure", { component_id: componentId, operation, detail: { stage: "self_heal", attempt, reason: verification.reason, infrastructure: stop.kind, repair_skipped: true } });
      attempts.push({ attempt, result: "fail", reason: verification.reason, reasoning: repair.reasoning });
      return { ok: false, attempts, infrastructureStop: { ...stop, attempt } };
    }

    console.log(`   ❌ still failing: ${verification.reason}`);
    triedStates.push(candidateFiles.map((f) => ({ path: f.path, content: f.new_content })));
    recordEvent("verification_failure", { component_id: componentId, operation, detail: { stage: "self_heal", attempt, reason: verification.reason } });
    const previous = shaped;
    lastReason = verification.reason;
    attempts.push({ attempt, result: "fail", reason: verification.reason, reasoning: repair.reasoning });

    // The failure after this round, shaped the same way, for the ledger and for the early-stop check.
    const after = shapeFailure(lastReason, { touchedPaths: touchedPaths(originalFiles, new Map(candidateFiles.map((f) => [f.path, f.new_content]))), files: candidateFiles.map((f) => ({ path: f.path, content: f.new_content })) });
    finishRound("verification failed", kinds, target, after);
    if (earlyStop && sameFailurePlace({ errorClass: previous.errorClass, location: firstLocation(previous) }, { errorClass: after.errorClass, location: firstLocation(after) })) {
      recordEvent("repair_early_stop", {
        component_id: componentId,
        operation,
        detail: { stage: "self_heal", attempt, error_class: after.errorClass, location: firstLocation(after) },
      });
      // No console output here (core returns data), and no extra attempt entry: the last entry's reason is the real failure, and escalation is handed that.
      return { ok: false, attempts, triedStates, stoppedEarly: { attempt, errorClass: after.errorClass, location: firstLocation(after) } };
    }
  }

  console.log(`\n🛑 Self-healing capped at ${MAX_ATTEMPTS} attempts — handing back to you. No real files were touched.`);
  return { ok: false, attempts, triedStates };
}