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

import { prefetchDependencyLookup } from "../security/dep_lookup.js";
import { verifyInSandbox, type SandboxVerificationResult } from "../sandbox/sandbox.js";
import { runSelfHealingLoop } from "./heal.js";
import { runEscalation } from "./escalate.js";
import { recordEvent } from "../manifest/events.js";
import type { CompiledFileChange } from "../verify/compile.js";
import type { InfrastructureKind } from "../verify/outcome.js";
import { searchCutDetail, securityNotesDetail } from "../verify/discovery_cut.js";
import {
  infrastructureOf,
  infrastructureStopOf,
  isUnlabelledTimeout,
  stopMessage,
  timedOutNoBaseline,
  timedOutWithOriginal,
  type InfrastructureStop,
} from "./infrastructure_stop.js";

export interface ResolveVerificationResult {
  finalFiles: { path: string; new_content: string }[];
  fromEscalation: boolean;
  verification: SandboxVerificationResult;
  /** C3: paths where a repair- or escalation-authored anchor left part of a line in place. Absent when none did. */
  partialLinePaths?: string[];
}

export interface ResolveVerificationFailure {
  ok: false;
  reason?: string;
  /** A8-1: set only when the check could not run (tool missing, timeout, output limit, resource limit) and so nothing was repaired. Not a failure of the code, unless `reason` says Purix could not tell. */
  infrastructure?: { kind: InfrastructureKind; actionHint?: string };
}

/** Seams for tests: the sandbox and the two repair stages. Production callers pass nothing and get the real ones. */
export interface ResolveVerificationDeps {
  verify: typeof verifyInSandbox;
  runSelfHealingLoop: typeof runSelfHealingLoop;
  runEscalation: typeof runEscalation;
}

/**
 * The original contents of exactly the files the candidate touches, to verify as a baseline, or undefined when the candidate adds
 * a file (there is no original to compare that one with).
 */
