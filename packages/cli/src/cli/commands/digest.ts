// src/cli/commands/digest.ts
//
// `purix digest`: a short summary of the last N days of this project's record, set beside the N days before. It reads the same
// record as the dashboard, `watch` and the result line (core observe/ledger_reader.ts) and changes nothing.
//
// Wording rule of the observability layer: say what was measured. Never "safe", "correct" or "fixed". A figure that was not recorded
// is "not recorded", never zero. Dollars are an estimate (the provider's price table times the tokens Purix counted) and say so.
import type { Command } from "commander";
import type { ProjectSummary } from "@purix/core/observe/ledger_reader";
import { STOP_KINDS } from "@purix/core/observe/ledger_reader";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface DigestOptions { days: number; now: Date; version: string }
export interface Window { since: string; until: string }

/** The period (the last `days` days up to `now`) and the one of equal length before it. They touch and never overlap: `since` is inclusive, `until` is not. */
export function digestWindows(now: Date, days: number): { current: Window; previous: Window } {
  const end = now.getTime();
  const mid = end - days * DAY_MS;
  const start = mid - days * DAY_MS;
  const iso = (t: number) => new Date(t).toISOString();
  return { current: { since: iso(mid), until: iso(end) }, previous: { since: iso(start), until: iso(mid) } };
}

const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

export type Coverage =
  | { kind: "full" }
  | { kind: "partial"; firstEventAt: string }
  | { kind: "none"; firstEventAt: string | null };

/**
 * How much of the period before the record covers. The record starts at its oldest event; events older than the log retention are
 * deleted. Both a young project and a short retention look the same from here, so the wording names only what is known: where the
 * record starts. An older period with no record behind it is not shown as "0 the period before".
 */
export function digestCoverage(firstEventAt: string | null, now: Date, days: number): Coverage {
  const w = digestWindows(now, days);
  if (firstEventAt === null || firstEventAt >= w.current.since) return { kind: "none", firstEventAt };
  if (firstEventAt > w.previous.since) return { kind: "partial", firstEventAt };
  return { kind: "full" };
}

const fullDay = (iso: string) => { const d = new Date(iso); return `${day(d)} ${d.getUTCFullYear()}`; };

