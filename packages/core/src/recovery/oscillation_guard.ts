// src/recovery/oscillation_guard.ts
import { computeSyncHash } from "../state/hash.js";

/**
 * §E-OSC oscillation guard. Not true AST canonicalization (that's Bundle
 * D0, not built yet) — a plain content hash of the candidate file set is
 * enough to catch the specific failure mode this guards against: the
 * model proposing the exact same already-failed fix repeatedly.
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
export const OSCILLATION_THRESHOLD = 3;

export interface OscillationCheck {
  hit: boolean;
  hash: string;
  seenCount: number;
  reason?: string;
}

export class OscillationGuard {
  private readonly attemptHashCounts = new Map<string, number>();
  constructor(private readonly threshold: number = OSCILLATION_THRESHOLD) {}

  /**
   * Records one candidate file set and reports whether it has now been
   * proposed `threshold` or more times. Callers should abort on `hit`.
   */
  check(candidateFiles: { path: string; content: string }[]): OscillationCheck {
    const hash = computeSyncHash(candidateFiles.map((f) => ({ path: f.path, content: f.content })));
    const seenCount = (this.attemptHashCounts.get(hash) ?? 0) + 1;
    this.attemptHashCounts.set(hash, seenCount);

    if (seenCount >= this.threshold) {
      return {
        hit: true,
        hash,
        seenCount,
        reason: `oscillation guard: this exact candidate (hash ${hash.slice(0, 8)}…) has now been proposed ${seenCount} times — aborting instead of burning the rest of the retry budget on a repeat`,
      };
    }
    return { hit: false, hash, seenCount };
  }
}