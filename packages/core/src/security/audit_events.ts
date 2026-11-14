// packages/core/src/security/audit_events.ts
//
// A2a-1: one small door for "something was decided, put it in the chain". Approvals and gate decisions use it so that none of
// them opens the store by itself or throws into the code that made the decision.
//
// The audit chain lives in the store of the current working directory. A caller that names a different project folder
// (tests, tools that act on another checkout) must not write into this folder's chain, so an event for another store is skipped
// and reported as not recorded.
import { realpathSync } from "node:fs";
import { appendAuditRecord } from "./audit_tamper_evidence.js";
import { resolveSharedStateDir } from "../state/git_common_dir.js";

/** Two spellings of one folder (macOS /var vs /private/var, Windows short names) are the same folder; process.cwd() gives the real one. */
function sameFolder(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false; // a store that is not on disk yet keeps the plain comparison
  }
}

export interface RecordEventOptions {
  /** The project folder the event is about. Default: the current directory. */
  baseDir?: string;
  /** Test seam and future sinks: replaces appendAuditRecord. */
  append?: (payload: object) => unknown;
  /** Told why an event was not recorded. Never throws into the caller. */
  onFailure?: (message: string) => void;
}

/** Appends `{ event, ...fields }`. True when recorded. Never throws. */
export function recordGovernanceEvent(event: string, fields: Record<string, unknown>, opts: RecordEventOptions = {}): boolean {
  try {
    if (opts.baseDir !== undefined && !sameFolder(resolveSharedStateDir(opts.baseDir), resolveSharedStateDir())) return false;
    (opts.append ?? appendAuditRecord)({ event, ...fields });
    return true;
  } catch (err) {
    opts.onFailure?.(`could not record ${event} in the audit chain: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
