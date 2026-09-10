// src/recovery/heal.ts
import { classifyRepair } from "../llm/classify.js";
import { applyEdits, type CompiledFileChange } from "../verify/compile.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { recordEvent } from "../manifest/events.js";
import { OscillationGuard } from "./oscillation_guard.js";

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
  targetDir: string = process.cwd()
): Promise<HealResult> {
  const attempts: HealAttemptLog[] = [{ attempt: 0, result: "fail", reason: firstFailureReason }];

  const currentByPath = new Map(originalFiles.map((f) => [f.path, f.content]));
  for (const f of firstAttemptFiles) currentByPath.set(f.path, f.new_content);
  let lastReason = firstFailureReason;

  // §E-OSC oscillation guard — see recovery/oscillation_guard.ts. Fresh
  // instance per runSelfHealingLoop invocation, same as before consolidation.
  const oscillationGuard = new OscillationGuard();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n🩹 Self-healing attempt ${attempt}/${MAX_ATTEMPTS}...`);
    const failingSnapshot = [...currentByPath.entries()].map(([path, content]) => ({ path, content }));

    let repair;
    try {
      repair = await classifyRepair(componentId, operation, failingSnapshot, lastReason, attempt);
    } catch (err) {
      const reason = `repair classification threw: ${err instanceof Error ? err.message : err}`;
      console.log(`   ❌ ${reason}`);
      attempts.push({ attempt, result: "fail", reason });
      continue;
    }

    console.log(`   Reasoning: ${repair.reasoning}`);
    const repairResult = applyEdits(repair.edits, failingSnapshot);
    if (!repairResult.ok) {
      console.log(`   ❌ repair edits didn't apply: ${repairResult.reason}`);
      attempts.push({ attempt, result: "fail", reason: repairResult.reason, reasoning: repair.reasoning });
      continue;
    }

    for (const f of repairResult.files) currentByPath.set(f.path, f.new_content);
    const candidateFiles = [...currentByPath.entries()].map(([path, new_content]) => ({ path, new_content }));

    const oscillation = oscillationGuard.check(candidateFiles.map((f) => ({ path: f.path, content: f.new_content })));
    if (oscillation.hit) {
      console.log(`   🔁 ${oscillation.reason}`);
      attempts.push({ attempt, result: "fail", reason: oscillation.reason, reasoning: repair.reasoning });
      return { ok: false, attempts };
    }

    const verification = verifyInSandbox(componentId, candidateFiles, targetDir);
    if (verification.status === "pass") {
      console.log(`   ✅ attempt ${attempt} passes verification.`);
      recordEvent("verification_pass", { component_id: componentId, operation, detail: { stage: "self_heal", attempt } });
      attempts.push({ attempt, result: "pass", reasoning: repair.reasoning });
      return { ok: true, files: candidateFiles, attempts };
    }

    console.log(`   ❌ still failing: ${verification.reason}`);
    recordEvent("verification_failure", { component_id: componentId, operation, detail: { stage: "self_heal", attempt, reason: verification.reason } });
    lastReason = verification.reason;
    attempts.push({ attempt, result: "fail", reason: verification.reason, reasoning: repair.reasoning });
  }

  console.log(`\n🛑 Self-healing capped at ${MAX_ATTEMPTS} attempts — handing back to you. No real files were touched.`);
  return { ok: false, attempts };
}