// src/state/reconcile.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listPendingOperations,
  deletePendingOperation,
  completeModification,
  readManifest,
  writeManifest,
  type FileSnapshot,
} from "../manifest/store.js";
import { CURRENT_SCHEMA_VERSION } from "../manifest/schema_migrations.js";
import { verifyComponent, rollbackFiles } from "../verify/verify.js";
import { getLanguageProvider } from "../language/registry.js";
import { computeSyncHash } from "./hash.js";
import { getDependents, reVerifyDependents } from "../verify/impact.js";
import { findUnsafePaths } from "../gates/path_guard.js";

async function matchesOnDisk(snapshot: FileSnapshot[], targetDir: string): Promise<boolean> {
  for (const f of snapshot) {
    try {
      const onDisk = await readFile(join(targetDir, f.path), "utf-8");
      if (onDisk !== f.content) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function reconcilePendingOperations(targetDir: string = process.cwd()): Promise<void> {
  const pending = listPendingOperations();
  if (pending.length === 0) return;

  console.error(`⚠ Found ${pending.length} unfinished operation(s) from a previous run — reconciling...`);

  for (const op of pending) {
    const landedAfter = await matchesOnDisk(op.after_snapshot, targetDir);
    const stillBefore = !landedAfter && (op.operation === "create" || (await matchesOnDisk(op.before_snapshot, targetDir)));

    if (landedAfter) {
      const paths = op.after_snapshot.map((f) => join(targetDir, f.path));
      const lang = op.after_snapshot.length > 0 && op.after_snapshot[0]!.path.endsWith(".py") ? "python" : "typescript";
      const provider = getLanguageProvider(lang);
      const result = provider ? provider.verify(paths, targetDir) : verifyComponent(paths, targetDir);
      let entry = readManifest(op.component_id);
      const syncHash = computeSyncHash(op.after_snapshot);

      if (op.operation === "create") {
        if (result.status === "pass") {
          if (!entry) {
            entry = {
              component_id: op.component_id,
              component_type: "module",
              current_version: 1,
              schema_version: CURRENT_SCHEMA_VERSION,
              parts: { tools: [], config: {} },
              files: op.after_snapshot.map((f) => f.path),
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
        deletePendingOperation(op.id);
        console.error(`   ↩ ${op.component_id}: interrupted write failed verification — rolled back to previous content`);
      }
    } else if (stillBefore) {
      deletePendingOperation(op.id);
      console.error(`   • ${op.component_id}: no write had landed — journal entry cleared`);
    } else {
      console.error(`   ⚠ ${op.component_id}: on-disk state matches neither the before nor after snapshot (journal id: ${op.id}).`);
      console.error(`     Something else touched these files during the crash window. Refusing to guess — resolve manually.`);
    }
  }
}