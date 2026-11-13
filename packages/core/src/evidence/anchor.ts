// src/evidence/anchor.ts
//
// A hash chain proves that the records it holds were not edited or reordered. It cannot prove that records were not
// cut off the END: a chain with its newest records deleted is still a perfectly valid chain. Before this file,
// `purix audit-log verify` printed "no tampering detected" for exactly that case.
//
// The fix is an anchor held outside the store. `purix evidence trailer` already writes the chain head into every commit
// message (Purix-Evidence: sha256:<head>), and git history is not the thing being checked. So verification now asks:
// does the chain still contain the head that the newest anchored commit recorded? If it does, nothing up to that
// commit was removed. Records added after that commit are valid but not yet anchored, and the result says so.
//
// Three outcomes, never merged into one:
//   anchored       the chain is intact and contains the anchored head
//   not_anchored   the chain is intact, but nothing outside the store vouches for its end
//   failed         the chain is broken, or it does not contain the head a commit recorded
import { spawnSync, type SpawnStop } from "../platform/spawn_sync.js";
import { GENESIS_HASH } from "./evidence.js";
import type { AuditCheckpointRow, AuditRow, AuditVerification } from "../security/audit_tamper_evidence.js";
import { verifyAuditRows } from "../security/audit_tamper_evidence.js";

/**
 * Why a git call produced no usable exit code, or undefined when git ended on its own (whatever its code). N3 follow-up (F02-03): a null
 * exit code used to mean "git is not installed", but a git that a signal ended, or that hit its time or output limit, is not that.
 */
export function whyGitDidNotRun(r: { exitCode: number | null; stopped?: SpawnStop; signal?: string }): string | undefined {
  if (r.exitCode !== null && !r.stopped) return undefined;
  if (r.stopped === "signal") return `git was ended by a signal${r.signal ? ` (${r.signal})` : ""}, so no commit could be checked. Purix cannot tell whether something outside or git itself did it.`;
  if (r.stopped === "timeout" || r.stopped === "output_limit" || r.stopped === "resource_limit") return `git did not finish (stopped: ${r.stopped.replace("_", " ")}), so no commit could be checked.`;
  if (r.stopped === "spawn_error") return "git could not be started, so no commit could be checked.";
  if (r.exitCode === null) return "git is not installed, so no commit could be checked.";
  return undefined;
}

export interface Anchor {
  /** The chain head the commit recorded. */
  head: string;
  /** Short commit id, or "supplied" when the caller gave the head directly. */
  source: string;
}

export type AnchorVerdict =
  | { state: "anchored"; recordCount: number; anchor: Anchor; newerRecords: number }
  | { state: "not_anchored"; recordCount: number; reason: string }
  | { state: "failed"; reason: string; compromisedIndex?: number };

const HEAD_LINE = /^Purix-Evidence:\s*sha256:([0-9a-f]{64})\s*$/im;

/** The chain head a commit message records, or null when it has no Purix-Evidence trailer. */
export function parseAnchorHead(message: string): string | null {
  const m = HEAD_LINE.exec(message.replace(/\r\n/g, "\n"));
  return m ? m[1]! : null;
}

