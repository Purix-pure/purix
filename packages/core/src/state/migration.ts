// src/state/migration.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileSnapshot } from "../manifest/store.js";
import { recordMigration, setMigrationStatus, getMigration, type MigrationRecord } from "../manifest/migrations.js";
import { scanForSecrets } from "../security/secrets.js";
import { findUnsafePaths } from "../gates/path_guard.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";

export interface MigrationPlan {
  summary: string;
  changedPaths: string[];
  rollbackCommand: string;
}

/**
 * Deterministic, from the diff itself — no LLM call. "Forward migration"
 * here means a human-readable record of what changed; "rollback script"
 * means a real, always-runnable Purix command, not generated code. This
 * is the honest scope for a system whose artifacts are prompts/configs/
 * tool bindings, not SQL schemas — there's no universal "migration
 * language" to author across those, so we don't pretend to author one.
 */
export function buildMigrationPlan(
  componentId: string,
  operation: string,
  before: FileSnapshot[],
  after: FileSnapshot[]
): MigrationPlan {
  const beforeByPath = new Map(before.map((f) => [f.path, f.content]));
  const changedPaths = after
    .filter((f) => beforeByPath.get(f.path) !== f.content)
    .map((f) => f.path);

  return {
    summary: `${operation} on "${componentId}" touches ${changedPaths.length} file(s): ${changedPaths.join(", ")}`,
    changedPaths,
    rollbackCommand: `purix migration-rollback <id>`, // <id> filled in by the caller once recorded
  };
}

/**
 * Stages a contract-changing change WITHOUT writing to real files.
 * Section 14: "wraps the change in a feature flag rather than
 * committing it live." The flag, concretely, is: the after-snapshot
 * sits in the migrations table until a human runs migration-activate.
 */
export function stageMigration(
  componentId: string,
  operation: string,
  versionFrom: number,
  versionTo: number,
  before: FileSnapshot[],
  after: FileSnapshot[]
): string {
  return recordMigration({
    component_id: componentId,
    operation,
    version_from: versionFrom,
    version_to: versionTo,
    before_snapshot: before,
    after_snapshot: after,
    status: "staged",
  });
}

/** Records an already-live commit too — so it has a durable rollback path pending_operations can no longer provide post-commit. */
export function recordActiveMigration(
  componentId: string,
  operation: string,
  versionFrom: number,
  versionTo: number,
  before: FileSnapshot[],
  after: FileSnapshot[]
): string {
  return recordMigration({
    component_id: componentId,
    operation,
    version_from: versionFrom,
    version_to: versionTo,
    before_snapshot: before,
    after_snapshot: after,
    status: "active",
  });
}

export interface MigrationActionResult {
  ok: boolean;
  reason?: string;
}

export async function activateMigration(id: string, targetDir: string = process.cwd()): Promise<MigrationActionResult> {
  const record = getMigration(id);
  if (!record) return { ok: false, reason: `No migration found with id "${id}".` };
  if (record.status !== "staged") return { ok: false, reason: `Migration "${id}" is "${record.status}", not "staged" — nothing to activate.` };

  // Closes a real gap: activation writes straight to real files and
  // previously only ran verifyComponent (a compile check) afterward —
  // it never went through engine/sandbox.ts's verifyInSandbox, the only
  // place scanForSecrets normally runs. Checked BEFORE the write loop
  // below, not after like the compile check — a secret shouldn't touch
  // disk at all, not get written then rolled back.
  const secretFindings = scanForSecrets(record.after_snapshot);
  if (secretFindings.length > 0) {
    return {
      ok: false,
      reason:
        `Secrets/entropy scan blocked activation — nothing was written:\n` +
        secretFindings.map((f) => `  ${f.path}:${f.line} — ${f.reason} (${f.match})`).join("\n") +
        `\nRemove the secret from the staged migration's content, then re-stage and re-run "purix migration-activate".`,
    };
  }

  // Path-traversal guard. A staged migration's after_snapshot was built
  // from a compiled patch (already path-checked upstream) or a
  // reconciled diff/scaffold — but activation can happen long after
  // staging, against whatever targetDir the caller passes THIS time.
  // Re-check here, at the actual write point, rather than trusting a
  // path that was safe relative to a possibly different root when it
  // was staged.
  const unsafeActivate = findUnsafePaths(targetDir, [
    ...record.after_snapshot.map((f) => f.path),
    ...record.before_snapshot.map((f) => f.path), // also written below on the verification-failure rollback path
  ]);
  if (unsafeActivate.length > 0) {
    return {
      ok: false,
      reason:
        `Path-traversal guard blocked activation — nothing was written: ` +
        unsafeActivate.map((u) => `"${u.path}" (${u.reason})`).join("; "),
    };
  }

  // Closes the real gap this function used to have: activation wrote
  // straight to real files and only ran verifyComponent (a compile
  // check) afterward, rolling back on failure. That means a change
  // which compiled but broke an existing test — or anything else only
  // a full sandbox pass catches — briefly existed on disk before being
  // undone. Build the sandbox check BEFORE any real write happens
  // instead, using the same verifyInSandbox every other write path in
  // the system goes through (temp-dir copy, secrets scan, tsc, tests,
  // idiom check — never touches targetDir). Only proceed to the real
  // write loop below if this comes back "pass".
  const sandboxResult = verifyInSandbox(
    record.component_id,
    record.after_snapshot.map((f) => ({ path: f.path, new_content: f.content })),
    targetDir
  );
  if (sandboxResult.status !== "pass") {
    return { ok: false, reason: `Activation blocked — staged after-snapshot failed a full sandbox pass, nothing was written: ${sandboxResult.reason}` };
  }

  // The sandbox pass above is what makes this write trustworthy; this
  // loop no longer does the job of correctness verification. A
  // rollback path still exists here, but only for a genuine write-time
  // I/O failure (disk full, permissions) — not for anything the
  // sandbox pass should have already caught.
  const written: FileSnapshot[] = [];
  try {
    for (const f of record.after_snapshot) {
      await writeFile(join(targetDir, f.path), f.content, "utf-8");
      written.push(f);
    }
  } catch (err) {
    for (const f of written) {
      const before = record.before_snapshot.find((b) => b.path === f.path);
      if (before) await writeFile(join(targetDir, before.path), before.content, "utf-8");
    }
    return { ok: false, reason: `Activation failed while writing files (I/O error), rolled back what was written: ${err instanceof Error ? err.message : String(err)}` };
  }

  setMigrationStatus(id, "active");
  return { ok: true };
}

export async function rollbackMigration(id: string, targetDir: string = process.cwd()): Promise<MigrationActionResult> {
  const record = getMigration(id);
  if (!record) return { ok: false, reason: `No migration found with id "${id}".` };
  if (record.status === "rolled_back") return { ok: false, reason: `Migration "${id}" was already rolled back.` };

  const unsafeRollback = findUnsafePaths(targetDir, record.before_snapshot.map((f) => f.path));
  if (unsafeRollback.length > 0) {
    return {
      ok: false,
      reason:
        `Path-traversal guard blocked rollback — nothing was written: ` +
        unsafeRollback.map((u) => `"${u.path}" (${u.reason})`).join("; "),
    };
  }

  for (const f of record.before_snapshot) {
    await writeFile(join(targetDir, f.path), f.content, "utf-8");
  }
  setMigrationStatus(id, "rolled_back");
  return { ok: true };
}