// src/state/rework.ts
//
// Two counts the plan (Phase 5) asks for, each with its denominator and its limits stated.
//
//  1. Rework: a landed change whose component was changed again by Purix within a window (default 14 days). It reads the
//     hash-chained audit log, which holds one `component_change` record per landed change (identifiers and hashes only: no paths,
//     no lines, no diffs). So this is rework per component, not per line, and it only sees changes made through Purix. It is
//     not GitClear's churn (code reverted or significantly altered within two weeks: it takes the same 14-day window, nothing
//     else) and not DORA's deployment rework rate (the share of deployments that are unplanned fixes: Purix cannot tell a planned
//     follow-up from a fix, so a planned one counts too). It is a correlation with later changes, not proof the first was wrong.
//  2. Reverts: commits in git history that undo another commit. Purix has no revert command, so reverts only exist in git. A change
//     that Purix applied and then undid itself (a failed write or a manifest conflict) is a different thing: it never landed, it
//     is the `apply_rolled_back` event, and it is not counted here. Never add the two together.
//
// Pure functions over rows already read, plus one thin git reader. Nothing here writes.
import { spawnSync } from "../platform/spawn_sync.js";

export interface ChainRow {
  payload: string;
  timestamp: string;
}

export const DEFAULT_REWORK_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReworkResult {
  windowDays: number;
  /** Landed create/modify/ingest changes that could be judged. */
  considered: number;
  /** Of those, how many had another landed change on the same component inside the window. */
  reworked: number;
  /** Changes too recent to judge: the window has not closed yet at `asOf`. They are left out of both numbers, never counted as clean. */
  tooRecent: number;
}

interface Landed {
  component: string;
  kind: string;
  at: number;
}

