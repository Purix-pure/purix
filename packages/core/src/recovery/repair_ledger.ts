// packages/core/src/recovery/repair_ledger.ts
//
// AI-12 (PURIX-33): the attempt ledger. One short line per repair round, so round three can see what rounds one and two
// tried without receiving their failure output again.
//
// Pure module: no file access, no model call, no environment, no printing. heal.ts and escalate.ts own an array of entries,
// push one after each round and pass `renderLedger(entries)` to the next repair prompt.
//
// What a line says: the round, the kinds of edit proposed, the file they targeted, what happened, and the coarse error class
// when verification failed. It never carries compiler output or file text, so a hostile error message cannot reach the next
// prompt through the ledger. Every line is cut to LEDGER_LINE_MAX_CHARS and only the last LEDGER_MAX_ENTRIES are kept.
import type { FailureClass } from "../verify/failure_shape.js";

export const LEDGER_LINE_MAX_CHARS = 160;
export const LEDGER_MAX_ENTRIES = 8;

/** What happened to a round. Words are written for the model and for a person reading the event log. */
export type LedgerOutcome =
  | "verification failed" // the edits applied and the checks ran and failed
  | "edits did not apply" // an anchor or edit could not be matched to the current files
  | "no usable reply" // the model call threw or returned something unusable
  | "no edits proposed" // the model answered with an empty edit list
  | "same state as before"; // the edits produced content seen in an earlier round (oscillation)

/** `apply` and `call` are the two failures that never reached a verifier, so they have no FailureClass. */
export type LedgerErrorClass = FailureClass | "apply" | "call";

export interface LedgerEntry {
  /** 1-based round number within one loop (repair rounds and escalation rounds are separate loops). */
  round: number;
  /** The `kind` of each proposed edit, in order, without repeats. */
  kinds: string[];
  /** The path the first edit targeted, or null when there was no edit. */
  target: string | null;
  outcome: LedgerOutcome;
  errorClass?: LedgerErrorClass;
  /** Where the verifier pointed first, when it named a place. Used by the early-stop check, not printed in the line. */
  location?: { path: string; line: number } | null;
}

/** Keeps a model-chosen or verifier-chosen string from carrying a line break, a control character or an unbounded length into the ledger. */
function plain(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function formatLedgerLine(e: LedgerEntry): string {
  const kinds = e.kinds.length > 0 ? [...new Set(e.kinds)].map((k) => plain(k, 24)).join("+") : "no edits";
  const target = e.target === null ? "" : ` on ${plain(e.target, 60)}`;
  const cls = e.errorClass === undefined ? "" : ` [${e.errorClass}]`;
  const line = `round ${e.round}: ${kinds}${target} -> ${e.outcome}${cls}`;
  if (line.length <= LEDGER_LINE_MAX_CHARS) return line;
  // The target is the one variable-length part worth giving up; cut the whole line only as a last resort.
  const shortTarget = e.target === null ? "" : ` on …${plain(e.target, 60).slice(-24)}`;
  const shorter = `round ${e.round}: ${kinds}${shortTarget} -> ${e.outcome}${cls}`;
  return shorter.length <= LEDGER_LINE_MAX_CHARS ? shorter : `${shorter.slice(0, LEDGER_LINE_MAX_CHARS - 1)}…`;
}

/** A new array with `entry` added at the end and only the last LEDGER_MAX_ENTRIES kept. The input is not changed. */
export function appendLedger(entries: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const next = [...entries, entry];
  return next.length > LEDGER_MAX_ENTRIES ? next.slice(next.length - LEDGER_MAX_ENTRIES) : next;
}

/** The text for the prompt's ledger block, one line per round. Empty string when there is nothing to say yet. */
export function renderLedger(entries: readonly LedgerEntry[]): string {
  return entries.map((e) => formatLedgerLine(e)).join("\n");
}

/** The place a failure points at, as one comparable string, or null when the verifier named none. */
function locationKey(l: LedgerEntry["location"]): string | null {
  return l ? `${l.path.replace(/\\/g, "/")}:${l.line}` : null;
}

/** The identity of a failure for the early-stop check: its class and the first place the verifier named. */
export interface FailureIdentity {
  errorClass: FailureClass;
  location: { path: string; line: number } | null;
}

/**
 * True when two failures have the same class and the same named path and line. Needs a named location on both: a failure
 * with none never counts as a repeat, because "same class somewhere" would stop a loop that is making progress.
 */
export function sameFailurePlace(a: FailureIdentity, b: FailureIdentity): boolean {
  const ka = locationKey(a.location);
  const kb = locationKey(b.location);
  return a.errorClass === b.errorClass && ka !== null && ka === kb;
}

/**
 * True when the newest round failed with the same class at the same path and line as the round before it. Two rounds in a
 * row at one place means the last fix did not move the failure, so another round of the same kind is unlikely to either.
 * Needs a named location: a failure with none never counts. Limit, stated: a fix that adds or removes lines above the
 * error moves the line number, so a repeat at a shifted line is not seen.
 */
export function repeatsSameFailure(entries: readonly LedgerEntry[]): boolean {
  if (entries.length < 2) return false;
  const a = entries[entries.length - 2]!;
  const b = entries[entries.length - 1]!;
  if (a.errorClass === undefined || b.errorClass === undefined || a.errorClass !== b.errorClass) return false;
  // A round that never reached a verifier has no class to compare.
  if (a.errorClass === "apply" || a.errorClass === "call" || b.errorClass === "apply" || b.errorClass === "call") return false;
  return sameFailurePlace({ errorClass: a.errorClass, location: a.location ?? null }, { errorClass: b.errorClass, location: b.location ?? null });
}
