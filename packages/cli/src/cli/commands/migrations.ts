// src/cli/commands/migrations.ts
import type { Command } from "commander";
import { confirmGated } from "@purix/core/cli-io/gated-confirm";
import { readManifest } from "@purix/core/manifest/store";
import { checkDrift, acceptDrift } from "@purix/core/state/drift";
import { activateMigration, rollbackMigration } from "@purix/core/state/migration";
import { listMigrations } from "@purix/core/manifest/migrations";
import { recordEvent } from "@purix/core/manifest/events";

export function registerMigrationsCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // accept-drift
  // ---------------------------------------------------------------------------
  program
    .command("accept-drift <componentId>")
    .description("Accept current on-disk state as the new baseline")
    .option("-a, --agent <n>", "the agent believed responsible for the out-of-band edit, if known")
    .action(async (componentId: string, opts: { agent?: string }) => {
      try {
        const entry = readManifest(componentId);
        if (!entry) {
          console.error(`No manifest entry for "${componentId}".`);
          process.exitCode = 1;
          return;
        }
        const drift = await checkDrift(entry, process.cwd());
        if (!drift.drifted) {
          console.log(`"${componentId}" hasn't drifted — nothing to accept.`);
          return;
        }
        const proceed = await confirmGated(`Accept current on-disk state of "${componentId}" as the new baseline?`, "accept_drift", componentId);
        if (!proceed) return;
        const result = await acceptDrift(entry, drift.liveFiles, drift.liveHash, process.cwd(), opts.agent ?? null);
        console.log(result.ok ? `✅ Baseline accepted.` : `🛑 ${result.reason}`);
        if (result.ok) {
          recordEvent("reconciliation", { component_id: componentId, detail: { source: "accept_drift" } });
        } else {
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(`\n🛑 Accept-drift failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // migration-activate / migration-rollback / migrations
  // ---------------------------------------------------------------------------
  program
    .command("migration-activate <id>")
    .description("Activate a staged migration (§6.5)")
    .action(async (id: string) => {
      try {
        const proceed = await confirmGated(`Activate migration ${id} and write it to real files?`, "migration_activate", null);
        if (!proceed) return;
        const result = await activateMigration(id, process.cwd());
        console.log(result.ok ? `✅ Activated.` : `🛑 ${result.reason}`);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`\n🛑 Failed to activate migration: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("migration-rollback <id>")
    .description("Roll back a migration to its before-snapshot")
    .action(async (id: string) => {
      try {
        const proceed = await confirmGated(`Roll back migration ${id}?`, "migration_rollback", null);
        if (!proceed) return;
        const result = await rollbackMigration(id, process.cwd());
        console.log(result.ok ? `✅ Rolled back.` : `🛑 ${result.reason}`);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`\n🛑 Failed to rollback migration: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("migrations [componentId]")
    .description("List migration records")
    .action((componentId?: string) => {
      const records = listMigrations(componentId);
      if (records.length === 0) {
        console.log("No migration records.");
        return;
      }
      for (const r of records) {
        console.log(`${r.id}  [${r.status}]  ${r.component_id}  v${r.version_from}->v${r.version_to}  ${r.operation}  ${r.created_at}`);
      }
    });
}