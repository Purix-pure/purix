// src/cli/commands/lifecycle_delete.ts
//
// H2: `purix delete`, moved out of registerLifecycleCommands unchanged. Refuses on live dependents unless --force; manifest-only unless --files.
import { noteLanded } from "./landed.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadDeleteRuntime } from "./lifecycle_runtime.js";

export async function runDelete(componentId: string, opts: { force?: boolean; files?: boolean }): Promise<void> {
  const {
    confirmGated,
    readManifest,
    deleteManifestEntry,
    removeDependent,
    removeDependencyReference,
    recordEvent,
  } = await loadDeleteRuntime();
  const entry = readManifest(componentId);
  if (!entry) {
    console.error(`No manifest entry for "${componentId}". Run "purix status" to see what's tracked.`);
    process.exitCode = 1;
    return;
  }

  if (entry.depended_on_by.length > 0 && !opts.force) {
    console.error(
      `\n🛑 "${componentId}" still has dependent(s): ${entry.depended_on_by.join(", ")}.\n` +
        `   Re-run with --force to delete anyway (dependents will have this reference removed from their depends_on list), ` +
        `or remove those dependencies first.`
    );
    process.exitCode = 1;
    return;
  }

  // TEST-REPORT F1: `--files` on the auto-created whole-codebase index
  // component used to delete every tracked file in the project (package.json,
  // tsconfig.json, all sources) behind a prompt that never named a single
  // one. Refuse that outright, and for any other component show exactly
  // which files will go before asking.
  let filesToRemove: string[] = [];
  if (opts.files) {
    if (entry.component_type === "codebase_index") {
      console.error(
        `\n🛑 "${componentId}" is the whole-codebase index — --files would delete all ${entry.files.length} ` +
          `tracked file(s) in this project. Delete the manifest entry without --files, or remove files yourself.`
      );
      process.exitCode = 1;
      return;
    }
    filesToRemove = entry.files.filter((relPath) => existsSync(join(process.cwd(), relPath)));
    const shown = filesToRemove.slice(0, 15);
    console.log(`\nFiles that will be deleted from disk (${filesToRemove.length}):`);
    for (const relPath of shown) console.log(`  - ${relPath}`);
    if (filesToRemove.length > shown.length) console.log(`  … and ${filesToRemove.length - shown.length} more`);
    console.log("");
  }

  const proceed = await confirmGated(
    `This will permanently delete "${componentId}" from the manifest${opts.files ? ` and remove ${filesToRemove.length} file(s) from disk` : ""}. This cannot be undone. Continue?`,
    "component_delete",
    componentId
  );
  if (!proceed) {
    console.log("Cancelled — nothing deleted.");
    return;
  }

  // Clean up both directions of the dependency graph before the row
  // itself is gone and readManifest(componentId) stops working.
  for (const depId of entry.depends_on) {
    removeDependent(depId, componentId);
  }
  for (const dependentId of entry.depended_on_by) {
    removeDependencyReference(dependentId, componentId);
  }

  if (opts.files) {
    for (const relPath of entry.files) {
      const fullPath = join(process.cwd(), relPath);
      if (existsSync(fullPath)) {
        try {
          rmSync(fullPath);
        } catch (err) {
          console.warn(`  warning: couldn't remove ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  deleteManifestEntry(componentId);
  await noteLanded({ kind: "delete", component_id: componentId, version: entry.current_version, sync_hash: null, operation: "delete", source: null });
  recordEvent("component_deleted", {
    component_id: componentId,
    detail: { forced: !!opts.force, files_removed: !!opts.files, had_dependents: entry.depended_on_by.length > 0 },
  });
  console.log(`\n🗑️  Deleted "${componentId}"${opts.files ? " (files removed)" : " (manifest entry only — files left on disk)"}.`);
}
