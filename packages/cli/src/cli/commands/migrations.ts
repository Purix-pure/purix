// src/cli/commands/migrations.ts
import type { Command } from "commander";

export function registerMigrationsCommands(program: Command) {
  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): grouped
  // four flat top-level commands (accept-drift, migration-activate,
  // migration-rollback, migrations) into one noun-then-verb group. All four
  // act on the same resource — a component's migration/drift lifecycle —
  // despite "accept-drift" not previously sharing the "migration-" prefix
  // the other two did; grouped as "migration accept-drift" it now reads as
  // part of the same family it always semantically was. See security.ts's
  // matching comment for the standard and why this is safe pre-release.
  const migrationCmd = program.command("migration").description("Inspect and manage component migrations and drift");

  // ---------------------------------------------------------------------------
  // accept-drift
  // ---------------------------------------------------------------------------
  migrationCmd
    .command("accept-drift <componentId>")
    .description("Accept current on-disk state as the new baseline")
    .option("-a, --agent <name>", "the agent believed responsible for the out-of-band edit, if known")
    .action(async (componentId: string, opts: { agent?: string }) => {
      try {
        const { confirmGated } = await import("@purix/core/cli-io/gated-confirm");
        const { readManifest } = await import("@purix/core/manifest/store");
        const { checkDrift, acceptDrift } = await import("@purix/core/state/drift");
        const { recordEvent } = await import("@purix/core/manifest/events");
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
        console.error(`\n🛑 Accept-drift failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ---------------------------------------------------------------------------
  // activate / rollback / list
  // ---------------------------------------------------------------------------
  migrationCmd
    .command("activate <id>")
    .description("Activate a staged migration (§6.5)")
    .action(async (id: string) => {
      try {
        const { confirmGated } = await import("@purix/core/cli-io/gated-confirm");
        const { activateMigration } = await import("@purix/core/state/migration");
        // TEST-REPORT F13: check the id exists before asking a human to approve it (an approval was even
        // being recorded for ids that don't exist).
        const { listMigrations } = await import("@purix/core/manifest/migrations");
        if (!listMigrations().some((r) => r.id === id)) {
          console.error(`🛑 No migration found with id "${id}". Run "purix migration list" to list them.`);
          process.exitCode = 1;
          return;
        }
        const proceed = await confirmGated(`Activate migration ${id} and write it to real files?`, "migration_activate", null);
        if (!proceed) return;
        const result = await activateMigration(id, process.cwd());
        console.log(result.ok ? `✅ Activated.` : `🛑 ${result.reason}`);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`\n🛑 Failed to activate migration: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  migrationCmd
    .command("rollback <id>")
    .description("Roll back a migration to its before-snapshot")
    .action(async (id: string) => {
      try {
        const { confirmGated } = await import("@purix/core/cli-io/gated-confirm");
        const { rollbackMigration } = await import("@purix/core/state/migration");
        const { listMigrations } = await import("@purix/core/manifest/migrations");
        if (!listMigrations().some((r) => r.id === id)) {
          console.error(`🛑 No migration found with id "${id}". Run "purix migration list" to list them.`);
          process.exitCode = 1;
          return;
        }
        const proceed = await confirmGated(`Roll back migration ${id}?`, "migration_rollback", null);
        if (!proceed) return;
        const result = await rollbackMigration(id, process.cwd());
        console.log(result.ok ? `✅ Rolled back.` : `🛑 ${result.reason}`);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(`\n🛑 Failed to rollback migration: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  migrationCmd
    .command("list [componentId]")
    .description("List migration records")
    .action(async (componentId?: string) => {
      const { listMigrations } = await import("@purix/core/manifest/migrations");
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