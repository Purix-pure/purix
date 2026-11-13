// src/state/reconcile.ts
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  listPendingOperations,
  deletePendingOperation,
  completeModification,
  readManifest,
  writeManifest,
  storeExists,
  type FileSnapshot,
} from "../manifest/store.js";
import { CURRENT_SCHEMA_VERSION } from "../manifest/schema_migrations.js";
import { verifyComponent, rollbackFiles, type VerificationResult } from "../verify/verify.js";
import { getLanguageProvider, resolveLanguage } from "../language/registry.js";
import { computeSyncHash } from "./hash.js";
import { getDependents, reVerifyDependents } from "../verify/impact.js";
import { findUnsafePaths } from "../gates/path_guard.js";
import { PURIX_DIRNAME } from "../platform/layout.js";
import { isRepoLockHeld } from "./repo_lock.js";
import { atomicWriteFile } from "../platform/atomic_write.js";

async function matchesOnDisk(snapshot: FileSnapshot[], targetDir: string): Promise<boolean> {
  for (const f of snapshot) {
    if (f.deleted) {
      // A deleted file has landed when it is gone.
      try {
        await readFile(join(targetDir, f.path));
        return false;
      } catch {
        continue;
      }
    }
    try {
      const onDisk = await readFile(join(targetDir, f.path), "utf-8");
      if (onDisk !== f.content) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Compares every file the operation touches with the journal's two snapshots. A change that writes several files writes them one
 * after the other, so a crash in between leaves some files new and some old; each file still holds exactly its before content or
 * exactly its after content, and the two snapshots say which. `torn` are the files at their after content while the change did
 * not complete; `foreign` is true when some file holds a third content, which is somebody else's work and is never touched.
 */
async function classifyOnDisk(
  before: FileSnapshot[],
  after: FileSnapshot[],
  targetDir: string,
): Promise<{ allBefore: boolean; torn: string[]; foreign: boolean }> {
  const beforeBy = new Map(before.map((f) => [f.path, f.content]));
  const afterBy = new Map(after.map((f) => [f.path, f.content]));
  const afterGone = new Set(after.filter((f) => f.deleted).map((f) => f.path));
  const torn: string[] = [];
  let allBefore = true;
  let foreign = false;
  for (const path of new Set([...beforeBy.keys(), ...afterBy.keys()])) {
    let disk: string | null;
    try {
      disk = await readFile(join(targetDir, path), "utf-8");
    } catch {
      disk = null;
    }
    const b = beforeBy.get(path);
    const a = afterBy.get(path);
    if (b === undefined ? disk === null : disk === b) continue; // untouched (a file the change adds is "before" while it is absent)
    allBefore = false;
    if (afterGone.has(path) ? disk === null : a !== undefined && disk === a) torn.push(path);
    else foreign = true;
  }
  return { allBefore, torn, foreign };
}

export async function reconcilePendingOperations(targetDir: string = process.cwd()): Promise<void> {
  // No store means no unfinished operations. Asking for the list would open the
  // store, and opening it creates .purix/manifest.db: that is how a bare
  // `purix connect` in an empty folder used to leave a store behind.
  if (!storeExists()) return;
  const pending = listPendingOperations();
  if (pending.length === 0) return;

  // Only while holding the repository lock. A pending row belongs to a writer that took the lock before it wrote anything, so
  // with the lock held in this process every row here is one whose writer is gone. Without it, a row may belong to a live
  // operation in another process, and rolling it back or "completing" it corrupts that operation (research 11: 12 of 12
  // forced runs inconsistent). The command that calls this takes the lock first (cli.ts pre-action step).
  const holdsLock = isRepoLockHeld(targetDir);
  console.error(
    holdsLock
      ? `⚠ Found ${pending.length} unfinished operation(s) from a previous run — reconciling...`
      : `⚠ Found ${pending.length} unfinished operation(s) but this process does not hold the repository lock, so it will not touch them. Another command may still be running; if none is, run \`purix reconcile\`.`,
  );
  if (!holdsLock) return;

  for (const op of pending) {
    const landedAfter = await matchesOnDisk(op.after_snapshot, targetDir);
    const onDisk = await classifyOnDisk(op.before_snapshot, op.after_snapshot, targetDir);
    // A create has no before content to compare, so "nothing landed" is "no file holds its after content".
    const stillBefore = !landedAfter && (op.operation === "create" ? onDisk.torn.length === 0 : onDisk.allBefore);
    // Some files written, the rest not (a crash between two writes), and nothing else touched: undo the written ones. Paths that
    // leave the project are never written or deleted, so such a row is left for a person like any other it cannot judge.
    const partial =
      !landedAfter && !stillBefore && onDisk.torn.length > 0 && (op.operation === "create" || !onDisk.foreign) &&
      findUnsafePaths(targetDir, [...op.before_snapshot, ...op.after_snapshot].map((f) => f.path)).length === 0;

    if (landedAfter) {
      // Files the change deletes are in the after snapshot only as markers: they are not verified, not hashed, and leave the entry.
      const liveAfter = op.after_snapshot.filter((f) => !f.deleted);
      const goneAfter = new Set(op.after_snapshot.filter((f) => f.deleted).map((f) => f.path));
      const paths = liveAfter.map((f) => join(targetDir, f.path));
      // BUG FIX (was the exact pre-fix pattern from sandbox.ts, reintroduced
      // here): silently treating every non-".py" file as "typescript" meant
      // a Rust/Go component recovering from a crash-interrupted commit would
      // be verified against the wrong toolchain's rules — in the one path
      // explicitly meant to be trustworthy when nothing else is. Use the
      // real resolveLanguage() against this operation's actual component_id
      // (a real, resolvable manifest identity, unlike the indexer's
      // synthetic IDs — see manifest/indexer.ts) and fail closed instead of
      // guessing when it can't be determined, matching sandbox.ts's pattern.
      let result: VerificationResult;
      try {
        const lang = liveAfter.length > 0 && liveAfter[0]!.path.endsWith(".py")
          ? "python"
          : resolveLanguage(op.component_id, targetDir);
        const provider = getLanguageProvider(lang);
        result = provider ? provider.verify(paths, targetDir) : verifyComponent(paths, targetDir);
      } catch (err) {
        result = {
          status: "fail",
          reason: `could not determine the language for ${op.component_id}: ${err instanceof Error ? err.message : String(err)} — refusing to guess "typescript"; set an explicit language in ${PURIX_DIRNAME}/config.json`,
        };
      }
      let entry = readManifest(op.component_id);
      const syncHash = computeSyncHash(liveAfter);

      if (op.operation === "create") {
        if (result.status === "pass") {
          if (!entry) {
            entry = {
              component_id: op.component_id,
              component_type: "module",
              current_version: 1,
              schema_version: CURRENT_SCHEMA_VERSION,
              parts: { tools: [], config: {} },
              files: liveAfter.map((f) => f.path),
              depends_on: [],
              depended_on_by: [],
              version_history: [
                {
                  version: 1,
                  operation: "create",
                  patch_ref: "reconciled-create",
                  contract_changed: false,
                  timestamp: new Date().toISOString(),
                  // the pending op's own recorded provenance is the real
                  // origin of this create — not a guess made here
                  provenance: op.provenance,
                },
              ],
              verification_status: "pass",
              last_synced_hash: syncHash,
            };
          } else {
            entry.verification_status = "pass";
            entry.last_synced_hash = syncHash;
          }
          writeManifest(entry);
          deletePendingOperation(op.id);
          console.error(`   ✅ ${op.component_id}: completed interrupted create commit`);
        } else {
          rollbackFiles(paths);
          deletePendingOperation(op.id);
          console.error(`   ↩ ${op.component_id}: interrupted create failed verification — rolled back files`);
        }
        continue;
      }

      if (!entry) {
        console.error(`   ⚠ ${op.component_id}: files landed but manifest entry is gone — leaving journal row ${op.id} for manual review`);
        continue;
      }

      if (result.status === "pass") {
        if (goneAfter.size > 0) entry.files = entry.files.filter((f) => !goneAfter.has(f));
        entry.current_version = op.new_version;
        entry.verification_status = "pass";
        entry.last_synced_hash = syncHash;
        entry.version_history.push({
          version: op.new_version,
          operation: op.operation,
          patch_ref: `v${op.new_version}-reconciled`,
          contract_changed: op.contract_changed,
          timestamp: new Date().toISOString(),
          // same principle as the create branch above: the pending op
          // already recorded whether this came from an instruction or
          // an ingested diff, and from which agent — reconciliation just
          // carries that forward rather than re-deriving or guessing it
          provenance: op.provenance,
        });

        // BUG FIX: expectedVersion must be the version the DB row held
        // BEFORE this operation (op.new_version - 1) — not op.new_version,
        // which we just wrote into `entry` above. Passing the new version
        // meant the CAS WHERE clause could never match the still-old row,
        // so this write always silently failed (0 rows changed), the
        // pending_operations row never got deleted, and this branch printed
        // "✅ completed" unconditionally regardless of whether anything
        // was actually persisted.
        const wasCommitted = completeModification(entry, op.id, op.new_version - 1);

        if (!wasCommitted) {
          console.error(
            `   ⚠ ${op.component_id}: manifest already moved past v${op.new_version - 1} since this ` +
              `operation was queued — leaving journal row ${op.id} for manual review instead of guessing.`
          );
          continue;
        }

        console.error(`   ✅ ${op.component_id}: completed an interrupted commit (v${op.new_version})`);

        if (op.contract_changed) {
          const dependents = getDependents(entry);
          if (dependents.length > 0) {
            console.error(`   Re-verifying ${dependents.length} dependent(s) after reconciled contract-changing commit...`);
            const cascade = reVerifyDependents(dependents, targetDir);
            for (const c of cascade) {
              console.error(
                c.status === "pass"
                  ? `      ✅ ${c.component_id} still verifies`
                  : c.infrastructure
                    ? `      ⚠️  ${c.component_id} could not be re-verified (not a failure of the dependent):\n         ${c.reason}`
                    : `      ❌ ${c.component_id} now FAILS verification:\n         ${c.reason}`
              );
            }
          }
        }
      } else {
        const unsafe = findUnsafePaths(targetDir, op.before_snapshot.map((f) => f.path));
        if (unsafe.length > 0) {
          console.error(
            `   ⚠ ${op.component_id}: journal row ${op.id} has path(s) outside the target directory ` +
              `(${unsafe.map((u: { path: string }) => `"${u.path}"`).join(", ")}) — refusing to write, leaving journal row for manual review`
          );
          continue;
        }
        for (const f of op.before_snapshot) {
          await writeFile(join(targetDir, f.path), f.content, "utf-8");
        }
        // A file the change added has no before content to restore: undoing the change means removing it.
        const hadBefore = new Set(op.before_snapshot.map((f) => f.path));
        for (const f of op.after_snapshot) {
          if (!hadBefore.has(f.path) && !f.deleted) await unlink(join(targetDir, f.path)).catch(() => undefined);
        }
        deletePendingOperation(op.id);
        console.error(`   ↩ ${op.component_id}: interrupted write failed verification — rolled back to previous content`);
      }
    } else if (stillBefore || partial) {
      if (partial) {
        const previous = new Map(op.before_snapshot.map((f) => [f.path, f.content]));
        for (const path of onDisk.torn) {
          const was = previous.get(path);
          if (was === undefined) await unlink(join(targetDir, path)).catch(() => undefined);
          else atomicWriteFile(join(targetDir, path), was);
        }
      }
      deletePendingOperation(op.id);
      console.error(
        partial
          ? `   ↩ ${op.component_id}: an interrupted write had changed ${onDisk.torn.length} of ${op.after_snapshot.length} file(s) — rolled them back to their previous content`
          : `   • ${op.component_id}: no write had landed — journal entry cleared`,
      );
    } else {
      console.error(`   ⚠ ${op.component_id}: on-disk state matches neither the before nor after snapshot (journal id: ${op.id}).`);
      console.error(`     Something else touched these files during the crash window. Refusing to guess — resolve manually.`);
    }
  }
}