function landedChanges(rows: ChainRow[]): Landed[] {
  const out: Landed[] = [];
  for (const row of rows) {
    let p: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(row.payload);
      if (typeof v !== "object" || v === null) continue;
      p = v as Record<string, unknown>;
    } catch {
      continue;
    }
    if (p["event"] !== "component_change" || typeof p["component_id"] !== "string" || typeof p["kind"] !== "string") continue;
    const at = Date.parse(row.timestamp);
    if (Number.isNaN(at)) continue;
    out.push({ component: p["component_id"], kind: p["kind"], at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Kinds that change a component's code. An adopt or a delete starts or ends a component's life; accepted drift is a person's edit. */
const JUDGED_KINDS = new Set(["create", "modify", "ingest"]);
/** A later change of any of these kinds on the same component counts as touching it again. */
const TOUCHING_KINDS = new Set(["modify", "ingest", "accept_drift", "delete"]);

export function reworkWithin(rows: ChainRow[], asOf: Date, windowDays: number = DEFAULT_REWORK_WINDOW_DAYS): ReworkResult {
  const landed = landedChanges(rows);
  const windowMs = windowDays * DAY_MS;
  let considered = 0;
  let reworked = 0;
  let tooRecent = 0;
  for (let i = 0; i < landed.length; i++) {
    const c = landed[i]!;
    if (!JUDGED_KINDS.has(c.kind)) continue;
    if (asOf.getTime() < c.at + windowMs) {
      tooRecent++;
      continue;
    }
    considered++;
    const again = landed.slice(i + 1).some((n) => n.component === c.component && TOUCHING_KINDS.has(n.kind) && n.at > c.at && n.at <= c.at + windowMs);
    if (again) reworked++;
  }
  return { windowDays, considered, reworked, tooRecent };
}

/**
 * The rework question for ONE landed change, for its receipt. Same rule as `reworkWithin`, asked about a single change:
 * did Purix land another change on the same component inside the window? "none_in_window" only means Purix saw none: edits made
 * outside Purix are not in the audit chain, and a later change may be a planned follow-up. A correlation, never a verdict.
 */
export type ChangeRework =
  | { state: "not_judged"; reason: string }
  | { state: "window_open"; closesAt: string; windowDays: number }
  | { state: "again"; daysLater: number; kind: string; windowDays: number }
  | { state: "none_in_window"; windowDays: number };

export function reworkOfChange(rows: ChainRow[], component: string, kind: string, landedAtIso: string, asOf: Date, windowDays: number = DEFAULT_REWORK_WINDOW_DAYS): ChangeRework {
  if (!JUDGED_KINDS.has(kind)) return { state: "not_judged", reason: `a "${kind}" change starts or ends a component's life or records a person's edit, so it is not judged` };
  const at = Date.parse(landedAtIso);
  if (Number.isNaN(at)) return { state: "not_judged", reason: "the landing time was not readable" };
  const windowMs = windowDays * DAY_MS;
  if (asOf.getTime() < at + windowMs) return { state: "window_open", closesAt: new Date(at + windowMs).toISOString(), windowDays };
  const next = landedChanges(rows).find((n) => n.component === component && TOUCHING_KINDS.has(n.kind) && n.at > at && n.at <= at + windowMs);
  if (!next) return { state: "none_in_window", windowDays };
  return { state: "again", daysLater: Math.max(0, Math.floor((next.at - at) / DAY_MS)), kind: next.kind, windowDays };
}

// ---- reverts, from git ----

export interface GitRevert {
  sha: string;
  /** Author time, ISO 8601. */
  at: string;
  subject: string;
  /** The commit it undoes, when the message says so ("This reverts commit <sha>"). */
  reverts?: string;
}

const RS = "\x1e";
const US = "\x1f";
/** The format `git log` is asked for: sha, author time (unix seconds), subject, body; records end with RS. */
export const GIT_LOG_FORMAT = `%H${US}%at${US}%s${US}%b${RS}`;

/**
 * Finds reverts in `git log --format=GIT_LOG_FORMAT` output. A revert is what `git revert` writes: a subject that starts with
 * `Revert "` or a body line "This reverts commit <40 hex>". A commit that merely mentions the word is not one.
 */
export function parseGitReverts(logOutput: string): GitRevert[] {
  const out: GitRevert[] = [];
  for (const rec of logOutput.split(RS)) {
    const trimmed = rec.replace(/^\s+/, "");
    if (trimmed === "") continue;
    const [sha, at, subject, body = ""] = trimmed.split(US);
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !at || subject === undefined) continue;
    const m = /^This reverts commit ([0-9a-f]{7,64})/im.exec(body);
    if (!/^Revert "/.test(subject) && !m) continue;
    const secs = Number(at);
    if (!Number.isFinite(secs)) continue;
    out.push({ sha, at: new Date(secs * 1000).toISOString(), subject, ...(m ? { reverts: m[1]! } : {}) });
  }
  return out;
}

export type GitRevertRead = { state: "ok"; reverts: GitRevert[]; commitsRead: number } | { state: "not_checked"; reason: string };

/** Reads reverts from the project's git history. Anything that stops git from answering is "not checked", never "none". */
export function readGitReverts(baseDir: string, sinceIso?: string): GitRevertRead {
  const inside = spawnSync(["git", "-C", baseDir, "rev-parse", "--is-inside-work-tree"], { tier: "T1" });
  if (inside.stopped || inside.exitCode !== 0 || inside.stdout.toString().trim() !== "true") return { state: "not_checked", reason: "not inside a git work tree, or git could not run" };
  const args = ["git", "-C", baseDir, "log", `--format=${GIT_LOG_FORMAT}`, "--max-count=5000", ...(sinceIso ? [`--since=${sinceIso}`] : [])];
  const res = spawnSync(args, { tier: "T2", maxOutputBytes: 64 * 1024 * 1024 });
  if (res.stopped || res.exitCode !== 0) return { state: "not_checked", reason: "git log did not finish (an empty repository, a timeout, or too much output)" };
  const text = res.stdout.toString();
  return { state: "ok", reverts: parseGitReverts(text), commitsRead: text.split(RS).filter((r) => r.trim() !== "").length };
}
