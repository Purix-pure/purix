// packages/core/src/recovery/infrastructure_stop.ts
//
// A8-1 (research 07 finding 1, D07): a verification that could not run is not a failure of the code, so no edit can fix it and
// no model call should be spent on it. This module is the one place that decides which results those are, for the repair loop,
// escalation and resolveVerification alike.
//
// Two sources, kept apart on purpose:
//   1. The stage said so. A "not_installed" status, or a "fail" carrying A1's `infrastructure` kind. Reliable; acted on at once.
//   2. Only the text says so ("timed out"). A timeout is ambiguous: the machine may be slow, or the new code may loop forever.
//      Text alone never stops a repair. resolveVerification re-runs the check and compares with the original code first.
import type { InfrastructureKind } from "../verify/outcome.js";
import type { VerificationResult } from "../verify/verify.js";
import { shapeFailure } from "../verify/failure_shape.js";

export interface InfrastructureStop {
  kind: InfrastructureKind;
  /** What the stage reported, unchanged. */
  reason: string;
  /** What to do about it, when the stage knew (today only a missing tool). */
  actionHint?: string;
  /** True when Purix could not rule out that the change caused it (a timeout with no original to compare with). The message then makes no claim about the change. */
  ambiguous?: boolean;
}

/** The result of a stage that could not run its check, or undefined for a pass, a code failure and a policy block. */
export function infrastructureStopOf(v: VerificationResult): InfrastructureStop | undefined {
  if (v.status === "not_installed") return { kind: "not_installed", reason: v.reason, ...(v.actionHint ? { actionHint: v.actionHint } : {}) };
  if (v.status === "fail" && !v.policyBlock && v.infrastructure) return { kind: v.infrastructure, reason: v.reason };
  return undefined;
}

/** A failure no stage labelled, whose output reads as a timeout. Ambiguous (see above): the caller must confirm before acting. */
export function isUnlabelledTimeout(v: VerificationResult): boolean {
  if (v.status !== "fail" || v.policyBlock || v.infrastructure) return false;
  return shapeFailure(v.reason, { touchedPaths: [], files: [] }).errorClass === "timeout";
}

/** The `infrastructure` field callers get on a failure: the kind and, when known, what to do. */
export function infrastructureOf(stop: InfrastructureStop): { kind: InfrastructureKind; actionHint?: string } {
  return { kind: stop.kind, ...(stop.actionHint ? { actionHint: stop.actionHint } : {}) };
}

/** Words for the person: what happened, that nothing was spent, and (unless it is unknown) that it is not their change. */
export function stopMessage(stop: InfrastructureStop): string {
  const hint = stop.actionHint ? `\n  ${stop.actionHint}` : "";
  const tail = stop.ambiguous ? "Nothing was repaired and no model was called." : "Nothing was repaired and no model was called: this is not a problem with your change.";
  return `${stop.reason}\n\n  ${tail}${hint}`;
}

/** Two runs of the check timed out and so did the original code: the machine or the test setup, not the change. */
export function timedOutWithOriginal(): InfrastructureStop {
  return {
    kind: "timeout",
    reason:
      "Verification timed out twice, and the original code timed out as well. That points to a hung test or a slow machine, not to your change.",
    actionHint: "Check for a test that never finishes or a busy machine, then run the change again.",
  };
}

/** Two runs timed out and there is no original to compare with (a new file): Purix cannot tell the two causes apart. */
export function timedOutNoBaseline(): InfrastructureStop {
  return {
    kind: "timeout",
    reason:
      "Verification timed out twice. The change adds a new file, so there is no original code to compare with and Purix could not tell whether the machine is slow or the new code never finishes.",
    actionHint: "Run the tests for this component yourself to see which it is.",
    ambiguous: true,
  };
}
