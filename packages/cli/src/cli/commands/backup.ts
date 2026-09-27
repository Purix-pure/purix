// src/cli/commands/backup.ts
import type { Command } from "commander";
import type { ManifestBackup } from "@purix/core/manifest/store";
import { readFile, writeFile } from "node:fs/promises";

export function registerBackupCommands(program: Command) {
  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): "backup"
  // and "restore" grouped under a "backup" noun (export/import of the same
  // manifest-state resource). "reconcile" deliberately left OUT of this
  // group and left flat — despite living in the same file, it's a genuinely
  // different concept (crash-interrupted-operation recovery, not a backup
  // file's export/import), and forcing it under "backup" would recreate the
  // exact kind of false, word-collision grouping this pass found and
  // avoided in observability.ts's "audit" vs. "audit-trail"/"audit-verify".
  // See security.ts's matching comment for the standard and why this is
  // safe pre-release.
  const backupCmd = program.command("backup").description("Export or restore the manifest + pending operations");

  backupCmd
    .command("create <outFile>")
    .description("Export the manifest + pending operations to a JSON file")
    .action(async (outFile: string) => {
      try {
        const { exportManifestData } = await import("@purix/core/manifest/store");
        const data = exportManifestData();
        await writeFile(outFile, JSON.stringify(data, null, 2), "utf-8");
        console.log(`✅ Backed up ${data.manifest.length} component(s) to ${outFile}.`);
      } catch (err) {
        console.error(`\n🛑 Failed to write backup: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  backupCmd
    .command("restore <inFile>")
    .description("Restore the manifest from a backup file — DESTRUCTIVE, replaces current state")
    .action(async (inFile: string) => {
      try {
        const { confirmGated } = await import("@purix/core/cli-io/gated-confirm");
        const { importManifestData } = await import("@purix/core/manifest/store");
        // TEST-REPORT F13: validate the file BEFORE asking a human to approve a wipe of
        // the manifest — it used to prompt first, then fail on a missing/garbled
        // file (and, for a wrong-shaped file, with the raw "backup.manifest is not iterable").
        let raw: ManifestBackup;
        try {
          raw = JSON.parse(await readFile(inFile, "utf-8")) as ManifestBackup;
        } catch (err) {
          throw new Error(`Could not read "${inFile}" as a JSON backup: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        if (!raw || typeof raw !== "object" || !Array.isArray((raw as { manifest?: unknown }).manifest)) {
          throw new Error(`"${inFile}" is not a Purix backup (it has no "manifest" list). Nothing was restored.`);
        }
        const proceed = await confirmGated(`This will WIPE and replace the current manifest with the contents of ${inFile}. Continue?`, "restore", null);
        if (!proceed) return;
        importManifestData(raw);
        console.log(`✅ Restored ${raw.manifest.length} component(s) from ${inFile}.`);
      } catch (err) {
        console.error(`\n🛑 Failed to restore backup: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // reconcile (§7.3 safety net, standalone — deliberately NOT under "backup",
  // see the comment above registerBackupCommands)
  // ---------------------------------------------------------------------------
  program
    .command("reconcile")
    .description("Force a reconciliation pass for crash-interrupted operations")
    .action(async () => {
      try {
        const { reconcilePendingOperations } = await import("@purix/core/state/reconcile");
        await reconcilePendingOperations();
        console.log("Reconciliation check complete.");
      } catch (err) {
        console.error(`\n🛑 Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}