// src/manifest/commit_and_cascade.ts
//
// Extracted from packages/cli/src/cli/commands/lifecycle.ts to close the
// "Residual lifecycle.ts duplication" item CHANGES.md's duplication-finder
// pass explicitly left open ("the commit + migration-cascade block that
// follows the now-extracted verify/heal/escalate step is still duplicated
// between modify and ingest ... Left alone rather than forcing a rushed
// abstraction over logic this safety-critical late in this pass").
//
// Node 5 (Executor + atomic manifest commit, §7.3/§7.4) really is one
// algorithm in both callers — same createPendingOperation ->
// applyModificationFiles -> mutate entry -> version_history.push ->
// commitManifestWithRetry -> rollback-on-conflict -> completeModification
// sequence, byte-for-byte, differing only in which strings/objects get
// plugged in (operation label, patch_ref shape, provenance, which CLI
// command name shows up in the conflict message). That's parameters, not
// a different algorithm, so it moves here as commitVersionedChange().
//
// The dependent re-verification loop that follows it is *also* identical
// in both callers (same "Re-verifying N dependent(s)" message, same
// pass/fail per-dependent formatting) — that moves here too, as
// reVerifyCascadeDependents().
//
// What does NOT move here: migration staging (buildMigrationPlan +
// stageMigration). `modify` calls both on every contract-changing commit;
// `ingest` — both before and after the duplication-finder pass — never
// has, even though it destructured buildMigrationPlan/stageMigration out
// of loadLifecycleRuntime() in the original code without ever calling
// them (dead code the duplication-finder pass correctly removed when it
// split ingest onto its own lightweight loadIngestRuntime()). Whether
// that's an intentional scope decision (a migration record only makes
// sense for classifier-authored operations, not externally-authored
// diffs) or a real gap (a contract-changing diff should get a migration
// record exactly like a contract-changing instruction-modify does) is a
// product call this extraction does not make unilaterally — folding
// migration staging in here would either silently add a new side effect
// to `ingest` or silently drop one from `modify`, and per the same
// principle the earlier resolveVerification() extraction's own comment
// cites (forcing two genuinely different things into one abstraction
// costs more than the duplication it removes), that decision stays with
// whoever owns the product behavior, made explicitly, not smuggled into a
// dedup pass. Both commands still call buildMigrationPlan/stageMigration
// (modify) or skip it (ingest) exactly as before, immediately after
// calling reVerifyCascadeDependents() below.
import { createPendingOperation, completeModification, commitManifestWithRetry, deletePendingOperation } from "./store.js";
import { applyModificationFiles, rollbackModification } from "../entrypoints/modify.js";
import { computeSyncHash } from "../state/hash.js";
import { getDependents, reVerifyDependents } from "../verify/impact.js";
import type { ManifestEntry, Provenance } from "./schema.js";

export interface CommitVersionedChangeParams {
  componentId: string;
  entry: ManifestEntry;
  beforeSnapshot: { path: string; content: string }[];
  finalFiles: { path: string; new_content: string }[];
  operation: string;
  patchRef: string;
  contractChanged: boolean;
  provenance: Provenance;
  targetDir: string;
  /** e.g. `"purix modify"` / `"purix ingest"` — only used in the conflict message. */
  reRunCommandHint: string;
  /** ingest-only: new file paths a diff added, merged into entry.files before commit. Omit for modify. */
  newFilePaths?: string[];
}

export type CommitVersionedChangeResult =
  | { ok: true; newVersion: number }
  | { ok: false }; // caller has nothing further to do — this already printed the error and set process.exitCode

/**
 * Node 5: Executor + atomic manifest commit. Writes files, mutates and
 * commits the manifest entry, rolling back file writes if the commit hits
 * a version conflict. Prints its own error message and sets
 * process.exitCode on failure; callers just check `.ok` and return.
 */
export async function commitVersionedChange(params: CommitVersionedChangeParams): Promise<CommitVersionedChangeResult> {
  const { componentId, entry, beforeSnapshot, finalFiles, operation, patchRef, contractChanged, provenance, targetDir, reRunCommandHint, newFilePaths } = params;
  const newVersion = entry.current_version + 1;

  const pendingId = createPendingOperation({
    component_id: componentId,
    before_snapshot: beforeSnapshot,
    after_snapshot: finalFiles.map((f) => ({ path: f.path, content: f.new_content })),
    new_version: newVersion,
    operation,
    contract_changed: contractChanged,
    provenance,
  });

  let backups;
  try {
    backups = await applyModificationFiles(finalFiles, targetDir);
  } catch (err) {
    console.error(`\n🛑 File write failed, rolled back: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return { ok: false };
  }

  if (newFilePaths && newFilePaths.length > 0) {
    entry.files = Array.from(new Set([...entry.files, ...newFilePaths]));
  }
  entry.current_version = newVersion;
  entry.verification_status = "pass";
  entry.last_synced_hash = computeSyncHash(finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
  entry.version_history.push({
    version: newVersion,
    operation,
    patch_ref: patchRef,
    contract_changed: contractChanged,
    timestamp: new Date().toISOString(),
    provenance,
  });

  const committed = await commitManifestWithRetry(entry, newVersion - 1);
  if (!committed) {
    // Real conflict: another process committed a newer version between our
    // State Resolver read and now. Roll back the files we just wrote and
    // hand back to the human rather than clobbering the other write.
    await rollbackModification(backups);
    deletePendingOperation(pendingId);
    console.error(
      `\n🛑 Manifest write conflict — "${componentId}" changed underneath this run. Rolled back file writes. Re-run ${reRunCommandHint} against current state.`
    );
    process.exitCode = 1;
    return { ok: false };
  }
  completeModification(entry, pendingId, newVersion);
  return { ok: true, newVersion };
}

/**
 * §6.5: on a contract-changing commit, re-verify every dependent and print
 * a pass/fail line per dependent. Identical logic in both callers; the
 * lead-in message differs slightly (ingest names diff-classify as the
 * reason it's re-verifying), so that part is a parameter rather than
 * hardcoded, to keep both callers' existing output byte-for-byte.
 */
export function reVerifyCascadeDependents(entry: ManifestEntry, targetDir: string, leadInSuffix: string = "..."): void {
  const dependents = getDependents(entry);
  if (dependents.length === 0) return;
  console.log(`  Re-verifying ${dependents.length} dependent(s)${leadInSuffix}`);
  const cascade = reVerifyDependents(dependents, targetDir);
  for (const c of cascade) {
    console.log(c.status === "pass" ? `    ✅ ${c.component_id}` : `    ❌ ${c.component_id}: ${c.reason}`);
  }
}
