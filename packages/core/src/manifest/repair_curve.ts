// src/manifest/repair_curve.ts
//
// AI-16 (PURIX-33), measurement only: how many repair rounds does a fix take?
//
// The plan's question for AI-16 is "should repair run on the high tier, resample, stop earlier or use fewer rounds", and its
// evidence column asks for a success-by-round curve. The events table already carries that: every self-heal round writes a
// `verification_pass` or `verification_failure` event with `detail.stage === "self_heal"` and `detail.attempt`. This module
// reads those events and does nothing else. It changes no default (tier, round cap and early stop stay as they are) and
// makes no recommendation; it only says what the recorded runs show.
//
// Limits, stated so the number is not over-read:
//  - A round that ends without a recorded event (the oscillation guard stopping the loop, a provider error, a refused patch)
//    leaves no event, so an episode that ended that way counts as "not fixed", the same as one that used every round.
//  - Episodes are cut per component: a new episode starts when a component's attempt number does not go up.
//  - The tier a repair ran on is in the call log, not in the events, so a tier comparison needs two separate windows of runs
//    (for example one with PURIX_TIER_REPAIR=high), not one mixed table.
//
// Pure function over event rows; no I/O, no console output.

export interface RepairEventRow {
  kind: string;
  component_id: string | null;
  detail: Record<string, unknown>;
}

export interface RepairCurve {
  /** Self-heal episodes seen: one per run of repair rounds on one component. */
  episodes: number;
  /** fixedAtRound[k-1] is the number of episodes whose passing round was round k. */
  fixedAtRound: number[];
  /** Episodes with no passing round recorded. */
  notFixed: number;
}

interface Open { lastAttempt: number; passed: boolean }

function attemptOf(e: RepairEventRow): number | null {
  const d = e.detail;
  if (d?.stage !== "self_heal") return null;
  const a = d.attempt;
  return typeof a === "number" && Number.isInteger(a) && a >= 1 ? a : null;
}

/** Events must be in time order, as `listEvents` returns them. */
export function buildRepairCurve(events: RepairEventRow[]): RepairCurve {
  const fixedAtRound: number[] = [];
  let episodes = 0;
  let notFixed = 0;
  const open = new Map<string, Open>();

  const close = (o: Open) => { if (!o.passed) notFixed++; };

  for (const e of events) {
    if (e.kind !== "verification_pass" && e.kind !== "verification_failure") continue;
    const attempt = attemptOf(e);
    if (attempt === null) continue;
    const id = e.component_id ?? "";
    let cur = open.get(id);
    if (cur && attempt <= cur.lastAttempt) { close(cur); cur = undefined; }
    if (!cur) { cur = { lastAttempt: 0, passed: false }; open.set(id, cur); episodes++; }
    cur.lastAttempt = attempt;
    if (e.kind === "verification_pass") {
      cur.passed = true;
      while (fixedAtRound.length < attempt) fixedAtRound.push(0);
      fixedAtRound[attempt - 1]! += 1;
      open.delete(id);
    }
  }
  for (const o of open.values()) close(o);
  return { episodes, fixedAtRound, notFixed };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

/** `repair` is the recorded spend and call count of the `repair` call type, when the call log has any. */
export function formatRepairCurve(c: RepairCurve, repair?: { calls: number; costUsd: number }): string {
  if (c.episodes === 0) return "Repair rounds: no self-heal episodes recorded yet.";
  const fixed = c.episodes - c.notFixed;
  const lines = [`Repair rounds: ${c.episodes} self-heal episode(s), ${fixed} fixed, ${c.notFixed} not fixed.`];
  let cum = 0;
  for (let i = 0; i < c.fixedAtRound.length; i++) {
    cum += c.fixedAtRound[i]!;
    lines.push(`  round ${i + 1}: ${c.fixedAtRound[i]} fixed here; ${cum} of ${c.episodes} (${pct(cum / c.episodes)}) fixed by the end of this round`);
  }
  if (repair && repair.calls > 0 && fixed > 0) {
    lines.push(`  Spend: $${repair.costUsd.toFixed(4)} over ${repair.calls} recorded repair call(s), about $${(repair.costUsd / fixed).toFixed(4)} per fixed episode (all repair calls in the log, including those of episodes that were not fixed).`);
  }
  lines.push("  Evidence only: a round that ended without a recorded event counts as not fixed, and defaults (tier, round cap, early stop) are not changed by this report.");
  return lines.join("\n");
}
