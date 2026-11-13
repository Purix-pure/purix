// src/state/landed_change.ts
//
// The one place a landed change (create, modify, ingest, adopt, delete) reaches the tamper-evident audit chain and
// the committed lock. Before this, the chain recorded only tool installs, drift events and the model baseline, so
// the claim "every change leaves a hash-chained record" was not true: a modify or a delete left no chain record.
//
// Payload rule: identifiers and hashes only. Never file contents, never prompts, never diffs.
// Failure rule: the change has already landed, so a failure here must not undo it. It is returned, and the caller
// tells the person ("the change landed but could not be recorded in the audit chain"), instead of being swallowed.
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";
import { readStoreSnapshot } from "../manifest/store.js";
import { refreshLockIfPresent } from "./governed_lock.js";

export type LandedChangeKind = "create" | "modify" | "ingest" | "adopt" | "delete" | "accept_drift";

export interface LandedChange {
  kind: LandedChangeKind;
  component_id: string;
  version?: number;
  /** Hash of the governed files after the change (null after a delete). */
  sync_hash?: string | null;
  /** The operation name, for example update_prompt_text or diff_ingest. */
  operation?: string;
  /** Who produced the change: an agent id, "human", or null when unknown. */
  source?: string | null;
}

export interface LandedChangeResult {
  audited: boolean;
  /** true: rewritten; false: the project keeps no lock; "failed": it keeps one and it could not be refreshed. */
  lock: boolean | "failed";
  problems: string[];
}

export function recordLandedChange(change: LandedChange, baseDir: string = process.cwd()): LandedChangeResult {
  const problems: string[] = [];
  let audited = false;
  try {
    appendAuditRecord({
      event: "component_change",
      kind: change.kind,
      component_id: change.component_id,
      version: change.version ?? null,
      sync_hash: change.sync_hash ?? null,
      operation: change.operation ?? null,
      source: change.source ?? null,
    });
    audited = true;
  } catch (err) {
    problems.push(`could not append to the audit chain: ${err instanceof Error ? err.message : String(err)}`);
  }

  let lock: LandedChangeResult["lock"] = false;
  try {
    const read = readStoreSnapshot();
    if (read.state === "ok") lock = refreshLockIfPresent(read.snapshot.manifest, baseDir);
  } catch (err) {
    lock = "failed";
    problems.push(`could not refresh purix.lock.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { audited, lock, problems };
}