function baselineOf(
  originalFiles: { path: string; content: string }[],
  candidateFiles: { path: string }[]
): { path: string; new_content: string }[] | undefined {
  if (candidateFiles.length === 0) return undefined;
  const before = new Map(originalFiles.map((f) => [f.path, f.content]));
  const out: { path: string; new_content: string }[] = [];
  for (const f of candidateFiles) {
    const content = before.get(f.path);
    if (content === undefined) return undefined;
    out.push({ path: f.path, new_content: content });
  }
  return out;
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
  targetDir: string,
  deps: Partial<ResolveVerificationDeps> = {},
  /** Files the change deletes: left out of the verification copy. A failing change that deletes files is not sent to repair (see below). */
  removedPaths: string[] = []
): Promise<ResolveVerificationResult | ResolveVerificationFailure> {
  const verify =
    deps.verify ??
    (removedPaths.length > 0
      ? ((id: string, files: Parameters<typeof verifyInSandbox>[1], dir: string) => verifyInSandbox(id, files, dir, undefined, removedPaths))
      : verifyInSandbox);
  // F03-03 / F03-02 (D-q): the gate is synchronous, so the lookup of what this change adds runs here first and the gate reads its cache.
  // Off unless PURIX_DEP_LOOKUP is set; never throws; a failed lookup means "not checked".
  await prefetchDependencyLookup(candidateFiles, targetDir);
  const heal = deps.runSelfHealingLoop ?? runSelfHealingLoop;
  const escalate = deps.runEscalation ?? runEscalation;
  let verification = verify(componentId, candidateFiles, targetDir);

  // A8-1: a check that could not run is not a failure of the code, so it never reaches repair. The stage usually says so itself
  // (a missing tool, or a kind label). A timeout that only shows in the text is ambiguous, because new code can loop forever: run the
  // check once more, and if it times out again, run the ORIGINAL code. If the original times out too it is the machine; if the
  // original is fine the change causes the hang, and that stays a code failure that repair may act on.
  let stop: InfrastructureStop | undefined = infrastructureStopOf(verification);
  if (!stop && isUnlabelledTimeout(verification)) {
    const again = verify(componentId, candidateFiles, targetDir);
    if (!isUnlabelledTimeout(again)) {
      verification = again;
      stop = infrastructureStopOf(again);
    } else {
      const baseline = baselineOf(originalFiles, candidateFiles);
      if (!baseline) {
        stop = timedOutNoBaseline();
      } else {
        const base = verify(componentId, baseline, targetDir);
        if (infrastructureStopOf(base) || isUnlabelledTimeout(base)) stop = timedOutWithOriginal();
      }
    }
  }

  if (verification.status === "pass") {
    recordEvent("verification_pass", {
      component_id: componentId,
      operation,
      detail: { stage: verificationStageLabel, isolation: verification.isolation, ...(verification.notTested ? { not_tested: verification.notTested } : {}), ...searchCutDetail(verification), ...securityNotesDetail(verification) },
    });
    return { finalFiles: candidateFiles, fromEscalation: false, verification };
  }

  console.log(`\n  ❌ Verification failed: ${verification.reason}`);
  recordEvent("verification_failure", {
    component_id: componentId,
    operation,
    detail: { stage: verificationStageLabel, reason: verification.reason, ...(stop ? { infrastructure: stop.kind, repair_skipped: true } : {}) },
  });

  if (stop) return { ok: false, reason: stopMessage(stop), infrastructure: infrastructureOf(stop) };

  // The repair loop and escalation verify their own candidates without knowing which files this change deletes, so a "pass" they
  // reached would be a check of a project that still holds the deleted files. A deletion that does not verify as it stands stops here.
  if (removedPaths.length > 0 && verification.status === "fail") {
    return {
      ok: false,
      reason: `${verification.reason}\n  (This change deletes ${removedPaths.join(", ")}, so no automatic repair was attempted. Fix what still refers to the deleted file(s), or keep them.)`,
    };
  }

  // A secret-scan or security-gate block is a policy decision, not a bug the
  // model can repair: retrying only spends tokens and, worse, invites the
  // model to re-emit the same content. Stop here with the real reason.
  if (verification.status === "fail" && verification.policyBlock) {
    return { ok: false, reason: verification.reason };
  }

  const compiledCandidates: CompiledFileChange[] = candidateFiles.map((f) => ({ path: f.path, new_content: f.new_content }));

  const healed = await heal(componentId, operation, originalFiles, compiledCandidates, verification.reason, targetDir);
  if (healed.ok) {
    return {
      finalFiles: healed.files!.map((f) => ({ path: f.path, new_content: f.new_content })),
      fromEscalation: false,
      // The verification the healed files PASSED, not the first failure: it carries isolation and
      // notTested, which callers print. (Falls back to the first result only for a stubbed loop.)
      verification: healed.verification ?? verification,
      ...(healed.partialLinePaths?.length ? { partialLinePaths: healed.partialLinePaths } : {}),
    };
  }

  // A8-1: a repair round could not run its check. Escalation would meet the same wall at a higher price, so stop here.
  if (healed.infrastructureStop) {
    const hs = healed.infrastructureStop;
    return {
      ok: false,
      reason: `${verification.reason}\n\n  Repair stopped at round ${hs.attempt} because the check could not run.\n\n  ${stopMessage(hs)}`,
      infrastructure: infrastructureOf(hs),
    };
  }

  const lastReason = healed.attempts[healed.attempts.length - 1]?.reason ?? "self-healing exhausted";
  // E3c: escalation starts from the original files, so without this its guard could not know the repair loop had already failed a state.
  const esc = await escalate(componentId, operation, escalationInstruction, originalFiles, lastReason, targetDir, undefined, { alreadyTried: healed.triedStates ?? [] });
  if (!esc.ok && esc.infrastructure) {
    return { ok: false, reason: `${verification.reason}\n\n  Escalation stopped because the check could not run.\n\n  ${esc.reason ?? ""}`, infrastructure: esc.infrastructure };
  }
  if (!esc.ok) {
    // Keep the ORIGINAL failure in the message: "escalation failed" alone hides
    // what actually went wrong (a type error, a broken test) from the person.
    return { ok: false, reason: `${verification.reason}\n\n  Self-healing and escalation could not produce a passing fix: ${esc.reason}` };
  }
  return {
    finalFiles: esc.files!.map((f) => ({ path: f.path, new_content: f.new_content })),
    fromEscalation: true,
    verification: esc.verification ?? verification,
    ...(esc.partialLinePaths?.length ? { partialLinePaths: esc.partialLinePaths } : {}),
  };
}
