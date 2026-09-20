// src/recovery/resolve_verification.ts
//
// Extracted from packages/cli/src/cli/commands/lifecycle.ts, where the
// "run the sandbox verifier, and on failure fall through to capped
// self-healing and then escalation" sequence was duplicated almost
// verbatim between the `modify` command's direct-patch branch and the
// `ingest` command's diff-apply branch (see audit finding 2.1). Both
// call sites converge on the same Node 6 Verifier / §6.1 self-healing /
// §6.3 escalation flow per Principle 12 (author-agnostic verification —
// nothing downstream gets a special case for where the candidate files
// came from), so this is genuinely one algorithm, not two similar ones.
//
// This does NOT attempt to also unify the Node 4 Patch Compiler step
// that precedes it (compilePatch's own "no deterministic transform"
// escalation path in `modify`), since that step's shape differs
// meaningfully from `ingest`'s (which has no compiler step at all — the
// diff's own content already *is* the candidate). Forcing that into the
// same helper would trade a little duplication for the wrong kind of
// abstraction (per Sandi Metz's observation, cited in the audit report,
// that a forced-together abstraction over two genuinely different things
// costs more than the duplication it removes).

import { verifyInSandbox, type SandboxVerificationResult } from "../sandbox/sandbox.js";
import { runSelfHealingLoop } from "./heal.js";
import { runEscalation } from "./escalate.js";
import { recordEvent } from "../manifest/events.js";
import type { CompiledFileChange } from "../verify/compile.js";

export interface ResolveVerificationResult {
  finalFiles: { path: string; new_content: string }[];
  fromEscalation: boolean;
  verification: SandboxVerificationResult;
}

export interface ResolveVerificationFailure {
  ok: false;
  reason?: string;
}

/**
 * Runs the sandbox verifier against `candidateFiles`; on failure, falls
 * through to the capped self-healing loop, and on that loop's exhaustion,
 * to escalation. Returns the working file set to commit, or a failure the
 * caller should report and abort on (escalation itself failing — there is
 * nothing further to fall back to).
 *
 * `verificationStageLabel` and `escalationInstruction` are the two things
 * that legitimately vary between callers: the former is only used for the
 * `verification_pass`/`verification_failure` event's `stage` detail (e.g.
 * "direct_patch" vs "direct_ingest"), and the latter is the human-readable
 * description of intent passed to escalation's own prompt (an instruction
 * string for the Instruction Path, a synthesized description of the diff
 * for Diff Ingestion — escalation has no other way to know why these
 * files should end up looking a certain way).
 */
export async function resolveVerification(
  componentId: string,
  operation: string,
  originalFiles: { path: string; content: string }[],
  candidateFiles: { path: string; new_content: string }[],
  verificationStageLabel: string,
  escalationInstruction: string,
  targetDir: string
): Promise<ResolveVerificationResult | ResolveVerificationFailure> {
  const verification = verifyInSandbox(componentId, candidateFiles, targetDir);

  if (verification.status === "pass") {
    recordEvent("verification_pass", {
      component_id: componentId,
      operation,
      detail: { stage: verificationStageLabel, isolation: verification.isolation },
    });
    return { finalFiles: candidateFiles, fromEscalation: false, verification };
  }

  console.log(`\n  ❌ Verification failed: ${verification.reason}`);
  recordEvent("verification_failure", {
    component_id: componentId,
    operation,
    detail: { stage: verificationStageLabel, reason: verification.reason },
  });

  const compiledCandidates: CompiledFileChange[] = candidateFiles.map((f) => ({ path: f.path, new_content: f.new_content }));

  const healed = await runSelfHealingLoop(componentId, operation, originalFiles, compiledCandidates, verification.reason, targetDir);
  if (healed.ok) {
    return {
      finalFiles: healed.files!.map((f) => ({ path: f.path, new_content: f.new_content })),
      fromEscalation: false,
      verification,
    };
  }

  const lastReason = healed.attempts[healed.attempts.length - 1]?.reason ?? "self-healing exhausted";
  const esc = await runEscalation(componentId, operation, escalationInstruction, originalFiles, lastReason, targetDir);
  if (!esc.ok) {
    return { ok: false, reason: esc.reason };
  }
  return {
    finalFiles: esc.files!.map((f) => ({ path: f.path, new_content: f.new_content })),
    fromEscalation: true,
    verification,
  };
}