/** The digest text. `previous` is null when there is no earlier record to compare with. Pure: two summaries in, text out. */
export function formatDigest(current: ProjectSummary, previousIn: ProjectSummary | null, o: DigestOptions): string {
  const coverage = digestCoverage(current.firstEventAt, o.now, o.days);
  const previous = coverage.kind === "none" ? null : previousIn;
  const from = new Date(o.now.getTime() - o.days * DAY_MS);
  const out: string[] = [];
  out.push(`Purix digest: ${day(from)} to ${day(o.now)} ${o.now.getUTCFullYear()} (${o.days} days)`);
  out.push("");

  out.push(`Changes landed: ${current.changesLandedInRange}${previous ? ` (${previous.changesLandedInRange} the period before)` : ""}`);
  const fa = current.firstAttemptPass;
  if (fa.of > 0) out.push(`Passed checks first time: ${fa.passed} of ${fa.of} verified changes`);

  const t = current.tests;
  if (t.verificationsWithCounts === 0 && t.verificationsWithoutCounts === 0) {
    out.push("Tests: none recorded in this period");
  } else {
    const noCounts = t.verificationsWithoutCounts > 0 ? `; ${t.verificationsWithoutCounts} run(s) did not record test counts` : "";
    out.push(`Tests: ${t.totals.passed} tests passed, ${t.totals.failed} failed, ${t.totals.skipped} skipped across ${t.verificationsWithCounts} verified run(s)${noCounts}`);
  }

  const s = current.stopped;
  if (s.total === 0) {
    out.push("Stopped before landing: none");
  } else {
    out.push(`Stopped before landing: ${s.total}${previous ? ` (${previous.stopped.total} the period before)` : ""}`);
    for (const [kind, n] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
      out.push(`  ${n} × ${(STOP_KINDS as Record<string, string>)[kind] ?? kind}`);
    }
  }

  const a = current.approvals;
  if (a.asked > 0) {
    const wait = a.medianWaitMs !== null ? `median wait ${secs(a.medianWaitMs)}` : "wait not recorded";
    out.push(`Approvals: ${a.asked} asked, ${a.approved} approved, ${a.denied} declined, ${wait}`);
  }

  if (current.spend) {
    const sp = current.spend;
    out.push(`Estimated spend: ${usd(sp.spentUsd)} of a ${usd(sp.ceilingUsd)} ceiling (${usd(sp.leftUsd)} left)`);
  } else {
    out.push("Spend: none recorded");
  }

  const sec = current.secretsRemoved;
  if (sec.outbound + sec.inbound > 0) out.push(`Secrets removed from model traffic: ${sec.outbound} from prompts, ${sec.inbound} from replies`);
  if (current.rolledBack.total > 0) out.push(`Changes undone by Purix after a failed write: ${current.rolledBack.total}${current.rolledBack.undoFailed > 0 ? `, ${current.rolledBack.undoFailed} where the undo itself failed (run purix reconcile)` : ""}`);

  const au = current.lastAudit;
  if (au) {
    const vuln = au.vulnFindings !== null ? `${au.vulnFindings} known-vulnerability finding(s)` : `vulnerability scan not run (${au.vulnReason ?? "no reason recorded"})`;
    const idiom = au.idiomFindings !== null ? `${au.idiomFindings} style finding(s)` : `style check not run (${au.idiomReason ?? "no reason recorded"})`;
    out.push(`Last audit: ${au.pinningFindings} unpinned-dependency finding(s), ${vuln}, ${idiom}`);
  }

  const r = current.rework;
  out.push(r.considered === 0
    ? "Rework (all time): nothing old enough to judge yet"
    : `Rework (all time): ${r.reworked} of ${r.considered} landed changes had another change to the same component within ${r.windowDays} days${r.tooRecent > 0 ? `; ${r.tooRecent} too recent to judge` : ""}. A correlation, not a cause.`);

  const fb = current.feedback;
  if (fb.helped + fb.notHelped > 0) out.push(`Your own answers: ${fb.helped} helped, ${fb.notHelped} did not`);

  if (coverage.kind === "partial") {
    out.push("");
    out.push(`Note: the record starts on ${fullDay(coverage.firstEventAt)}, so the period before is only partly covered and its figures are lower bounds, not a like-for-like comparison. Older events are deleted after the log retention period (365 days unless changed in the scheduler settings).`);
  } else if (coverage.kind === "none") {
    out.push("");
    out.push(coverage.firstEventAt === null
      ? "Note: no events are recorded yet, so there is nothing to compare with."
      : `Note: the record starts on ${fullDay(coverage.firstEventAt)}, inside this period, so there is nothing earlier to compare with.`);
  }

  out.push("");
  out.push(`Source: this project's local record, read-only. Purix ${o.version}.`);
  return out.join("\n");
}

export function registerDigestCommand(program: Command) {
  program
    .command("digest")
    .description("Summarise the last days of this project's record beside the period before (read-only, nothing leaves this machine)")
    .option("--days <n>", "length of the period in days, 1 to 90", "7")
    .option("--json", "print the two periods' summaries as JSON (the numbers behind the text, so they can be recomputed)")
    .action(async (opts: { days: string; json?: boolean }) => {
      const { EXIT } = await import("@purix/core/cli-io/exit_codes");
      const days = Number(opts.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        console.error("Bad input: --days must be a whole number from 1 to 90.");
        process.exitCode = EXIT.USAGE;
        return;
      }
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
      const { openLedger } = await import("@purix/core/observe/ledger_reader");
      const { resolveSharedStateDir } = await import("@purix/core/state/git_common_dir");
      const { PURIX_VERSION } = await import("../../version.js");
      const ledger = openLedger(resolveSharedStateDir());
      if (!ledger) { console.log("No Purix record could be read here."); return; }
      try {
        const now = new Date();
        const w = digestWindows(now, days);
        const current = ledger.summary(w.current);
        const previous = ledger.summary(w.previous);
        if (opts.json) console.log(JSON.stringify({ purixVersion: PURIX_VERSION, days, generatedAt: now.toISOString(), windows: w, current, previous }, null, 2));
        else console.log(formatDigest(current, previous, { days, now, version: PURIX_VERSION }));
      } finally {
        ledger.close();
      }
    });
}
