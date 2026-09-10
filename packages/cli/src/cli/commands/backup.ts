// src/cli/commands/backup.ts
import type { Command } from "commander";
import { confirmGated } from "@purix/core/cli-io/gated-confirm";
import { exportManifestData, importManifestData, type ManifestBackup } from "@purix/core/manifest/store";
import { reconcilePendingOperations } from "@purix/core/state/reconcile";
import { readFile, writeFile } from "node:fs/promises";

export function registerBackupCommands(program: Command) {
  program
    .command("backup <outFile>")
    .description("Export the manifest + pending operations to a JSON file")
    .action(async (outFile: string) => {
      try {
        const data = exportManifestData();
        await writeFile(outFile, JSON.stringify(data, null, 2), "utf-8");
        console.log(`✅ Backed up ${data.manifest.length} component(s) to ${outFile}.`);
      } catch (err) {
        console.error(`\n🛑 Failed to write backup: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("restore <inFile>")
    .description("Restore the manifest from a backup file — DESTRUCTIVE, replaces current state")
    .action(async (inFile: string) => {
      try {
        const proceed = await confirmGated(`This will WIPE and replace the current manifest with the contents of ${inFile}. Continue?`, "restore", null);
        if (!proceed) return;
        const raw = JSON.parse(await readFile(inFile, "utf-8")) as ManifestBackup;
        importManifestData(raw);
        console.log(`✅ Restored ${raw.manifest.length} component(s) from ${inFile}.`);
      } catch (err) {
        console.error(`\n🛑 Failed to restore backup: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // reconcile (§7.3 safety net, standalone)
  // ---------------------------------------------------------------------------
  program
    .command("reconcile")
    .description("Force a reconciliation pass for crash-interrupted operations")
    .action(async () => {
      try {
        await reconcilePendingOperations();
        console.log("Reconciliation check complete.");
      } catch (err) {
        console.error(`\n🛑 Reconciliation failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}