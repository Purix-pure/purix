// src/recovery/oscillation_guard.ts
import { computeSyncHash } from "../state/hash.js";
import type { CompiledFileChange } from "../verify/compile.js";

/**
 * §E-OSC oscillation guard. Not true AST canonicalization (that's Bundle
 * D0, not built yet) — a plain content hash of the candidate file set is
 * enough to catch the specific failure mode this guards against: the
 * model proposing a candidate that was already tried and failed.
 *
 * F07-06 (research 07 section 2.2 option E, decision D24): the guard used to fire on the THIRD sighting of a candidate. The repair
 * loop runs three rounds and escalation two, so it could only fire when the model sent the very same edit three times; A, B, A
 * and a no-change edit went through to verification again (experiment E3). It now fires on the SECOND sighting, and the state being
 * repaired is entered as already seen (`seed`), so an edit that puts the failing code back, or changes nothing, stops at once.
 * The reason: verification of an identical file set is deterministic, so a candidate that already failed cannot pass the second
 * time, and the round would cost a model call and a whole-project verification for nothing.
 * Known limit: a check that fails for a reason outside the code (a flaky test) can pass on a repeat. Infrastructure failures
 * (missing tool, labelled timeout, output limit) end the loop before this point (recovery/infrastructure_stop.ts), and the test
 * runner's own baseline compare (verify/tests.ts, F06-02) handles tests that fail without this change. Not measured on a real model.
 *
 * Previously implemented twice, near-identically, in escalate.ts (§E-OSC,
 * threshold 3, keyed per-call) and heal.ts (same threshold, same
 * mechanism, comment pointing back at escalate.ts as "the fuller
 * rationale"). Consolidated here so the threshold, hash function, and
 * message only exist in one place — a change to any of those previously
 * had to be made twice or silently drifted.
 *
 * Each caller creates its own guard (a fresh Map per runEscalation /
 * runSelfHealingLoop invocation) — this is about thrashing within one
 * escalation or heal run, not persisted across separate runs days apart.
 */
export const OSCILLATION_THRESHOLD = 2;

export interface OscillationCheck {
  hit: boolean;
  hash: string;
  seenCount: number;
  reason?: string;
}

export class OscillationGuard {
  private readonly attemptHashCounts = new Map<string, number>();
  private readonly seeded = new Set<string>();
  constructor(private readonly threshold: number = OSCILLATION_THRESHOLD) {}

  /** Enters a state that was already tried (the failing state a loop starts from) so that proposing it again counts as a repeat. */
  seed(files: { path: string; content: string }[]): void {
    const hash = computeSyncHash(files.map((f) => ({ path: f.path, content: f.content })));
    this.attemptHashCounts.set(hash, (this.attemptHashCounts.get(hash) ?? 0) + 1);
    this.seeded.add(hash);
  }

  /**
   * Records one candidate file set and reports whether it has now been
   * proposed `threshold` or more times (a seeded state counts as one). Callers should abort on `hit`.
   */
  check(candidateFiles: { path: string; content: string }[]): OscillationCheck {
    const hash = computeSyncHash(candidateFiles.map((f) => ({ path: f.path, content: f.content })));
    const seenCount = (this.attemptHashCounts.get(hash) ?? 0) + 1;
    this.attemptHashCounts.set(hash, seenCount);

    if (seenCount >= this.threshold) {
      const which = this.seeded.has(hash) ? "the state that was being repaired" : `a candidate that was proposed ${seenCount} times`;
      return {
        hit: true,
        hash,
        seenCount,
        reason: `oscillation guard: this exact candidate (hash ${hash.slice(0, 8)}…) was already tried in this run (${which}) and failed — not verifying it again, instead of burning the rest of the retry budget on a repeat`,
      };
    }
    return { hit: false, hash, seenCount };
  }
}

/**
 * Merges one round of applied edits into the running file map and checks
 * the result against `guard` in one step. Both runEscalation and
 * runSelfHealingLoop repeated this exact sequence — mutate the map with
 * the newly-applied files, rebuild the full candidate list from it, then
 * hand that to the guard — as their own inline code (see audit finding
 * 2.8); this is that sequence, kept next to the guard it drives so the
 * two can't drift the way the guard classes themselves once had.
 */
export function applyEditsAndCheckOscillation(
  currentByPath: Map<string, string>,
  appliedFiles: CompiledFileChange[],
  guard: OscillationGuard
): { candidateFiles: CompiledFileChange[]; oscillation: OscillationCheck } {
  for (const f of appliedFiles) currentByPath.set(f.path, f.new_content);
  const candidateFiles: CompiledFileChange[] = [...currentByPath.entries()].map(([path, new_content]) => ({ path, new_content }));
  const oscillation = guard.check(candidateFiles.map((f) => ({ path: f.path, content: f.new_content })));
  return { candidateFiles, oscillation };
}