/** A head the caller typed in. Accepts "sha256:<hex>" or bare hex; anything else is a mistake worth reporting. */
export function parseSuppliedHead(value: string): string | null {
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export type AnchorLookup = { found: true; anchor: Anchor } | { found: false; reason: string };

/**
 * The anchor from git: the newest commit reachable from `ref` (default HEAD) whose message carries a Purix-Evidence
 * trailer, looking back at most `depth` commits. With `exact` set, only that one commit is read.
 */
export function findAnchorInGit(cwd: string, opts: { ref?: string; exact?: boolean; depth?: number } = {}): AnchorLookup {
  const ref = opts.ref ?? "HEAD";
  if (ref.startsWith("-")) return { found: false, reason: `"${ref}" is not a commit reference.` };
  const inside = spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  const insideWhy = whyGitDidNotRun(inside);
  if (insideWhy) return { found: false, reason: insideWhy };
  if (inside.exitCode !== 0) return { found: false, reason: "this folder is not a git repository." };
  const depth = Math.max(1, Math.min(opts.depth ?? 200, 5000));
  const args = opts.exact
    ? ["git", "-C", cwd, "log", "-n", "1", "--format=%h%x1f%B%x1e", ref, "--"]
    : ["git", "-C", cwd, "log", "-n", String(depth), "--format=%h%x1f%B%x1e", ref, "--"];
  const res = spawnSync(args);
  const logWhy = whyGitDidNotRun(res);
  if (logWhy) return { found: false, reason: logWhy };
  if (res.exitCode !== 0) {
    const detail = res.stderr.toString().trim().split(/\r?\n/)[0] ?? "";
    return { found: false, reason: opts.exact || opts.ref ? `commit "${ref}" could not be read${detail ? ` (${detail})` : ""}.` : "this repository has no commits yet." };
  }
  for (const entry of res.stdout.toString().split("\x1e")) {
    const [id, ...rest] = entry.replace(/^\s+/, "").split("\x1f");
    if (!id) continue;
    const head = parseAnchorHead(rest.join("\x1f"));
    if (head) return { found: true, anchor: { head, source: id.trim() } };
  }
  return {
    found: false,
    reason: opts.exact ? `commit "${ref}" has no Purix-Evidence trailer.` : `none of the last ${depth} commits has a Purix-Evidence trailer.`,
  };
}

/** The verdict for a chain given the anchor lookup. Pure: no database, no git. */
export function judgeChain(rows: AuditRow[], checkpoint: AuditCheckpointRow | null, lookup: AnchorLookup): AnchorVerdict {
  const base: AuditVerification = verifyAuditRows(rows, checkpoint);
  if (!base.valid) return { state: "failed", reason: base.reason ?? "the chain is broken", compromisedIndex: base.compromisedIndex };
  const recordCount = base.recordCount ?? rows.length;
  if (!lookup.found) return { state: "not_anchored", recordCount, reason: lookup.reason };

  const { head } = lookup.anchor;
  if (head === GENESIS_HASH) {
    // A commit made before any record existed vouches for nothing yet.
    return { state: "anchored", recordCount, anchor: lookup.anchor, newerRecords: recordCount };
  }
  const at = rows.findIndex((r) => r.hash === head);
  if (at >= 0) return { state: "anchored", recordCount, anchor: lookup.anchor, newerRecords: rows.length - 1 - at };
  // The head can legitimately be gone only if it was pruned: the checkpoint is the hash of the last pruned record.
  if (checkpoint && checkpoint.checkpoint_hash === head) return { state: "anchored", recordCount, anchor: lookup.anchor, newerRecords: rows.length };
  return {
    state: "failed",
    reason:
      `the chain does not contain the head that commit ${lookup.anchor.source} recorded (${head.slice(0, 12)}…). ` +
      `Records were removed from the end of the chain, or this store belongs to a different history.`,
  };
}

/** One wording for every front door (CLI and MCP). The first word is the state. */
export function describeVerdict(v: AnchorVerdict): string {
  switch (v.state) {
    case "anchored": {
      const records = `${v.recordCount} record${v.recordCount === 1 ? "" : "s"}`;
      const newer = v.newerRecords > 0 ? ` ${v.newerRecords} newer record${v.newerRecords === 1 ? " is" : "s are"} valid but not anchored yet.` : "";
      return `VERIFIED: ${records}, intact, and the chain contains the head recorded by ${v.anchor.source === "supplied" ? "the supplied head" : `commit ${v.anchor.source}`}.${newer}`;
    }
    case "not_anchored":
      return (
        `CONSISTENT, NOT ANCHORED: ${v.recordCount} record${v.recordCount === 1 ? "" : "s"}, no edits or reordering found. ` +
        `Nothing outside the local store vouches for the end of the chain (${v.reason}), so removal of the newest records cannot be ruled out. ` +
        `Commit with the Purix-Evidence trailer, or pass --expect-head.`
      );
    case "failed":
      return `FAILED${v.compromisedIndex !== undefined ? ` at record index ${v.compromisedIndex}` : ""}: ${v.reason}`;
  }
}
